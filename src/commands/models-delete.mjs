import { existsSync } from "node:fs";
import { lstat, realpath, rm, unlink } from "node:fs/promises";
import { homedir } from "node:os";
import { isAbsolute, join, relative, resolve } from "node:path";
import { resolvedPathAllowMissing } from "../paths.mjs";
import { HF_HUB_DIR } from "../config.mjs";
import { backendFor } from "../backends.mjs";
import { isProfileRunning, stopProfile } from "../process.mjs";
import { removeFromPiConfig } from "../harness-pi.mjs";
import { deleteProfile, effectiveModelId } from "../profiles.mjs";
import { deleteOllamaModel } from "../ollama-runtime.mjs";
import { offerOmlxRestart } from "../omlx-runtime.mjs";
import { findOmlxModelDir } from "../mlx-discovery.mjs";
import { promptConfirm, status, theme } from "../ui.mjs";
import { execFileAsync } from "../exec.mjs";
import { hfRepoFromPath } from "../huggingface.mjs";

const OMLX_MODELS_ROOT = join(homedir(), ".omlx", "models");

export async function modelLocationForItem(item) {
  if (item.type === "profile") {
    const backend = backendFor(item.profile.backend);
    if (backend.type === "managed-server") {
      const modelId = effectiveModelId(item.profile);
      if (backend.id === "ollama") return { kind: "ollama", modelId };
      // Never guess a delete path — discovery failure means we don't know
      // where the model lives; report unknown and let the user delete manually.
      const dir = await findOmlxModelDir(modelId);
      return dir ? { kind: "mlx", dir, modelId } : { kind: "unknown", reason: "oMLX model directory was not discovered" };
    }
    const modelPath = item.profile.modelPath;
    if (!modelPath) return { kind: "unknown" };
    if (modelPath.startsWith(HF_HUB_DIR)) return { kind: "hf-cache", path: modelPath, repoId: hfRepoFromPath(modelPath) };
    return { kind: "file", path: modelPath };
  }
  if (item.type === "new") {
    const modelPath = item.model?.path;
    if (!modelPath) return { kind: "unknown" };
    if (modelPath.startsWith(HF_HUB_DIR)) return { kind: "hf-cache", path: modelPath, repoId: hfRepoFromPath(modelPath) };
    return { kind: "file", path: modelPath };
  }
  if (item.type === "managed") {
    const modelId = item.model?.id;
    if (!modelId) return { kind: "unknown" };
    if (item.backendId === "ollama") return { kind: "ollama", modelId };
    const dir = await findOmlxModelDir(modelId);
    return dir ? { kind: "mlx", dir, modelId } : { kind: "unknown", reason: "oMLX model directory was not discovered" };
  }
  return { kind: "unknown" };
}

export function isStrictDescendantPath(target, root) {
  if (typeof target !== "string" || typeof root !== "string" || !isAbsolute(target) || !isAbsolute(root)) return false;
  const rel = relative(resolve(root), resolve(target)).replace(/\\/gu, "/");
  return Boolean(rel && rel !== "." && rel !== ".." && !rel.startsWith("../"));
}

export function isSafeOmlxModelPath(target, root = OMLX_MODELS_ROOT) {
  return isStrictDescendantPath(target, root);
}

export async function isSafeOmlxDeletionTarget(target, root = OMLX_MODELS_ROOT) {
  if (!isSafeOmlxModelPath(target, root)) return false;
  try {
    const targetStat = await lstat(target);
    if (!targetStat.isDirectory() || targetStat.isSymbolicLink()) return false;
  } catch (error) {
    if (error?.code !== "ENOENT") return false;
  }
  const [canonicalRoot, canonicalTarget] = await Promise.all([
    realpath(root).catch(() => null),
    resolvedPathAllowMissing(target),
  ]);
  return Boolean(canonicalRoot && canonicalTarget && isSafeOmlxModelPath(canonicalTarget, canonicalRoot));
}

export async function deleteModelFromSource(item, confirm = promptConfirm) {
  const loc = await modelLocationForItem(item);
  if (loc.kind === "unknown") {
    console.log(status({ kind: "warning", message: "Could not determine where this model's files are located." }));
    return { confirmed: false, reason: loc.reason ?? "unknown location" };
  }

  const locationLabel = loc.kind === "hf-cache" ? (loc.path ?? loc.repoId)
    : loc.kind === "mlx" ? loc.dir : loc.kind === "ollama" ? loc.modelId : loc.path;
  console.log(status({ kind: "warning", message: "\nThis will permanently delete " + (item.type === "profile" ? "the configuration and the model from:" : "the model from:") }));
  console.log(theme.subtle(`  ${locationLabel}`));
  if (loc.kind === "hf-cache" && loc.repoId) {
    console.log(status({ kind: "warning", message: `Warning: HuggingFace cache deletion is repository-wide. All files in ${loc.repoId} (including other quants, projectors, and drafters) will be removed.` }));
    console.log(theme.subtle("To delete only this file, remove it manually from the cache directory."));
    const confirmed = await confirm({ message: "Delete the entire repository?", initialValue: false });
    if (!confirmed) {
      console.log(theme.subtle("Cancelled."));
      return { confirmed: false, cancelled: true };
    }
  } else {
    const confirmed = await confirm({ message: "Delete this model?", initialValue: false });
    if (!confirmed) {
      console.log(theme.subtle("Cancelled."));
      return { confirmed: false, cancelled: true };
    }
  }

  if (item.type === "profile" && backendFor(item.profile.backend).type === "local-server" && await isProfileRunning(item.profile)) {
    console.log(theme.subtle("Stopping running server..."));
    const stopResult = await stopProfile(item.profile);
    if (!stopResult.stopped && await isProfileRunning(item.profile)) {
      console.log(status({ kind: "warning", message: `Keeping configuration because the server could not be stopped: ${stopResult.message}` }));
      return { confirmed: false, reason: "server is still running" };
    }
  }

  let sourceDeletion = { confirmed: false };
  if (loc.kind === "ollama") {
    try {
      if (await deleteOllamaModel(loc.modelId)) {
        console.log(status({ kind: "success", message: `Deleted ${loc.modelId} from Ollama` }));
        sourceDeletion = { confirmed: true };
      } else {
        console.log(status({ kind: "error", message: `Ollama did not confirm deletion of ${loc.modelId}` }));
        console.log(theme.subtle(`Delete manually: ollama rm ${loc.modelId}`));
      }
    } catch (err) {
      console.log(status({ kind: "error", message: `Failed: ${err.message}` }));
      console.log(theme.subtle(`Delete manually: ollama rm ${loc.modelId}`));
    }
  } else if (loc.kind === "hf-cache" && loc.repoId) {
    const cacheDir = join(HF_HUB_DIR, `models--${loc.repoId.replace(/\//g, "--")}`);
    try {
      const { stdout } = await execFileAsync("hf", ["cache", "rm", `model/${loc.repoId}`, "--yes"], { timeout: 30000 });
      if (stdout.trim()) console.log(theme.subtle(stdout.trim()));
      if (existsSync(cacheDir)) {
        console.log(status({ kind: "error", message: `Model still exists at ${cacheDir}` }));
        console.log(theme.subtle(`Delete manually: hf cache rm model/${loc.repoId}`));
      } else {
        console.log(status({ kind: "success", message: `Deleted ${loc.repoId} from HuggingFace cache` }));
        sourceDeletion = { confirmed: true };
      }
    } catch (err) {
      const detail = err.stderr?.trim() || err.message;
      console.log(status({ kind: "error", message: `Failed: ${detail}` }));
      console.log(theme.subtle(`Delete manually: hf cache rm model/${loc.repoId}`));
    }
  } else if (loc.kind === "mlx") {
    const root = join(homedir(), ".omlx", "models");
    if (!await isSafeOmlxDeletionTarget(loc.dir, root)) {
      console.log(status({ kind: "error", message: "Refusing to delete: path is outside ~/.omlx/models/ or is the models root." }));
      console.log(theme.subtle(`  Target: ${loc.dir}`));
      return { confirmed: false, reason: "unsafe oMLX path" };
    }
    if (!existsSync(loc.dir)) {
      console.log(status({ kind: "warning", message: `Directory not found: ${loc.dir}` }));
      sourceDeletion = { confirmed: true, alreadyAbsent: true };
    } else {
      try {
        await rm(loc.dir, { recursive: true, force: true });
      } catch (err) {
        console.log(status({ kind: "error", message: `Failed: ${err.message}` }));
        console.log(theme.subtle(`Delete manually: rm -rf ${loc.dir}`));
        return { confirmed: false, reason: err.message };
      }
      if (existsSync(loc.dir)) {
        console.log(status({ kind: "error", message: `Directory still exists: ${loc.dir}` }));
        console.log(theme.subtle(`Delete manually: rm -rf ${loc.dir}`));
      } else {
        console.log(status({ kind: "success", message: `Deleted ${loc.dir}` }));
        sourceDeletion = { confirmed: true };
        await offerOmlxRestart("to update its model list");
      }
    }
  } else if (loc.kind === "file") {
    if (!existsSync(loc.path)) {
      console.log(status({ kind: "warning", message: `File not found: ${loc.path}` }));
      sourceDeletion = { confirmed: true, alreadyAbsent: true };
    } else {
      try {
        await unlink(loc.path);
      } catch (err) {
        console.log(status({ kind: "error", message: `Failed: ${err.message}` }));
        console.log(theme.subtle(`Delete manually: rm ${loc.path}`));
        return { confirmed: false, reason: err.message };
      }
      if (existsSync(loc.path)) {
        console.log(status({ kind: "error", message: `File still exists: ${loc.path}` }));
        console.log(theme.subtle(`Delete manually: rm ${loc.path}`));
      } else {
        console.log(status({ kind: "success", message: `Deleted ${loc.path}` }));
        sourceDeletion = { confirmed: true };
      }
    }
  }

  if (!sourceDeletion.confirmed) {
    console.log(status({ kind: "warning", message: "Keeping configuration because source deletion was not confirmed." }));
    return sourceDeletion;
  }
  if (item.type === "profile") {
    await removeFromPiConfig(item.profile);
    await deleteProfile(item.profile.id);
    console.log(theme.subtle(`Removed configuration: ${item.profile.id}`));
  }
  return sourceDeletion;
}

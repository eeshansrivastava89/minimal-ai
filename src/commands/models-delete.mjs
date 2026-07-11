import { existsSync } from "node:fs";
import { rm, unlink } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { HF_HUB_DIR } from "../config.mjs";
import { backendFor } from "../backends.mjs";
import { isProfileRunning, stopProfile } from "../process.mjs";
import { removeFromPiConfig } from "../harness-pi.mjs";
import { deleteProfile } from "../profiles.mjs";
import { deleteOllamaModel } from "../ollama-runtime.mjs";
import { offerOmlxRestart } from "../omlx-runtime.mjs";
import { findOmlxModelDir } from "../mlx-discovery.mjs";
import { pc } from "../ui.mjs";
import { execFileAsync } from "../exec.mjs";
import { hfRepoFromPath } from "../huggingface.mjs";

/** Determine where a model's files live on disk. */
export async function modelLocationForItem(item) {
  if (item.type === "profile") {
    const backend = backendFor(item.profile.backend);
    if (backend.type === "managed-server") {
      const modelId = item.profile.omlxModel || item.profile.ollamaModel || item.profile.modelAlias || item.profile.id;
      if (backend.id === "ollama") {
        return { kind: "ollama", modelId };
      }
      // oMLX model IDs may not include the org prefix, so search recursively
      const dir = await findOmlxModelDir(modelId);
      return { kind: "mlx", dir: dir ?? join(homedir(), ".omlx", "models", ...modelId.replace(/--/g, "/").split("/").filter(Boolean)), modelId };
    }
    const modelPath = item.profile.modelPath;
    if (!modelPath) return { kind: "unknown" };
    if (modelPath.startsWith(HF_HUB_DIR)) {
      return { kind: "hf-cache", path: modelPath, repoId: hfRepoFromPath(modelPath) };
    }
    return { kind: "file", path: modelPath };
  }
  if (item.type === "new") {
    const modelPath = item.model?.path;
    if (!modelPath) return { kind: "unknown" };
    if (modelPath.startsWith(HF_HUB_DIR)) {
      return { kind: "hf-cache", path: modelPath, repoId: hfRepoFromPath(modelPath) };
    }
    return { kind: "file", path: modelPath };
  }
  if (item.type === "managed") {
    const modelId = item.model?.id;
    if (!modelId) return { kind: "unknown" };
    if (item.backendId === "ollama") {
      return { kind: "ollama", modelId };
    }
    // oMLX model IDs may not include the org prefix, so search recursively
    const dir = await findOmlxModelDir(modelId);
    return { kind: "mlx", dir: dir ?? join(homedir(), ".omlx", "models", ...modelId.replace(/--/g, "/").split("/").filter(Boolean)), modelId };
  }
  return { kind: "unknown" };
}

export async function deleteModelFromSource(prompt, item) {
  const loc = await modelLocationForItem(item);

  if (loc.kind === "unknown") {
    console.log(pc.yellow("Could not determine where this model's files are located."));
    return;
  }

  // Show what will be deleted
  let locationLabel;
  if (loc.kind === "hf-cache") {
    locationLabel = loc.path ?? loc.repoId;
  } else if (loc.kind === "mlx") {
    locationLabel = loc.dir;
  } else if (loc.kind === "ollama") {
    locationLabel = loc.modelId;
  } else if (loc.kind === "file") {
    locationLabel = loc.path;
  }

  console.log(pc.yellow("\nThis will permanently delete " + (item.type === "profile" ? "the configuration and the model from:" : "the model from:")));
  console.log(pc.dim(`  ${locationLabel}`));

  const confirmed = await prompt.yesNo("Delete this model?", false);
  if (!confirmed) {
    console.log(pc.dim("Cancelled."));
    return;
  }

  // Stop running server if needed
  if (item.type === "profile" && await isProfileRunning(item.profile)) {
    console.log(pc.dim("Stopping running server..."));
    await stopProfile(item.profile);
  }

  // Delete files
  if (loc.kind === "ollama") {
    try {
      const ok = await deleteOllamaModel(loc.modelId);
      if (ok) {
        console.log(pc.green(`✓ Deleted ${loc.modelId} from Ollama`));
      } else {
        console.log(pc.red(`✗ Ollama did not confirm deletion of ${loc.modelId}`));
        console.log(pc.dim(`Delete manually: ollama rm ${loc.modelId}`));
      }
    } catch (err) {
      console.log(pc.red(`✗ Failed: ${err.message}`));
      console.log(pc.dim(`Delete manually: ollama rm ${loc.modelId}`));
    }
  } else if (loc.kind === "hf-cache" && loc.repoId) {
    const cacheDir = join(HF_HUB_DIR, `models--${loc.repoId.replace(/\//g, "--")}`);
    try {
      const { stdout } = await execFileAsync("hf", ["cache", "rm", `model/${loc.repoId}`, "--yes"], { timeout: 30000 });
      if (stdout.trim()) console.log(pc.dim(stdout.trim()));
      // Verify the directory is actually gone
      if (existsSync(cacheDir)) {
        console.log(pc.red(`✗ Model still exists at ${cacheDir}`));
        console.log(pc.dim(`Delete manually: hf cache rm model/${loc.repoId}`));
      } else {
        console.log(pc.green(`✓ Deleted ${loc.repoId} from HuggingFace cache`));
      }
    } catch (err) {
      const detail = err.stderr?.trim() || err.message;
      console.log(pc.red(`✗ Failed: ${detail}`));
      console.log(pc.dim(`Delete manually: hf cache rm model/${loc.repoId}`));
    }
  } else if (loc.kind === "mlx") {
    const omlxModelsRoot = join(homedir(), ".omlx", "models");
    // Safety guard: never delete outside ~/.omlx/models/
    if (!loc.dir.startsWith(omlxModelsRoot + "/") && loc.dir !== omlxModelsRoot) {
      console.log(pc.red(`✗ Refusing to delete: path is outside ~/.omlx/models/`));
      console.log(pc.dim(`  Target: ${loc.dir}`));
      console.log(pc.dim(`Delete manually if needed: rm -rf ${loc.dir}`));
      return;
    }
    if (!existsSync(loc.dir)) {
      console.log(pc.yellow(`Directory not found: ${loc.dir}`));
      console.log(pc.dim("Model files may have already been removed, or oMLX loaded them from a different location."));
    } else {
      try {
        await rm(loc.dir, { recursive: true, force: true });
      } catch (err) {
        console.log(pc.red(`✗ Failed: ${err.message}`));
        console.log(pc.dim(`Delete manually: rm -rf ${loc.dir}`));
        return;
      }
      // Verify deletion
      if (existsSync(loc.dir)) {
        console.log(pc.red(`✗ Directory still exists: ${loc.dir}`));
        console.log(pc.dim(`Delete manually: rm -rf ${loc.dir}`));
      } else {
        console.log(pc.green(`✓ Deleted ${loc.dir}`));
        await offerOmlxRestart(prompt, "to update its model list");
      }
    }
  } else if (loc.kind === "file") {
    if (!existsSync(loc.path)) {
      console.log(pc.yellow(`File not found: ${loc.path}`));
      console.log(pc.dim("Model file may have already been removed."));
    } else {
      try {
        await unlink(loc.path);
      } catch (err) {
        console.log(pc.red(`✗ Failed: ${err.message}`));
        console.log(pc.dim(`Delete manually: rm ${loc.path}`));
        return;
      }
      // Verify deletion
      if (existsSync(loc.path)) {
        console.log(pc.red(`✗ File still exists: ${loc.path}`));
        console.log(pc.dim(`Delete manually: rm ${loc.path}`));
      } else {
        console.log(pc.green(`✓ Deleted ${loc.path}`));
      }
    }
  }

  // Remove profile configuration if one exists
  if (item.type === "profile") {
    await removeFromPiConfig(item.profile);
    await deleteProfile(item.profile.id);
    console.log(pc.dim(`Removed configuration: ${item.profile.id}`));
  }
}
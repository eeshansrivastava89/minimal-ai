// HuggingFace model download helpers.
// Uses the `hf` CLI (from huggingface_hub) for actual downloads.
// The interactive model/quant selection happens in download.mjs; here we
// just hand off to the CLI and let it handle progress bars, resumption, etc.

import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { HF_HUB_DIR, hasHomebrew } from "./config.mjs";
import { execFileAsync, execCommand, commandExists } from "./exec.mjs";
import { status, theme } from "./ui.mjs";

/** Extract HuggingFace repo ID from a cache path (e.g. .../models--Qwen--Qwen3-8B/... → Qwen/Qwen3-8B). */
export function hfRepoFromPath(path) {
  const hubPart = path.slice(HF_HUB_DIR.length);
  const match = hubPart.match(/models--(.+?)(?=\/|$)/);
  if (!match) return null;
  return match[1].replace(/--/g, "/");
}

/** Check whether the `hf` CLI is available. */
export async function hasHfCli() {
  try {
    const { stdout } = await execFileAsync("hf", ["--version"]);
    return Boolean(stdout.trim());
  } catch {
    return false;
  }
}

// ── Input validation: HF repo IDs and tree-entry paths are untrusted ──────
// HF tree API JSON and user-typed repo IDs flow into `hf download` CLI
// args and API URLs. Without validation a malicious repo (or a typo like
// `--foo/bar`) can inject CLI flags or path-traversal segments. These
// guards are the single chokepoint (H1/M2/M1 from the security audit).
const REPO_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]*\/[A-Za-z0-9][A-Za-z0-9._-]*$/;

/** True for a well-formed HF repo ID (`org/name`, two parts, safe chars). */
export function isValidRepoId(repo) {
  return typeof repo === "string" && REPO_ID_RE.test(repo);
}

/** Throw a clear error on a malformed repo ID — before it reaches `hf`
 *  args or an API URL. */
export function assertValidRepoId(repo) {
  if (!isValidRepoId(repo)) {
    throw new Error(`Invalid HuggingFace repo ID: "${repo}". Expected org/name (e.g. unsloth/Qwen3-8B-GGUF).`);
  }
  return repo;
}

/** True for a tree-entry path that is safe to pass to `hf download` and use
 *  in URLs: a non-empty relative path with no `..` traversal, no leading
 *  dash (flag-injection guard for `hf` CLI args), no absolute paths, no
 *  backslashes. HF paths use `/` and never start with `-`. */
export function isSafeRelativePath(p) {
  return typeof p === "string"
    && p.length > 0
    && !p.startsWith("-")
    && !p.startsWith("/")
    && !p.includes("\\")
    && !p.includes("..");
}

/** Size from a tree entry, coerced to a finite non-negative number (0 when
 *  absent or malformed). Guards against fabricated/non-numeric sizes from
 *  untrusted API JSON. */
function finiteTreeSize(f) {
  const s = f?.lfs?.size ?? f?.size;
  return Number.isFinite(s) && s >= 0 ? s : 0;
}

/** Final-boundary guard before filenames reach `spawn("hf", ...)`. The tree
 *  guards already reject these, but downloadModel is a public export — a
 *  caller could pass unvalidated filenames. Rejects anything that could be
 *  interpreted as a flag (leading `-`) or escape the download dir (`..`,
 *  absolute paths, backslashes). (H1) */
export function assertSafeHfFilename(name) {
  if (!isSafeRelativePath(name)) {
    throw new Error(`Refusing to download unsafe filename: "${name}". Must not start with '-', contain '..', be absolute, or use backslashes.`);
  }
  return name;
}

/** Parse a HuggingFace reference (URL, repo/filename, or repo ID). */
export function parseHfRef(input) {
  const trimmed = input.trim();

  if (trimmed.startsWith("https://huggingface.co/")) {
    const url = new URL(trimmed);
    const pathParts = url.pathname.split("/").filter(Boolean);
    const resolveIdx = pathParts.indexOf("resolve");
    if (resolveIdx > 0 && pathParts[resolveIdx + 1] === "main") {
      const repo = pathParts.slice(0, resolveIdx).join("/");
      assertValidRepoId(repo);
      return { repo, filename: pathParts.slice(resolveIdx + 2).join("/") };
    }
    if (pathParts.length >= 2) {
      const repo = pathParts.slice(0, 2).join("/");
      assertValidRepoId(repo);
      return { repo, filename: pathParts.length > 2 ? pathParts.slice(2).join("/") : undefined };
    }
    throw new Error(`Invalid HuggingFace URL: ${input}`);
  }

  const parts = trimmed.split("/").filter(Boolean);
  if (parts.length < 2) {
    throw new Error(`Invalid HuggingFace reference: "${input}". Expected at least org/name.`);
  }
  const repo = parts.slice(0, 2).join("/");
  assertValidRepoId(repo);
  return {
    repo,
    filename: parts.length > 2 ? parts.slice(2).join("/") : undefined,
  };
}

/** True when a tree entry is a file entry. Untrusted API JSON — guard every field. */
function isTreeFile(entry) {
  return entry?.type === "file" && typeof entry?.path === "string";
}

/** GGUF file entries that are safe to pass to `hf download` and use in URLs. */
function isSafeGgufFile(entry) {
  return isTreeFile(entry) && entry.path.endsWith(".gguf") && isSafeRelativePath(entry.path);
}

/** Full download metadata for a tree entry. */
function fileMeta(repo) {
  return (f) => ({
    repo,
    filename: f.path,
    url: `https://huggingface.co/${repo}/resolve/main/${f.path}`,
    sizeBytes: finiteTreeSize(f),
    sha256: typeof f.lfs?.oid === "string" ? f.lfs.oid : "",
    relativePath: f.path,
  });
}

const bySizeAsc = (a, b) => a.sizeBytes - b.sizeBytes;

/** Shared shape behind the tree-query helpers (A9): validate the repo,
 *  resolve (or reuse) the tree, then filter → map → sort. The public
 *  wrappers below differ only in their predicate/select/sort. */
async function queryTree(repo, { fetchImpl = globalThis.fetch, tree, where, select, sort } = {}) {
  assertValidRepoId(repo);
  const resolvedTree = tree ?? await getHfTree(repo, { fetchImpl });
  const rows = resolvedTree.filter(where).map(select);
  if (sort) rows.sort(sort);
  return rows;
}

/** Resolve file metadata for a GGUF file from the HF tree API. */
async function resolveGgufFile(ref, { fetchImpl = globalThis.fetch, tree } = {}) {
  const { repo, filename } = parseHfRef(ref);
  if (!isSafeRelativePath(filename)) {
    throw new Error(`Unsafe filename in reference: "${filename}".`);
  }
  const found = await queryTree(repo, {
    fetchImpl, tree,
    where: (f) => isTreeFile(f) && f.path === filename,
    select: fileMeta(repo),
  });
  if (found.length === 0) throw new Error(`File '${filename}' not found in HuggingFace repo '${repo}'.`);
  return found[0];
}

/** Resolve all model files in an MLX repo from the HF tree API. */
async function resolveMlxRepo(repo, { fetchImpl = globalThis.fetch, tree } = {}) {
  return await queryTree(repo, {
    fetchImpl, tree,
    where: (f) => isTreeFile(f) && isSafeRelativePath(f.path) && !f.path.startsWith(".") && f.path !== ".gitattributes" && f.path !== "README.md",
    select: fileMeta(repo),
  });
}

export async function getHfTree(repo, { branch = "main", fetchImpl = globalThis.fetch } = {}) {
  assertValidRepoId(repo);
  const url = `https://huggingface.co/api/models/${repo}/tree/${branch}?recursive=true`;
  const response = await fetchImpl(url, { signal: AbortSignal.timeout(10000) });
  if (!response.ok) throw new Error(`HuggingFace API error: HTTP ${response.status} for ${repo}`);
  return await response.json();
}

/** List all GGUF files in a HuggingFace repo with their sizes (excludes MTP drafters and vision projectors).
 * @param {{ fetchImpl?: typeof globalThis.fetch, tree?: any }} [opts] */
export async function listGgufFiles(repo, opts) {
  const { fetchImpl = globalThis.fetch, tree } = opts ?? {};
  return await queryTree(repo, {
    fetchImpl, tree,
    where: (f) => isSafeGgufFile(f) && !isDrafterFile(f.path) && !isMmprojFile(f.path),
    select: (f) => ({ path: f.path, sizeBytes: finiteTreeSize(f) }),
    sort: bySizeAsc,
  });
}

/** Check if a GGUF file is an MTP drafter based on its path/name. */
function isDrafterFile(path) {
  // In an MTP/ subdirectory: MTP/gemma-4-E2B-it-Q8_0-MTP.gguf
  if (path.includes("/MTP/") || path.includes("/mtp/")) return true;
  const name = path.split("/").pop() ?? path;
  // Starts with mtp- or mtp_: mtp-ornith-9b-mtp-kl-Q8_0.gguf
  if (/^mtp[-_]/i.test(name)) return true;
  // Contains -MTP. or -mtp. before extension: gemma-4-E2B-it-Q8_0-MTP.gguf
  if (/-mtp\./i.test(name)) return true;
  return false;
}

/** Check if a GGUF file is a vision projector (mmproj) based on its name. */
function isMmprojFile(path) {
  const name = path.split("/").pop() ?? path;
  return /mmproj/i.test(name);
}

/** List all mmproj (vision projector) GGUF files in a HuggingFace repo.
 * @param {{ fetchImpl?: typeof globalThis.fetch, tree?: any }} [opts] */
export async function listMmprojFiles(repo, opts) {
  const { fetchImpl = globalThis.fetch, tree } = opts ?? {};
  return await queryTree(repo, {
    fetchImpl, tree,
    where: (f) => isSafeGgufFile(f) && isMmprojFile(f.path),
    select: (f) => ({ path: f.path, sizeBytes: finiteTreeSize(f) }),
  });
}

/** List all MTP drafter GGUF files in a HuggingFace repo (by filename
 *  heuristic — the same isDrafterFile rule listGgufFiles uses to exclude
 *  them, so the two lists are complementary). Used to offer a drafter
 *  download alongside the main model (#2). */
export async function listDrafterFiles(repo, opts) {
  const { fetchImpl = globalThis.fetch, tree } = opts ?? {};
  return await queryTree(repo, {
    fetchImpl, tree,
    where: (f) => isSafeGgufFile(f) && isDrafterFile(f.path),
    select: (f) => ({ path: f.path, sizeBytes: finiteTreeSize(f) }),
    sort: bySizeAsc,
  });
}

/** Fetch model metadata from the HF API. */
export async function getHfModelInfo(repo, { fetchImpl = globalThis.fetch } = {}) {
  assertValidRepoId(repo);
  const url = `https://huggingface.co/api/models/${repo}`;
  const response = await fetchImpl(url, { signal: AbortSignal.timeout(10000) });
  if (!response.ok) throw new Error(`HuggingFace API error: HTTP ${response.status} for ${repo}`);
  return await response.json();
}

/** Check if a repo is MLX-formatted based on its HF metadata. */
export function isMlxRepo(modelInfo) {
  if (!modelInfo || typeof modelInfo !== "object") return false;
  if (modelInfo.library_name === "mlx") return true;
  if (Array.isArray(modelInfo.tags) && modelInfo.tags.includes("mlx")) return true;
  return false;
}

// ── generation_config.json: the lab's recommended sampling params ────────
// HF repos ship the model card's recommended sampler settings here. Using
// them as setup defaults (instead of our hardcoded 0.6 / 0.95) avoids the
// "my Qwen loops inside its THINK output" class of bugs that come from
// fighting the model with wrong temperature/top-p (#17).

/** Fetch a repo's generation_config.json. Returns null when absent or
 *  unreadable (best-effort — callers swallow errors). */
export async function getHfGenerationConfig(repo, { fetchImpl = globalThis.fetch } = {}) {
  assertValidRepoId(repo);
  const url = `https://huggingface.co/${repo}/resolve/main/generation_config.json`;
  let response;
  try {
    response = await fetchImpl(url, { signal: AbortSignal.timeout(10000) });
  } catch {
    return null;
  }
  if (!response.ok) return null;
  try {
    return await response.json();
  } catch {
    return null;
  }
}

/** Pull the sampler fields minimal-ai prompts for out of a
 *  generation_config.json blob. Returns only fields that are present and
 *  finite; absent fields are simply omitted (caller falls back to
 *  hardcoded defaults). Maps HF field names to our flag names. */
export function extractRecommendedSamplers(config) {
  if (!config || typeof config !== "object") return null;
  const pick = (hfKey, flagKey) => {
    const v = config[hfKey];
    return Number.isFinite(v) ? [flagKey, v] : null;
  };
  const entries = [
    pick("temperature", "temperature"),
    pick("top_p", "topP"),
    pick("top_k", "topK"),
    pick("repetition_penalty", "repeatPenalty"),
    pick("presence_penalty", "presencePenalty"),
    pick("min_p", "minP"),
  ].filter(Boolean);
  if (entries.length === 0) return null;
  return Object.fromEntries(entries);
}

/** Resolve a user-provided HF reference into a download plan. */
export async function resolveHfDownload(input, opts) {
  const { fetchImpl = globalThis.fetch, tree } = opts ?? {};
  const { repo, filename } = parseHfRef(input);
  const resolvedTree = tree ?? await getHfTree(repo, { fetchImpl });

  if (filename && filename.endsWith(".gguf")) {
    const file = await resolveGgufFile(`${repo}/${filename}`, { fetchImpl, tree: resolvedTree });
    return {
      id: repo.split("/").pop() ?? repo,
      repo,
      format: "gguf",
      files: [file],
      totalSizeBytes: file.sizeBytes,
    };
  }

  const ggufFiles = resolvedTree.filter((f) => f.type === "file" && f.path.endsWith(".gguf"));
  if (ggufFiles.length > 0) {
    const file = ggufFiles[0];
    const resolved = await resolveGgufFile(`${repo}/${file.path}`, { fetchImpl, tree: resolvedTree });
    return {
      id: repo.split("/").pop() ?? repo,
      repo,
      format: "gguf",
      files: [resolved],
      totalSizeBytes: resolved.sizeBytes,
    };
  }

  const files = await resolveMlxRepo(repo, { fetchImpl, tree: resolvedTree });
  return {
    id: repo.split("/").pop() ?? repo,
    repo,
    format: "mlx",
    files,
    totalSizeBytes: files.reduce((sum, f) => sum + f.sizeBytes, 0),
  };
}

/**
 * Download a resolved model using the `hf` CLI.
 * GGUF: downloads single file to HF cache (minimal-ai scanner finds it there).
 * MLX: downloads full repo to a local directory (oMLX scans ~/.omlx/models).
 * Progress bars are handled natively by the CLI (stdio inherited).
 * @param {object} model - from resolveHfDownload
 * @param {object} [options]
 * @param {string} [options.localDir] - for MLX: target directory
 * @param {string[]} [options.extraFiles] - additional files to download (e.g. mmproj)
 * @returns {Promise<{ localDir: string, format: string }>}
 */
export async function downloadModel(model, options = {}) {
  const args = ["download", model.repo];
  let localDir;

  if (model.format === "gguf") {
    // Single file to HF cache — scanner finds it there
    await mkdir(HF_HUB_DIR, { recursive: true });
    assertSafeHfFilename(model.files[0].filename);
    for (const file of options.extraFiles ?? []) assertSafeHfFilename(file);
    args.push(model.files[0].filename, "--cache-dir", HF_HUB_DIR);
    // Include additional files (e.g. vision projector) in the same download
    for (const file of options.extraFiles ?? []) {
      args.push(file);
    }
    localDir = HF_HUB_DIR;
  } else if (options.localDir) {
    // Full repo to a flat local directory (oMLX)
    await mkdir(options.localDir, { recursive: true });
    args.push(
      "--local-dir", options.localDir,
      "--exclude", "*.md",
      "--exclude", ".gitattributes",
      "--exclude", "LICENSE",
      "--exclude", ".gitignore",
    );
    localDir = options.localDir;
  } else {
    // Fallback: full repo to HF cache
    await mkdir(HF_HUB_DIR, { recursive: true });
    args.push("--cache-dir", HF_HUB_DIR);
    localDir = HF_HUB_DIR;
  }

  const exitCode = await new Promise((resolve, reject) => {
    const child = spawn("hf", args, { stdio: "inherit", env: process.env });
    child.on("error", reject);
    child.on("exit", resolve);

    // Forward Ctrl+C (SIGINT) to hf. The hf CLI catches SIGINT and may not
    // exit on its own — escalate to SIGKILL after 2 seconds so the user
    // can always cancel a download. No process.exit — let the download
    // fail gracefully so minimal-ai exits via normal error handling.
    const onSigInt = () => {
      child.kill("SIGINT");
      const killTimer = setTimeout(() => {
        try { child.kill("SIGKILL"); } catch { /* already exited */ }
      }, 2000);
      child.on("exit", () => clearTimeout(killTimer));
    };
    process.once("SIGINT", onSigInt);
    child.on("exit", () => process.removeListener("SIGINT", onSigInt));
  });

  if (exitCode !== 0) {
    throw new Error(`hf download exited with code ${exitCode}`);
  }

  return { localDir, format: model.format };
}

/**
 * Install the HuggingFace CLI. Tries, in order:
 *   1. Standalone installer (`curl -LsSf https://hf.co/cli/install.sh | bash`)
 *      HF's recommended method, no Python or Homebrew needed
 *   2. Homebrew (`brew install hf`) — handles Python dependency automatically
 *   3. pip3 / python3 -m pip — traditional fallback if Python is available
 * @returns {Promise<boolean>} true if hf CLI is available after install
 */
export async function installHfCli() {
  console.log(status({ kind: "info", message: "Installing HuggingFace CLI..." }));

  // 1. Standalone installer (HF recommended — zero dependencies)
  try {
    await execCommand("/bin/bash", ["-c", "curl -LsSf https://hf.co/cli/install.sh | bash"], { label: "hf standalone", verbose: true, timeout: 300000 });
    // The installer puts hf in ~/.local/bin — add to PATH for this process
    const localBin = join(homedir(), ".local", "bin");
    if (existsSync(localBin) && !process.env.PATH.includes(localBin)) {
      process.env.PATH = `${localBin}:${process.env.PATH}`;
    }
    if (await hasHfCli()) {
      console.log(status({ kind: "success", message: "HuggingFace CLI installed via standalone installer." }));
      return true;
    }
  } catch { /* fall through to Homebrew */ }

  // 2. Homebrew (macOS / Linuxbrew)
  if (await hasHomebrew()) {
    try {
      await execCommand("brew", ["install", "hf"], { label: "hf", verbose: true });
      if (await hasHfCli()) {
        console.log(status({ kind: "success", message: "HuggingFace CLI installed via Homebrew." }));
        return true;
      }
    } catch { /* fall through to pip */ }
  }

  // 3. pip3 / python3 -m pip (requires Python)
  try {
    if (await commandExists("pip3")) {
      await execCommand("pip3", ["install", "huggingface_hub"], { label: "huggingface_hub", verbose: true });
    } else if (await commandExists("python3")) {
      await execCommand("python3", ["-m", "pip", "install", "huggingface_hub"], { label: "huggingface_hub", verbose: true });
    } else {
      console.log(status({ kind: "error", message: "Could not install HuggingFace CLI — no Homebrew, standalone installer, or Python found." }));
      console.log(theme.subtle("Install manually: brew install hf  — or  curl -LsSf https://hf.co/cli/install.sh | bash"));
      return false;
    }
  } catch (err) {
    console.log(status({ kind: "error", message: `Installation failed: ${err.message}` }));
    console.log(theme.subtle("Install manually: brew install hf  — or  curl -LsSf https://hf.co/cli/install.sh | bash"));
    return false;
  }

  // Verify it's now available
  if (!(await hasHfCli())) {
    console.log(status({ kind: "warning", message: "HuggingFace CLI was installed but not found on PATH." }));
    console.log(theme.subtle("Restart your terminal and run minimal-ai again."));
    return false;
  }
  console.log(status({ kind: "success", message: "HuggingFace CLI installed." }));
  return true;
}

import { statSync } from "node:fs";
import { readdir, realpath, stat } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { getModelScanDirs } from "./config.mjs";
import { readGgufMetadataSafe, resolveQuant } from "./gguf.mjs";
import { parseModelName } from "./model-name.mjs";
import { inferSourceLabel, MIN_MODEL_SIZE_BYTES, EMBEDDING_MODEL_TYPES } from "./discovery-shared.mjs";

// ── Scan for GGUF models and MTP drafters ────────────────────────────────

export async function scanGgufModels(dirs) {
  const scanDirs = dirs ?? await getModelScanDirs();
  const allModels = [];
  const allDrafters = [];

  for (const root of scanDirs) {
    const sourceLabel = inferSourceLabel(root);
    const { models, drafters } = await scanOneDir(root, sourceLabel);
    allModels.push(...models);
    allDrafters.push(...drafters);
  }

  // Deduplicate by path
  const seen = new Set();
  const models = allModels.filter((m) => {
    if (seen.has(m.path)) return false;
    seen.add(m.path);
    return true;
  }).sort((a, b) => a.label.localeCompare(b.label));

  const drafterSeen = new Set();
  const drafters = allDrafters.filter((d) => {
    if (drafterSeen.has(d.path)) return false;
    drafterSeen.add(d.path);
    return true;
  }).sort((a, b) => a.label.localeCompare(b.label));

  return { models, drafters };
}

async function scanOneDir(root, sourceLabel = "local-gguf") {
  const files = await findFiles(root, (path) => path.toLowerCase().endsWith(".gguf"));
  const mmprojs = files.filter((path) => basename(path).toLowerCase().includes("mmproj"));
  const candidates = files.filter((path) => !basename(path).toLowerCase().includes("mmproj"));

  const models = [];
  const drafters = [];

  for (const path of candidates) {
    const dir = dirname(path);
    const mmprojPath = mmprojs.find((candidate) => dirname(candidate) === dir) ?? null;
    const name = basename(path).replace(/\.gguf$/i, "");
    let sizeBytes;
    try { sizeBytes = statSync(path).size; } catch { continue; }
    if (sizeBytes < MIN_MODEL_SIZE_BYTES) continue;
    // Read GGUF metadata to detect drafter architecture and embeddings
    const meta = readGgufMetadataSafe(path);
    const architecture = typeof meta["general.architecture"] === "string" ? meta["general.architecture"] : null;
    const contextLength = architecture && typeof meta[`${architecture}.context_length`] === "number"
      ? meta[`${architecture}.context_length`]
      : null;

    // Extract publisher from GGUF metadata (repo_url or quantized_by),
    // falling back to directory structure (LM Studio: publisher/model-dir/file).
    const publisher = publisherFromGgufMeta(meta) ?? publisherFromPath(path, root, sourceLabel);

    const parsed = parseModelName(publisher ? `${publisher}/${name}` : name, sourceLabel);

    if (isEmbeddingArchitecture(architecture, name)) continue;

    const quant = resolveQuant(meta, name);

    if (architecture === "gemma4-assistant" || architecture === "gemma4_assistant") {
      // This is an MTP drafter model, not a main model
      drafters.push({
        path,
        label: parsed.display,
        aliasSuggestion: parsed.id,
        quant,
        sizeBytes,
        architecture,
        targetHint: drafterTargetHint(name),
        backend: "llama-cpp",
        source: sourceLabel,
      });
    } else {
      models.push({
        path,
        mmprojPath,
        label: parsed.display,
        aliasSuggestion: parsed.id,
        quant,
        sizeBytes,
        contextLength,
        backend: "llama-cpp",
        source: sourceLabel,
      });
    }
  }

  return { models, drafters };
}

// ── Embedding model filtering ─────────────────────────────────────────────

const EMBEDDING_FILENAME_PATTERNS = [
  /(?:^|[-_])bge[-_]/i,
  /(?:^|[-_])jina[-_]/i,
  /(?:^|[-_])e5[-_]/i,
  /(?:^|[-_])gte[-_]/i,
  /(?:^|[-_])all[-_]minilm/i,
  /(?:^|[-_])mpnet/i,
  /(?:^|[-_])nomic[-_]embed/i,
  /(?:^|[-_])embed/i,
  /(?:^|[-_])rerank/i,
];

export function isEmbeddingArchitecture(architecture, filename = "") {
  if (architecture && EMBEDDING_MODEL_TYPES.has(architecture.toLowerCase())) return true;
  const lowerName = filename.toLowerCase();
  return EMBEDDING_FILENAME_PATTERNS.some((pattern) => pattern.test(lowerName));
}

// ── Match drafters to target models ────────────────────────────────────

// Map a drafter filename to a regex that matches its target model filenames.
// e.g. "mtp-gemma-4-31B-it" matches "gemma-4-31B-it*"
//      "gemma-4-31B-it-assistant-Q8_0" matches "gemma-4-31B-it*"
//      "gemma-4-12b-it-MTP-Q8_0" matches "gemma-4-12b-it*"
function drafterTargetHint(name) {
  const lower = String(name).toLowerCase().replace(/\.gguf$/i, "");
  // Strip quant tokens anywhere in the name (not just as a suffix), so a
  // drafter like "gemma-4-E2B-it-Q8_0-MTP" — where the quant sits before the
  // -MTP marker — strips to the same base as its main model
  // "gemma-4-E2B-it-Q8_0". Suffix-only stripping left "...-q8_0" behind and
  // the drafter never matched (#2).
  let base = lower
    .replace(/[-_]ud-[a-z0-9_]+/gi, "")
    .replace(/[-_](?:bf|f)\d{2}\b/gi, "")
    .replace(/[-_]q\d_k_[a-z]+/gi, "")
    .replace(/[-_]q\d_[01]\b/gi, "");
  // Now strip MTP/assistant/draft prefixes and suffixes to get the base model.
  base = base
    .replace(/^mtp[-_]/i, "")
    .replace(/[-_]mtp$/i, "")
    .replace(/[-_]assistant([-_].*)?$/i, "")
    .replace(/[-_]draft([-_].*)?$/i, "");
  // Collapse artifacts left by mid-string quant stripping (double dashes,
  // trailing separators).
  base = base.replace(/[-_]{2,}/g, "-").replace(/^[-_]+|[-_]+$/g, "");
  return base;
}

export { drafterTargetHint };

// Find a drafter that matches a given target model path/name.
// Returns the drafter object or null.
export function matchDrafter(targetPath, drafters) {
  if (!drafters || drafters.length === 0) return null;
  const targetName = basename(targetPath).replace(/\.gguf$/i, "").toLowerCase();
  // Remove quant suffix from target for matching
  const targetBase = targetName
    .replace(/[-_]q\d_k_[a-z]+$/i, "")
    .replace(/[-_]q\d_[01]$/i, "")
    .replace(/[-_]ud-[a-z0-9_]+$/i, "");

  for (const drafter of drafters) {
    const hint = drafter.targetHint;
    if (targetBase.startsWith(hint) || targetBase === hint) {
      return drafter;
    }
  }
  return null;
}

// ── Helpers ─────────────────────────────────────────────────────────────

async function findFiles(root, predicate) {
  const result = [];
  const visitedDirectories = new Set();
  const canonicalRoot = await realpath(root).catch(() => null);
  if (!canonicalRoot) return result;
  const isInsideRoot = (candidate) => candidate === canonicalRoot || candidate.startsWith(`${canonicalRoot}/`);

  async function walk(dir, canonicalDir = canonicalRoot) {
    if (!isInsideRoot(canonicalDir) || visitedDirectories.has(canonicalDir)) return;
    visitedDirectories.add(canonicalDir);
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const path = join(dir, entry.name);
      if (entry.isDirectory() || entry.isSymbolicLink()) {
        // Follow directory symlinks only when their canonical target remains
        // inside this scan root, and visit each canonical directory once.
        const stats = await stat(path).catch(() => null);
        if (stats?.isDirectory()) {
          const canonicalPath = await realpath(path).catch(() => null);
          if (canonicalPath && isInsideRoot(canonicalPath)) await walk(path, canonicalPath);
        } else if (stats?.isFile() && predicate(path)) {
          // Regular symlinked model files remain discoverable, even when their
          // target lives elsewhere; only directory recursion is constrained.
          result.push(path);
        }
      } else if (entry.isFile() && predicate(path)) {
        result.push(path);
      }
    }
  }
  await walk(root);
  return result;
}

// (labelFromName, aliasFromName, quantFromName removed — parseModelName in model-name.mjs is the single path)


// ── Publisher extraction ─────────────────────────────────────────────────

/** Extract publisher from GGUF metadata (repo_url or quantized_by). */
function publisherFromGgufMeta(meta) {
  const repoUrl = meta["general.repo_url"];
  if (typeof repoUrl === "string") {
    const match = repoUrl.match(/huggingface\.co\/([^/?#]+)/i);
    if (match) return match[1];
  }
  const quantizedBy = meta["general.quantized_by"];
  if (typeof quantizedBy === "string" && quantizedBy.trim()) {
    return quantizedBy.trim().toLowerCase();
  }
  return null;
}

/** Extract publisher from directory structure relative to the scan root. */
function publisherFromPath(filePath, scanRoot, sourceLabel) {
  const rel = filePath.slice(scanRoot.length + 1).replace(/\\/g, "/");
  const parts = rel.split("/");
  if (parts.length === 0) return null;
  // HF hub: models--org--name/snapshots/hash/file
  if (parts[0]?.startsWith("models--")) {
    const after = parts[0].slice("models--".length);
    const dashIdx = after.indexOf("--");
    if (dashIdx > 0) return after.slice(0, dashIdx);
    return null;
  }
  // LM Studio: publisher/model-dir/file.gguf (3+ parts)
  if (sourceLabel === "lmstudio" && parts.length >= 3) return parts[0];
  return null;
}
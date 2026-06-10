import { statSync } from "node:fs";
import { readdir } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { getModelScanDirs } from "./config.mjs";
import { readGgufMetadata } from "./gguf.mjs";

// ── Scan for GGUF models and MTP drafters ────────────────────────────────

export async function scanGgufModels(dirs) {
  const scanDirs = dirs ?? await getModelScanDirs();
  const allModels = [];
  const allDrafters = [];

  for (const root of scanDirs) {
    const { models, drafters } = await scanOneDir(root);
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

async function scanOneDir(root) {
  const files = await findFiles(root, (path) => path.toLowerCase().endsWith(".gguf"));
  const mmprojs = files.filter((path) => basename(path).toLowerCase().includes("mmproj"));
  const candidates = files.filter((path) => !basename(path).toLowerCase().includes("mmproj"));

  const models = [];
  const drafters = [];

  for (const path of candidates) {
    const dir = dirname(path);
    const mmprojPath = mmprojs.find((candidate) => dirname(candidate) === dir) ?? null;
    const name = basename(path).replace(/\.gguf$/i, "");
    const sizeBytes = statSync(path).size;

    // Read GGUF metadata to detect drafter architecture
    const meta = safeReadGgufMetadata(path);
    const architecture = typeof meta["general.architecture"] === "string" ? meta["general.architecture"] : null;

    if (architecture === "gemma4_assistant") {
      // This is an MTP drafter model, not a main model
      drafters.push({
        path,
        label: labelFromName(name),
        aliasSuggestion: aliasFromName(name),
        quant: quantFromName(name),
        sizeBytes,
        architecture,
        targetHint: drafterTargetHint(name),
        backend: "llama-cpp",
        source: "local-gguf",
      });
    } else {
      models.push({
        path,
        mmprojPath,
        label: labelFromName(name),
        aliasSuggestion: aliasFromName(name),
        quant: quantFromName(name),
        sizeBytes,
        backend: "llama-cpp",
        source: "local-gguf",
      });
    }
  }

  return { models, drafters };
}

// ── Match drafters to target models ────────────────────────────────────

// Map a drafter filename to a regex that matches its target model filenames.
// e.g. "mtp-gemma-4-31B-it" matches "gemma-4-31B-it*"
//      "gemma-4-31B-it-assistant-Q8_0" matches "gemma-4-31B-it*"
//      "gemma-4-12b-it-MTP-Q8_0" matches "gemma-4-12b-it*"
function drafterTargetHint(name) {
  const lower = name.toLowerCase();
  // Strip common prefixes/suffixes to get the base model identifier
  let base = lower
    .replace(/^mtp[-_]/i, "")
    .replace(/[-_]mtp$/i, "")
    .replace(/[-_]assistant([-_].*)?$/i, "")
    .replace(/[-_]draft([-_].*)?$/i, "");
  // Remove quant suffix for matching (Q4_K_M, Q8_0, UD-Q4_K_XL, etc.)
  base = base.replace(/[-_]q\d_k_[a-z]+$/i, "").replace(/[-_]q\d_[01]$/i, "").replace(/[-_]ud-[a-z0-9_]+$/i, "");
  return base;
}

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
  async function walk(dir) {
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) await walk(path);
      else if (entry.isFile() && predicate(path)) result.push(path);
    }
  }
  await walk(root);
  return result;
}

function labelFromName(name) {
  return name
    .replace(/-/g, " ")
    .replace(/\bqwen/i, "Qwen")
    .replace(/q4_k_m/i, "Q4_K_M");
}

function aliasFromName(name) {
  return name.replace(/-Q4_K_M$/i, "-GGUF");
}

function quantFromName(name) {
  return name.match(/(Q\d_K_[A-Z]+|Q\d_[01]|UD-[A-Z0-9_]+)/)?.[1];
}

function safeReadGgufMetadata(path) {
  try {
    return readGgufMetadata(path);
  } catch {
    return {};
  }
}
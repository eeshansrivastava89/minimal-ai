import { statSync } from "node:fs";
import { readdir } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { getModelScanDirs } from "./config.mjs";

export async function scanGgufModels(dirs) {
  const scanDirs = dirs ?? await getModelScanDirs();
  const allModels = [];

  for (const root of scanDirs) {
    const models = await scanOneDir(root);
    allModels.push(...models);
  }

  // Deduplicate by path
  const seen = new Set();
  return allModels.filter((m) => {
    if (seen.has(m.path)) return false;
    seen.add(m.path);
    return true;
  }).sort((a, b) => a.label.localeCompare(b.label));
}

async function scanOneDir(root) {
  const files = await findFiles(root, (path) => path.toLowerCase().endsWith(".gguf"));
  const mmprojs = files.filter((path) => basename(path).toLowerCase().includes("mmproj"));
  const models = files.filter((path) => !basename(path).toLowerCase().includes("mmproj"));

  return models.map((path) => {
    const dir = dirname(path);
    const mmprojPath = mmprojs.find((candidate) => dirname(candidate) === dir) ?? null;
    const name = basename(path).replace(/\.gguf$/i, "");
    return {
      path,
      mmprojPath,
      label: labelFromName(name),
      aliasSuggestion: aliasFromName(name),
      quant: quantFromName(name),
      sizeBytes: statSync(path).size,
      backend: "llama-cpp",
      source: "local-gguf",
    };
  });
}

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
  return name.match(/(Q\d_K_[A-Z]+|UD-[A-Z0-9_]+)/)?.[1];
}
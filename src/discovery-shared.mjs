// Helpers for the GGUF scanner (scan.mjs). Centralizes model-size and embedding-type
// constants so they're defined once rather than duplicated across scanners.

import { basename, dirname } from "node:path";

/** Minimum on-disk size for a model to count as real (skips tiny test/embedding files). */
export const MIN_MODEL_SIZE_BYTES = 10 * 1024 * 1024; // 10 MB

/**
 * Model-type / architecture names that indicate an embedding model. Shared by
 * GGUF filtering (general.architecture) and MLX filtering (config.model_type /
 * architectures[0]). Format-specific heuristics (e.g. GGUF filename patterns)
 * live alongside this set in each scanner.
 */
export const EMBEDDING_MODEL_TYPES = new Set([
  "bert",
  "roberta",
  "mpnet",
  "nomic_bert",
  "nomic-bert",
  "jina",
  "e5",
  "gte",
  "bge",
  "all_minilm",
  "all-minilm",
  "sentence_transformers",
  "sentence-transformers",
]);

/**
 * Infer a human-readable source label from a model scan path.
 * Generic container folders (models, hub, cache) defer to their parent name
 * (e.g. ~/.cache/huggingface/hub -> "huggingface"; ~/.lmstudio/models -> "lmstudio").
 */
export function inferSourceLabel(scanPath) {
  const name = basename(scanPath).replace(/^\./, "");
  const parent = basename(dirname(scanPath));
  if (name === "models" || name === "hub" || name === "cache") {
    return parent.replace(/^\./, "");
  }
  return name;
}
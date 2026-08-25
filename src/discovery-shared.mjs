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

/**
 * Reduce a drafter filename to its target main-model base name, so a drafter
 * can be matched to its main model. Strips quant tokens anywhere (not just as
 * a suffix — a `-MTP`-suffix drafter like "gemma-4-E2B-it-Q8_0-MTP" has the
 * quant before the -MTP marker) plus MTP/assistant/draft markers and the
 * .gguf extension. Lives here (not scan.mjs) so download.mjs can use it
 * without importing the whole scanner (#2, L1).
 */
export function drafterTargetHint(name) {
  const lower = String(name).toLowerCase().replace(/\.gguf$/i, "");
  let base = lower
    .replace(/[-_]ud-[a-z0-9_]+/gi, "")
    .replace(/[-_](?:bf|f)\d{2}\b/gi, "")
    .replace(/[-_]q\d_k_[a-z]+/gi, "")
    .replace(/[-_]q\d_[01]\b/gi, "");
  base = base
    .replace(/^mtp[-_]/i, "")
    .replace(/[-_]mtp$/i, "")
    .replace(/[-_]assistant([-_].*)?$/i, "")
    .replace(/[-_]draft([-_].*)?$/i, "");
  base = base.replace(/[-_]{2,}/g, "-").replace(/^[-_]+|[-_]+$/g, "");
  return base;
}
import { existsSync, statSync } from "node:fs";
import { readGgufMetadata, numberMeta } from "./gguf.mjs";

/**
 * Read model file sizes + GGUF architecture metadata once.
 * The returned object is reusable across many flag combinations —
 * call computeMemoryTotal(prepared, flags) for each variant.
 */
export function prepareMemoryEstimate(modelPath, mmprojPath, draftModelPath) {
  const modelBytes = statSync(modelPath).size;
  const mmprojBytes = mmprojPath && existsSync(mmprojPath) ? statSync(mmprojPath).size : 0;
  const draftBytes = draftModelPath && existsSync(draftModelPath) ? statSync(draftModelPath).size : 0;
  const metadata = readGgufMetadata(modelPath);
  const architecture = metadata["general.architecture"];
  const prefix = typeof architecture === "string" ? architecture : null;
  const layers = numberMeta(metadata, prefix && `${prefix}.block_count`);
  const headKv = numberOrArrayMeta(metadata, prefix && `${prefix}.attention.head_count_kv`);
  const embeddingLength = numberMeta(metadata, prefix && `${prefix}.embedding_length`);
  const headCount = numberMeta(metadata, prefix && `${prefix}.attention.head_count`);
  // key_length and value_length are not always present in GGUF metadata.
  // llama.cpp derives them from embedding_length / head_count when missing.
  const defaultLength = embeddingLength && headCount ? embeddingLength / headCount : undefined;
  const keyLength = numberOrArrayMeta(metadata, prefix && `${prefix}.attention.key_length`) ?? defaultLength;
  const valueLength = numberOrArrayMeta(metadata, prefix && `${prefix}.attention.value_length`) ?? defaultLength;
  const slidingWindow = numberMeta(metadata, prefix && `${prefix}.attention.sliding_window`);
  const slidingWindowPattern = booleanArrayMeta(metadata, prefix && `${prefix}.attention.sliding_window_pattern`);
  const keyLengthSwa = numberMeta(metadata, prefix && `${prefix}.attention.key_length_swa`);
  const valueLengthSwa = numberMeta(metadata, prefix && `${prefix}.attention.value_length_swa`);
  // Scale overhead with model size: llama.cpp's compute buffers, graph,
  // and runtime overhead grow with model dimensions. 5% of model size,
  // with a floor of 256MB (small models still have fixed runtime costs).
  const overheadBytes = Math.max(256 * 1024 ** 2, Math.round(modelBytes * 0.05));
  return {
    modelBytes,
    mmprojBytes,
    draftBytes,
    overheadBytes,
    kvParams: { layers, headKv, keyLength, valueLength, slidingWindow, slidingWindowPattern, keyLengthSwa, valueLengthSwa },
  };
}

/** Compute KV cache + total memory for a specific flag combination. */
export function computeMemoryTotal(prepared, flags) {
  const bytesK = bytesForCacheType(flags.cacheTypeK);
  const bytesV = bytesForCacheType(flags.cacheTypeV);
  const kv = estimateKvBytes({
    ctxSize: flags.ctxSize,
    parallel: flags.parallel ?? 1,
    ...prepared.kvParams,
    bytesK,
    bytesV,
  });
  return {
    modelBytes: prepared.modelBytes,
    mmprojBytes: prepared.mmprojBytes,
    draftBytes: prepared.draftBytes,
    kvBytes: kv.bytes,
    overheadBytes: prepared.overheadBytes,
    totalBytes: prepared.modelBytes + prepared.mmprojBytes + prepared.draftBytes + kv.bytes + prepared.overheadBytes,
    note: kv.note,
  };
}

/** Convenience: prepare + compute in one call (existing API, unchanged). */
export function estimateMemory(modelPath, mmprojPath, draftModelPath, flags) {
  const prepared = prepareMemoryEstimate(modelPath, mmprojPath, draftModelPath);
  return computeMemoryTotal(prepared, flags);
}

function estimateKvBytes(input) {
  const { ctxSize, parallel, layers, bytesK, bytesV } = input;
  if (!layers || !ctxSize || !bytesK || !bytesV) {
    return { bytes: 0, note: "KV estimate unavailable: missing GGUF architecture metadata.", mode: "unknown" };
  }

  const canLayer = input.headKv && input.keyLength && input.valueLength;
  if (!canLayer) return { bytes: 0, note: "KV estimate unavailable: missing GGUF architecture metadata.", mode: "unknown" };

  if (Array.isArray(input.headKv) || Array.isArray(input.keyLength) || Array.isArray(input.valueLength) || input.slidingWindowPattern?.length) {
    let total = 0;
    for (let i = 0; i < layers; i++) {
      const headKv = valueForLayer(input.headKv, i);
      let keyLength = valueForLayer(input.keyLength, i);
      let valueLength = valueForLayer(input.valueLength, i);
      let layerCtx = ctxSize;
      if (input.slidingWindowPattern?.[i] && input.slidingWindow) {
        layerCtx = Math.min(ctxSize, input.slidingWindow);
        keyLength = input.keyLengthSwa ?? keyLength;
        valueLength = input.valueLengthSwa ?? valueLength;
      }
      if (headKv == null || keyLength == null || valueLength == null) {
        return { bytes: 0, note: "KV estimate unavailable: incomplete layer-specific GGUF metadata.", mode: "unknown" };
      }
      // Layers with headKv = 0 have no KV cache — skip them
      if (headKv && keyLength && valueLength) {
        total += layerCtx * parallel * headKv * ((keyLength * bytesK) + (valueLength * bytesV));
      }
    }
    return { bytes: total, note: "", mode: input.slidingWindowPattern?.length ? "layered-swa" : "layered" };
  }

  return {
    bytes: ctxSize * parallel * layers * input.headKv * ((input.keyLength * bytesK) + (input.valueLength * bytesV)),
    note: "",
    mode: "simple",
  };
}

function valueForLayer(value, index) {
  return Array.isArray(value) ? value[index] : value;
}

function numberOrArrayMeta(meta, key) {
  const value = key ? meta[key] : undefined;
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (Array.isArray(value) && value.every((item) => typeof item === "number" && Number.isFinite(item))) return value;
  return undefined;
}

function booleanArrayMeta(meta, key) {
  const value = key ? meta[key] : undefined;
  return Array.isArray(value) && value.every((item) => typeof item === "boolean") ? value : undefined;
}

function bytesForCacheType(type) {
  const normalized = String(type ?? "").toLowerCase();
  if (normalized === "f32") return 4;
  if (normalized === "f16" || normalized === "bf16") return 2;
  if (normalized === "q8_0") return 34 / 32;
  if (["q4_0", "q4_1", "iq4_nl"].includes(normalized)) return 18 / 32;
  if (["q5_0", "q5_1"].includes(normalized)) return 21 / 32;
  return undefined;
}
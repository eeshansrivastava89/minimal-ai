import { openSync, readSync, closeSync, statSync, existsSync } from "node:fs";
import { basename } from "node:path";
import { parseModelName } from "./model-name.mjs";

const MAX_METADATA_ENTRIES = 100_000;
// GGUF token vocabularies commonly contain hundreds of thousands of strings;
// keep that valid case while rejecting hostile/unbounded counts.
const MAX_METADATA_ARRAY_VALUES = 1_000_000;

function u64AsSafeNumber(buffer, offset) {
  const value = buffer.readBigUInt64LE(offset);
  if (value > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error("GGUF integer exceeds safe range");
  return Number(value);
}

function u64Value(buffer, offset) {
  return u64AsSafeNumber(buffer, offset);
}

function i64Value(buffer, offset) {
  const value = buffer.readBigInt64LE(offset);
  if (value < BigInt(Number.MIN_SAFE_INTEGER) || value > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw new Error("GGUF integer exceeds safe range");
  }
  return Number(value);
}

function ensureBytes(buffer, offset, length) {
  if (!Number.isSafeInteger(offset) || !Number.isSafeInteger(length) || offset < 0 || length < 0 || offset + length > buffer.length) {
    throw new Error("GGUF metadata offset is outside the file prefix");
  }
}

export function readGgufMetadata(path) {
  const buffer = readFilePrefix(path, 64 * 1024 * 1024);
  let offset = 0;
  const meta = {};
  if (buffer.length < 24 || buffer.toString("utf8", 0, 4) !== "GGUF") return meta;
  offset += 4;
  offset += 4; // version
  offset += 8; // tensor count
  if (offset + 8 > buffer.length) throw new Error("GGUF metadata header is truncated");
  const kvCount = u64AsSafeNumber(buffer, offset);
  offset += 8;
  if (kvCount > MAX_METADATA_ENTRIES) return {};
  for (let i = 0; i < kvCount; i++) {
    if (offset + 8 > buffer.length) throw new Error("GGUF metadata key is truncated");
    const keyLen = u64AsSafeNumber(buffer, offset);
    offset += 8;
    ensureBytes(buffer, offset, keyLen + 4);
    const key = buffer.toString("utf8", offset, offset + keyLen);
    offset += keyLen;
    const type = buffer.readUInt32LE(offset);
    offset += 4;
    let read;
    try {
      read = readValue(buffer, offset, type);
    } catch (error) {
      throw new Error(`GGUF metadata value is invalid: ${error.message}`, { cause: error });
    }
    if (read.offset > buffer.length) throw new Error("GGUF metadata value exceeds the file prefix");
    offset = read.offset;
    meta[key] = read.value;
  }
  return meta;
}

function readFilePrefix(path, maxBytes) {
  const fd = openSync(path, "r");
  try {
    const size = Math.min(statSync(path).size, maxBytes);
    const buffer = Buffer.alloc(size);
    readSync(fd, buffer, 0, size, 0);
    return buffer;
  } finally {
    closeSync(fd);
  }
}

const TYPE_READERS = [
  (buf, off) => { ensureBytes(buf, off, 1); return { value: buf.readUInt8(off), offset: off + 1 }; },
  (buf, off) => { ensureBytes(buf, off, 1); return { value: buf.readInt8(off), offset: off + 1 }; },
  (buf, off) => { ensureBytes(buf, off, 2); return { value: buf.readUInt16LE(off), offset: off + 2 }; },
  (buf, off) => { ensureBytes(buf, off, 2); return { value: buf.readInt16LE(off), offset: off + 2 }; },
  (buf, off) => { ensureBytes(buf, off, 4); return { value: buf.readUInt32LE(off), offset: off + 4 }; },
  (buf, off) => { ensureBytes(buf, off, 4); return { value: buf.readInt32LE(off), offset: off + 4 }; },
  (buf, off) => { ensureBytes(buf, off, 4); return { value: buf.readFloatLE(off), offset: off + 4 }; },
  (buf, off) => { ensureBytes(buf, off, 1); return { value: Boolean(buf.readUInt8(off)), offset: off + 1 }; },
  (buf, off) => {
    const len = u64AsSafeNumber(buf, off);
    off += 8;
    ensureBytes(buf, off, len);
    return { value: buf.toString("utf8", off, off + len), offset: off + len };
  },
  (buf, off) => {
    ensureBytes(buf, off, 12);
    const itemType = buf.readUInt32LE(off);
    off += 4;
    const len = u64AsSafeNumber(buf, off);
    off += 8;
    if (len > MAX_METADATA_ARRAY_VALUES) throw new Error("GGUF metadata array is too large");
    const values = [];
    for (let i = 0; i < len; i++) {
      const item = readValue(buf, off, itemType);
      off = item.offset;
      if (i < 32) values.push(item.value);
    }
    return { value: values, offset: off };
  },
  (buf, off) => { ensureBytes(buf, off, 8); return { value: u64Value(buf, off), offset: off + 8 }; },
  (buf, off) => { ensureBytes(buf, off, 8); return { value: i64Value(buf, off), offset: off + 8 }; },
  (buf, off) => { ensureBytes(buf, off, 8); return { value: buf.readDoubleLE(off), offset: off + 8 }; },
];

function readValue(buffer, offset, type) {
  const reader = TYPE_READERS[type];
  if (!reader) throw new Error(`Unsupported GGUF metadata value type ${type}`);
  return reader(buffer, offset);
}

/** Safe wrapper that returns {} on error or missing file. */
export function readGgufMetadataSafe(path) {
  if (!existsSync(path)) return {};
  try {
    return readGgufMetadata(path);
  } catch {
    return {};
  }
}

/** Extract a finite number from GGUF metadata, or undefined. */
export function numberMeta(meta, key) {
  const value = key ? meta[key] : undefined;
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

// ── llama_ftype → quant name mapping ──────────────────────────────────────
// Sourced from llama.cpp's enum llama_ftype (include/llama.h) and the
// corresponding display names from llama_ftype_name() (src/llama-model-loader.cpp).
// This is the canonical, machine-readable source of quant info stored in GGUF
// metadata as `general.file_type`. New quants added to llama.cpp just need
// a new entry here.
const LLAMA_FTYPE_NAMES = {
  0: "F32",
  1: "F16",
  2: "Q4_0",
  3: "Q4_1",
  7: "Q8_0",
  8: "Q5_0",
  9: "Q5_1",
  10: "Q2_K",
  11: "Q3_K_S",
  12: "Q3_K_M",
  13: "Q3_K_L",
  14: "Q4_K_S",
  15: "Q4_K_M",
  16: "Q5_K_S",
  17: "Q5_K_M",
  18: "Q6_K",
  19: "IQ2_XXS",
  20: "IQ2_XS",
  21: "Q2_K_S",
  22: "IQ3_XS",
  23: "IQ3_XXS",
  24: "IQ1_S",
  25: "IQ4_NL",
  26: "IQ3_S",
  27: "IQ3_M",
  28: "IQ2_S",
  29: "IQ2_M",
  30: "IQ4_XS",
  31: "IQ1_M",
  32: "BF16",
  36: "TQ1_0",
  37: "TQ2_0",
  38: "MXFP4",
  39: "NVFP4",
  40: "Q1_0",
  41: "Q2_0",
};

/**
 * Resolve the quant name from GGUF metadata (authoritative) with filename fallback.
 * Prefers `general.file_type` from metadata; falls back to parseModelName for
 * UD-/MLX-style names not in the llama_ftype enum.
 */
export function resolveQuant(meta, filename) {
  const ftype = meta["general.file_type"];
  const metaQuant = typeof ftype === "number" ? LLAMA_FTYPE_NAMES[ftype] ?? null : null;
  const parsed = parseModelName(basename(filename).replace(/\.gguf$/i, ""), "local-gguf");
  // UD- prefixed quants (Unsloth Dynamic) are not in the llama_ftype enum,
  // so filename parsing is the only source for those. Prefer metadata for
  // standard quants, filename for UD-/MLX-style names.
  if (metaQuant && !parsed.quant?.startsWith("UD-")) return metaQuant;
  return parsed.quant ?? metaQuant ?? null;
}
import { openSync, readSync, closeSync, statSync, existsSync } from "node:fs";

export function readGgufMetadata(path) {
  const buffer = readFilePrefix(path, 64 * 1024 * 1024);
  let offset = 0;
  const meta = {};
  if (buffer.length < 24 || buffer.toString("utf8", 0, 4) !== "GGUF") return meta;
  offset += 4;
  offset += 4; // version
  offset += 8; // tensor count
  if (offset + 8 > buffer.length) return meta;
  const kvCount = Number(buffer.readBigUInt64LE(offset));
  offset += 8;
  for (let i = 0; i < kvCount; i++) {
    if (offset + 8 > buffer.length) return meta;
    const keyLen = Number(buffer.readBigUInt64LE(offset));
    offset += 8;
    if (offset + keyLen + 4 > buffer.length) return meta;
    const key = buffer.toString("utf8", offset, offset + keyLen);
    offset += keyLen;
    const type = buffer.readUInt32LE(offset);
    offset += 4;
    let read;
    try {
      read = readValue(buffer, offset, type);
    } catch {
      return meta;
    }
    if (read.offset > buffer.length) return meta;
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
  (buf, off) => ({ value: buf.readUInt8(off), offset: off + 1 }),
  (buf, off) => ({ value: buf.readInt8(off), offset: off + 1 }),
  (buf, off) => ({ value: buf.readUInt16LE(off), offset: off + 2 }),
  (buf, off) => ({ value: buf.readInt16LE(off), offset: off + 2 }),
  (buf, off) => ({ value: buf.readUInt32LE(off), offset: off + 4 }),
  (buf, off) => ({ value: buf.readInt32LE(off), offset: off + 4 }),
  (buf, off) => ({ value: buf.readFloatLE(off), offset: off + 4 }),
  (buf, off) => ({ value: Boolean(buf.readUInt8(off)), offset: off + 1 }),
  (buf, off) => {
    const len = Number(buf.readBigUInt64LE(off));
    off += 8;
    return { value: buf.toString("utf8", off, off + len), offset: off + len };
  },
  (buf, off) => {
    const itemType = buf.readUInt32LE(off);
    off += 4;
    const len = Number(buf.readBigUInt64LE(off));
    off += 8;
    const values = [];
    for (let i = 0; i < len; i++) {
      const item = readValue(buf, off, itemType);
      off = item.offset;
      if (i < 32) values.push(item.value);
    }
    return { value: values, offset: off };
  },
  (buf, off) => ({ value: Number(buf.readBigUInt64LE(off)), offset: off + 8 }),
  (buf, off) => ({ value: Number(buf.readBigInt64LE(off)), offset: off + 8 }),
  (buf, off) => ({ value: buf.readDoubleLE(off), offset: off + 8 }),
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
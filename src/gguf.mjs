import { openSync, readSync, closeSync, statSync } from "node:fs";

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

function readValue(buffer, offset, type) {
  if (type === 0) return { value: buffer.readUInt8(offset), offset: offset + 1 };
  if (type === 1) return { value: buffer.readInt8(offset), offset: offset + 1 };
  if (type === 2) return { value: buffer.readUInt16LE(offset), offset: offset + 2 };
  if (type === 3) return { value: buffer.readInt16LE(offset), offset: offset + 2 };
  if (type === 4) return { value: buffer.readUInt32LE(offset), offset: offset + 4 };
  if (type === 5) return { value: buffer.readInt32LE(offset), offset: offset + 4 };
  if (type === 6) return { value: buffer.readFloatLE(offset), offset: offset + 4 };
  if (type === 7) return { value: Boolean(buffer.readUInt8(offset)), offset: offset + 1 };
  if (type === 8) {
    const len = Number(buffer.readBigUInt64LE(offset));
    offset += 8;
    return { value: buffer.toString("utf8", offset, offset + len), offset: offset + len };
  }
  if (type === 9) {
    const itemType = buffer.readUInt32LE(offset);
    offset += 4;
    const len = Number(buffer.readBigUInt64LE(offset));
    offset += 8;
    const values = [];
    for (let i = 0; i < len; i++) {
      const item = readValue(buffer, offset, itemType);
      offset = item.offset;
      if (i < 32) values.push(item.value);
    }
    return { value: values, offset };
  }
  if (type === 10) return { value: Number(buffer.readBigUInt64LE(offset)), offset: offset + 8 };
  if (type === 11) return { value: Number(buffer.readBigInt64LE(offset)), offset: offset + 8 };
  if (type === 12) return { value: buffer.readDoubleLE(offset), offset: offset + 8 };
  throw new Error(`Unsupported GGUF metadata value type ${type}`);
}
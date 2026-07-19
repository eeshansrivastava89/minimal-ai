import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { chmod, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { openSync, closeSync, ftruncateSync } from "node:fs";

const { isSafeDataDirPath } = await import("../src/commands/uninstall.mjs");
const { isSafeOmlxModelPath, isSafeOmlxDeletionTarget, deleteModelFromSource } = await import("../src/commands/models-delete.mjs");
const { processIdentityMatches, readProcessIdentity } = await import("../src/server-status.mjs");
const { readGgufMetadataSafe } = await import("../src/gguf.mjs");
const { scanGgufModels } = await import("../src/scan.mjs");

function makePrompt(yes = true) {
  return async () => yes;
}

function sparseFile(path, size = 11 * 1024 * 1024) {
  const fd = openSync(path, "w");
  ftruncateSync(fd, size);
  closeSync(fd);
}

describe("P0 safety predicates", () => {
  it("rejects uninstall targets that are relative, home/cwd, root, or ancestors", () => {
    const home = "/tmp/p0-home";
    const cwd = "/tmp/p0-home/project";
    assert.equal(isSafeDataDirPath("", { homeDir: home, cwd }), false);
    assert.equal(isSafeDataDirPath("relative", { homeDir: home, cwd }), false);
    assert.equal(isSafeDataDirPath("/", { homeDir: home, cwd }), false);
    assert.equal(isSafeDataDirPath(home, { homeDir: home, cwd }), false);
    assert.equal(isSafeDataDirPath("/tmp", { homeDir: home, cwd }), false);
    assert.equal(isSafeDataDirPath("/tmp/offgrid-data", { homeDir: home, cwd }), true);
  });

  it("requires a strict oMLX model descendant, not the models root", () => {
    const root = "/tmp/omlx/models";
    assert.equal(isSafeOmlxModelPath(root, root), false);
    assert.equal(isSafeOmlxModelPath(`${root}/qwen`, root), true);
    assert.equal(isSafeOmlxModelPath(`${root}/../other`, root), false);
    assert.equal(isSafeOmlxModelPath("relative-model", root), false);
  });

  it("allows a safely scoped but already-absent oMLX model path", async (t) => {
    const root = await mkdtemp(join(tmpdir(), "offgrid-omlx-absent-"));
    t.after(() => rm(root, { recursive: true, force: true }));
    assert.equal(await isSafeOmlxDeletionTarget(join(root, "org", "model"), root), true);
  });

  it("rejects an oMLX directory symlink that escapes the canonical root", async (t) => {
    const root = await mkdtemp(join(tmpdir(), "offgrid-omlx-root-"));
    const outside = await mkdtemp(join(tmpdir(), "offgrid-omlx-outside-"));
    t.after(async () => Promise.all([rm(root, { recursive: true, force: true }), rm(outside, { recursive: true, force: true })]));
    const target = join(root, "model");
    try {
      await symlink(outside, target);
    } catch {
      t.skip("symlink creation is unavailable on this platform");
      return;
    }
    assert.equal(await isSafeOmlxDeletionTarget(target, root), false);
  });

  it("requires every persisted process identity field to match", () => {
    const identity = { pid: 42, pgid: "42", startToken: "Mon Jan 1 00:00:00 2024", executable: "llama-server", commandToken: "/bin/llama-server" };
    assert.equal(processIdentityMatches(identity, { ...identity }), true);
    assert.equal(processIdentityMatches({ ...identity, startToken: "different" }, identity), false);
    assert.equal(processIdentityMatches({ pid: 42 }, identity), false);
    assert.equal(processIdentityMatches(identity, { ...identity, pid: 43 }), false);
  });

  it("extracts a stable command token from mocked ps output", async () => {
    const output = { lstart: "Mon Jan 1 00:00:00 2024", pgid: "42", comm: "llama-server", args: "/bin/llama-server --model model.gguf" };
    const identity = await readProcessIdentity(42, async (_cmd, args) => ({ stdout: output[args[1].replace(/=$/u, "")] ?? "" }));
    assert.equal(identity.commandToken, "/bin/llama-server");
  });
});

describe("P0 scanner and GGUF bounds", () => {
  it("returns empty metadata for an oversized array count", async (t) => {
    const dir = await mkdtemp(join(tmpdir(), "offgrid-gguf-"));
    t.after(() => rm(dir, { recursive: true, force: true }));
    const path = join(dir, "oversized.gguf");
    const buffer = Buffer.alloc(64);
    buffer.write("GGUF", 0, "ascii");
    buffer.writeUInt32LE(3, 4);
    buffer.writeBigUInt64LE(0n, 8);
    buffer.writeBigUInt64LE(1n, 16);
    buffer.writeBigUInt64LE(1n, 24);
    buffer.write("x", 32, "ascii");
    buffer.writeUInt32LE(9, 33);
    buffer.writeUInt32LE(4, 37);
    buffer.writeBigUInt64LE(0xffffffffffffffffn, 41);
    await writeFile(path, buffer);
    assert.deepEqual(readGgufMetadataSafe(path), {});
  });

  it("preserves valid scalar metadata and rejects truncated metadata", async (t) => {
    const dir = await mkdtemp(join(tmpdir(), "offgrid-gguf-valid-"));
    t.after(() => rm(dir, { recursive: true, force: true }));
    const valid = Buffer.alloc(43);
    valid.write("GGUF", 0, "ascii");
    valid.writeUInt32LE(3, 4);
    valid.writeBigUInt64LE(0n, 8);
    valid.writeBigUInt64LE(1n, 16);
    valid.writeBigUInt64LE(3n, 24);
    valid.write("foo", 32, "ascii");
    valid.writeUInt32LE(4, 35);
    valid.writeUInt32LE(123, 39);
    const validPath = join(dir, "valid.gguf");
    await writeFile(validPath, valid);
    assert.deepEqual(readGgufMetadataSafe(validPath), { foo: 123 });
    const truncatedPath = join(dir, "truncated.gguf");
    await writeFile(truncatedPath, valid.subarray(0, valid.length - 1));
    assert.deepEqual(readGgufMetadataSafe(truncatedPath), {});
  });

  it("follows regular symlinked GGUF files without following cycles or outside directories", async (t) => {
    const root = await mkdtemp(join(tmpdir(), "offgrid-symlink-root-"));
    const outside = await mkdtemp(join(tmpdir(), "offgrid-symlink-outside-"));
    t.after(async () => Promise.all([rm(root, { recursive: true, force: true }), rm(outside, { recursive: true, force: true })]));
    sparseFile(join(outside, "linked.gguf"));
    sparseFile(join(outside, "outside.gguf"));
    try {
      await symlink(join(outside, "linked.gguf"), join(root, "linked.gguf"));
      await symlink(root, join(root, "cycle"));
      await symlink(outside, join(root, "outside-dir"));
    } catch {
      t.skip("symlink creation is unavailable on this platform");
      return;
    }
    const { models } = await scanGgufModels([root]);
    assert.ok(models.some((model) => model.path === join(root, "linked.gguf")));
    assert.equal(models.some((model) => model.path.includes("outside-dir")), false);
    assert.equal(models.some((model) => model.path.includes("cycle/cycle")), false);
  });
});

describe("P0 deletion transaction gating", () => {
  it("returns confirmed:false when the source file cannot be deleted, so profile cleanup is skipped", async (t) => {
    const dir = await mkdtemp(join(tmpdir(), "offgrid-delete-fail-"));
    t.after(async () => { await chmod(dir, 0o755).catch(() => {}); await rm(dir, { recursive: true, force: true }); });
    const file = join(dir, "model.gguf");
    await writeFile(file, "not a real model");
    await chmod(dir, 0o555); // read+execute only — unlink will fail with EACCES
    const result = await deleteModelFromSource({ type: "new", model: { path: file } }, makePrompt(true));
    assert.equal(result.confirmed, false, "deletion should not be confirmed when unlink fails");
    assert.ok(result.reason, "a failure reason should be provided");
  });

  it("returns confirmed:true when the source file is deleted successfully", async (t) => {
    const dir = await mkdtemp(join(tmpdir(), "offgrid-delete-ok-"));
    t.after(() => rm(dir, { recursive: true, force: true }));
    const file = join(dir, "model.gguf");
    await writeFile(file, "not a real model");
    const result = await deleteModelFromSource({ type: "new", model: { path: file } }, makePrompt(true));
    assert.equal(result.confirmed, true, "deletion should be confirmed on success");
  });

  it("returns confirmed:false when the user declines the prompt", async (t) => {
    const dir = await mkdtemp(join(tmpdir(), "offgrid-decline-"));
    t.after(() => rm(dir, { recursive: true, force: true }));
    const file = join(dir, "model.gguf");
    await writeFile(file, "not a real model");
    const result = await deleteModelFromSource({ type: "new", model: { path: file } }, makePrompt(false));
    assert.equal(result.confirmed, false);
    assert.equal(result.cancelled, true);
  });
});

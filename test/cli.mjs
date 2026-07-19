import test from "node:test";
import assert from "node:assert";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const BIN = join(dirname(fileURLToPath(import.meta.url)), "..", "bin", "offgrid-ai.mjs");

function run(args) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [BIN, ...args], { encoding: "utf8" });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d) => { stdout += d; });
    child.stderr.on("data", (d) => { stderr += d; });
    child.on("error", reject);
    child.on("close", (code) => resolve({ code, stdout, stderr }));
  });
}

test("--help shows Fang-style help", async () => {
  const { code, stdout, stderr } = await run(["--help"]);
  assert.strictEqual(code, 0, `stderr: ${stderr}`);
  assert(stdout.includes("offgrid-ai"), "should include app name");
  assert(stdout.includes("USAGE"), "should include USAGE section");
  assert(stdout.includes("COMMANDS"), "should include COMMANDS section");
  assert(stdout.includes("FLAGS"), "should include FLAGS section");
});

test("version command shows version", async () => {
  const { code, stdout, stderr } = await run(["version"]);
  assert.strictEqual(code, 0, `stderr: ${stderr}`);
  assert.match(stdout, /offgrid-ai v\d+\.\d+\.\d+/);
});

test("unknown command prints friendly error", async () => {
  const { code, stderr } = await run(["nope"]);
  assert.notStrictEqual(code, 0);
  assert(stderr.includes("Unknown command"), `stderr: ${stderr}`);
});

test("status command runs without error", async () => {
  const { code, stderr } = await run(["status"]);
  assert.strictEqual(code, 0, `stderr: ${stderr}`);
});

test("run command rejects missing profile", async () => {
  const { code, stderr } = await run(["run", "does-not-exist"]);
  assert.notStrictEqual(code, 0);
  assert(stderr.includes("not found"), `stderr: ${stderr}`);
});

test("stop --all works when nothing is running", async () => {
  const { code, stderr } = await run(["stop", "--all"]);
  assert.strictEqual(code, 0, `stderr: ${stderr}`);
});

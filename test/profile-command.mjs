import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

const dataDir = await mkdtemp(join(tmpdir(), "offgrid-profile-command-"));
process.env.OFFGRID_DIR = dataDir;

const { ensureDirs } = await import("../src/config.mjs");
const { commandJsonPath, readCommandArgv, saveProfile } = await import("../src/profiles.mjs");

describe("profile command files", () => {
  it("uses command.json argv as the local server source of truth", async () => {
    await ensureDirs();
    const profile = await saveProfile({
      id: "demo",
      label: "Demo",
      backend: "llama-cpp",
      providerId: "llama-cpp",
      modelAlias: "demo",
      flags: { host: "127.0.0.1", port: 8080 },
      commandArgv: ["--model", "/old/model.gguf"],
    });

    await writeFile(commandJsonPath(profile.id), JSON.stringify({ argv: ["--model", "/edited/model.gguf", "--ctx-size", 4096] }, null, 2));

    assert.deepEqual(await readCommandArgv(profile), ["--model", "/edited/model.gguf", "--ctx-size", "4096"]);
  });
});

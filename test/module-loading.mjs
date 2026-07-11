import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "src");

// Collect every .mjs file under src/ (including src/commands/)
const modulePaths = [];
for (const entry of readdirSync(ROOT, { withFileTypes: true })) {
  if (entry.isFile() && entry.name.endsWith(".mjs")) {
    modulePaths.push(`../src/${entry.name}`);
  }
}
for (const entry of readdirSync(join(ROOT, "commands"), { withFileTypes: true })) {
  if (entry.isFile() && entry.name.endsWith(".mjs")) {
    modulePaths.push(`../src/commands/${entry.name}`);
  }
}

describe("module loading", () => {
  for (const relPath of modulePaths) {
    it(`${relPath} loads without error`, async () => {
      // Dynamic import — if any named import binding doesn't exist in the
      // source module, ESM throws at import time. This catches the #1
      // recurring bug class: importing X from module A when X lives in module B.
      const mod = await import(relPath);
      assert.ok(mod, `module ${relPath} loaded but returned undefined`);
    });
  }
});
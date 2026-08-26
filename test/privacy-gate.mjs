import { test } from "node:test";
import assert from "node:assert/strict";

import { relativeImports, brokenRelativeImports } from "../scripts/privacy-gate.mjs";

// ── relativeImports ─────────────────────────────────────────────────

test("relativeImports", async (t) => {
  await t.test("captures static import and export ... from", () => {
    const src = `
      import { foo } from "./foo.mjs";
      export { bar } from "../bar.mjs";
      export * from "./all.mjs";
    `;
    assert.deepEqual(relativeImports(src).sort(), ["../bar.mjs", "./all.mjs", "./foo.mjs"]);
  });

  await t.test("captures dynamic import()", () => {
    const src = `const m = await import("../dyn/probe.mjs");`;
    assert.deepEqual(relativeImports(src), ["../dyn/probe.mjs"]);
  });

  await t.test("ignores bare specifiers", () => {
    const src = `
      import picocolors from "picocolors";
      import { x } from "node:path";
    `;
    assert.deepEqual(relativeImports(src), []);
  });

  await t.test("ignores absolute and non-relative paths", () => {
    const src = `
      import "/abs.mjs";
      import "https://example.com/x.mjs";
    `;
    assert.deepEqual(relativeImports(src), []);
  });

  await t.test("dedupes a spec imported twice", () => {
    const src = `
      import { a } from "./shared.mjs";
      import { b } from "./shared.mjs";
    `;
    assert.deepEqual(relativeImports(src), ["./shared.mjs"]);
  });

  await t.test("handles single and double quotes", () => {
    const src = `import { single } from './single.mjs';\nimport { dbl } from "./dbl.mjs";`;
    assert.deepEqual(relativeImports(src).sort(), ["./dbl.mjs", "./single.mjs"]);
  });

  await t.test("does not match 'from' inside prose or non-import contexts", () => {
    // "from" followed by a quoted relative path is effectively always an
    // import in .mjs source, but the word-boundary anchor must at least
    // avoid substrings like "transform".
    const src = `const x = "transform './x.mjs'";`;
    assert.deepEqual(relativeImports(src), []);
  });
});

// ── brokenRelativeImports ───────────────────────────────────────────

test("brokenRelativeImports", async (t) => {
  // exists() backed by an in-memory set of posix paths.
  const makeExists = (files) => (p) => files.has(p);

  await t.test("empty when every relative import resolves", () => {
    const files = new Set([
      "src/commands/autotune.mjs",
      "src/autotune/probe.mjs",
      "src/autotune/grid.mjs",
    ]);
    const moduleFiles = [
      {
        path: "src/commands/autotune.mjs",
        content: `
          import { probe } from "../autotune/probe.mjs";
          import { grid } from "../autotune/grid.mjs";
        `,
      },
      { path: "src/autotune/probe.mjs", content: "" },
      { path: "src/autotune/grid.mjs", content: "" },
    ];
    assert.deepEqual(brokenRelativeImports(moduleFiles, makeExists(files)), []);
  });

  await t.test("reports a missing target (the 3.0.0 failure mode)", () => {
    // commands/autotune.mjs ships, but src/autotune/* does NOT (missing from
    // the files allowlist). This is exactly the 3.0.0 break.
    const files = new Set(["src/commands/autotune.mjs"]);
    const moduleFiles = [
      {
        path: "src/commands/autotune.mjs",
        content: `import { probe } from "../autotune/probe.mjs";`,
      },
    ];
    const broken = brokenRelativeImports(moduleFiles, makeExists(files));
    assert.equal(broken.length, 1);
    assert.equal(broken[0].file, "src/commands/autotune.mjs");
    assert.equal(broken[0].spec, "../autotune/probe.mjs");
  });

  await t.test("resolves extensionless imports via .mjs/.js/.json/index", () => {
    const files = new Set([
      "src/foo.mjs",
      "src/bar.js",
      "src/baz.json",
      "src/pkg/index.mjs",
    ]);
    const moduleFiles = [
      {
        path: "src/main.mjs",
        content: `
          import "./foo";
          import "./bar";
          import "./baz";
          import "./pkg";
        `,
      },
      { path: "src/foo.mjs", content: "" },
      { path: "src/bar.js", content: "" },
      { path: "src/baz.json", content: "" },
      { path: "src/pkg/index.mjs", content: "" },
    ];
    assert.deepEqual(brokenRelativeImports(moduleFiles, makeExists(files)), []);
  });

  await t.test("resolves ../ that climbs above then back down", () => {
    const files = new Set(["a/b/c.mjs", "a/x.mjs"]);
    const moduleFiles = [
      { path: "a/b/c.mjs", content: `import "../x.mjs";` },
      { path: "a/x.mjs", content: "" },
    ];
    assert.deepEqual(brokenRelativeImports(moduleFiles, makeExists(files)), []);
  });

  await t.test("ignores bare specifiers entirely (resolved via npm install)", () => {
    const files = new Set(["src/main.mjs"]);
    const moduleFiles = [
      { path: "src/main.mjs", content: `import picocolors from "picocolors";` },
    ];
    assert.deepEqual(brokenRelativeImports(moduleFiles, makeExists(files)), []);
  });

  await t.test("reports dynamic import() of a missing target", () => {
    const files = new Set(["src/main.mjs"]);
    const moduleFiles = [
      { path: "src/main.mjs", content: `const m = await import("./missing.mjs");` },
    ];
    const broken = brokenRelativeImports(moduleFiles, makeExists(files));
    assert.equal(broken.length, 1);
    assert.equal(broken[0].spec, "./missing.mjs");
  });

  await t.test("one missing, one present — reports only the missing one", () => {
    const files = new Set(["src/main.mjs", "src/present.mjs"]);
    const moduleFiles = [
      {
        path: "src/main.mjs",
        content: `
          import { p } from "./present.mjs";
          import { x } from "./absent.mjs";
        `,
      },
      { path: "src/present.mjs", content: "" },
    ];
    const broken = brokenRelativeImports(moduleFiles, makeExists(files));
    assert.deepEqual(broken, [{ file: "src/main.mjs", spec: "./absent.mjs" }]);
  });
});
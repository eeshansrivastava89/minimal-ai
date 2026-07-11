#!/usr/bin/env node
// Verifies that every named import across the codebase actually exists
// in the source module's exports. Catches the "imported from wrong module"
// bug class that ESLint's no-undef doesn't cover.
//
// Usage: node scripts/verify-imports.mjs
// Exit 0 = all imports valid, exit 1 = at least one broken import.

import { readdirSync, readFileSync } from "node:fs";
import { join, dirname, relative } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "src");
let errors = 0;

// 1. Collect all exports per module
const exportsMap = new Map(); // absolute path -> Set of export names

function collectExports(dir) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      collectExports(join(dir, entry.name));
      continue;
    }
    if (!entry.name.endsWith(".mjs")) continue;
    const filePath = join(dir, entry.name);
    const source = readFileSync(filePath, "utf8");
    const names = new Set();

    // export function foo, export async function foo
    for (const m of source.matchAll(/export\s+(?:async\s+)?function\s+(\w+)/g)) names.add(m[1]);
    // export const foo, export let foo, export var foo
    for (const m of source.matchAll(/export\s+(?:const|let|var)\s+(\w+)/g)) names.add(m[1]);
    // export { foo, bar } from "..."  (re-export)
    for (const m of source.matchAll(/export\s+\{([^}]+)\}\s+from\s+["']([^"']+)["']/g)) {
      for (const name of m[1].split(",").map((s) => s.trim().split(/\s+as\s+/)[0].trim()).filter(Boolean)) {
        names.add(name);
      }
    }
    // export { foo, bar } (local re-export)
    for (const m of source.matchAll(/export\s+\{([^}]+)\}/g)) {
      if (!source.slice(m.index, m.index + 100).includes("from ")) {
        for (const name of m[1].split(",").map((s) => s.trim().split(/\s+as\s+/)[0].trim()).filter(Boolean)) {
          names.add(name);
        }
      }
    }

    exportsMap.set(filePath, names);
  }
}

collectExports(ROOT);

// 2. Collect all named imports and verify
function checkImports(dir) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      checkImports(join(dir, entry.name));
      continue;
    }
    if (!entry.name.endsWith(".mjs")) continue;
    const filePath = join(dir, entry.name);
    const source = readFileSync(filePath, "utf8");

    // import { foo, bar } from "./path.mjs"
    for (const m of source.matchAll(/import\s+\{([^}]+)\}\s+from\s+["']([^"']+)["']/g)) {
      const importNames = m[1].split(",").map((s) => s.trim().split(/\s+as\s+/)[0].trim()).filter(Boolean);
      const importPath = m[2];

      // Skip node: builtins and npm packages
      if (importPath.startsWith("node:") || !importPath.startsWith(".")) continue;

      // Resolve relative to the importing file
      const resolvedPath = join(dirname(filePath), importPath);
      const exportedNames = exportsMap.get(resolvedPath);

      if (!exportedNames) {
        console.error(`✗ ${relative(ROOT, filePath)}: imports from ${importPath} but module not found at ${resolvedPath}`);
        errors++;
        continue;
      }

      for (const name of importNames) {
        if (!exportedNames.has(name)) {
          console.error(`✗ ${relative(ROOT, filePath)}: imports "${name}" from ${importPath} but it is not exported`);
          errors++;
        }
      }
    }
  }
}

checkImports(ROOT);

if (errors > 0) {
  console.error(`\n${errors} broken import(s) found.`);
  process.exit(1);
} else {
  console.log("All named imports verified — no broken bindings.");
}
#!/usr/bin/env node
import { readdirSync, readFileSync } from "node:fs";
import { join, dirname, relative } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "src");
let errors = 0;

const exportsMap = new Map();

function readSource(filePath) {
  try {
    return readFileSync(filePath, "utf8");
  } catch {
    return null;
  }
}

function parseExports(source, filePath) {
  const names = new Set();
  const starExports = [];

  for (const m of source.matchAll(/export\s+class\s+(\w+)/g)) names.add(m[1]);
  for (const m of source.matchAll(/export\s+(?:async\s+)?function\s+(\w+)/g)) names.add(m[1]);
  for (const m of source.matchAll(/export\s+(?:const|let|var)\s+(\w+)/g)) names.add(m[1]);
  for (const m of source.matchAll(/export\s*\{([^}]*)\}\s*from\s*["']([^"']+)["']/g)) {
    for (const name of m[1].split(",").map((s) => s.trim().split(/\s+as\s+/)[0].trim()).filter(Boolean)) {
      names.add(name);
    }
  }
  for (const m of source.matchAll(/export\s*\{([^}]*)\}/g)) {
    if (!source.slice(m.index, m.index + 100).includes("from ")) {
      for (const name of m[1].split(",").map((s) => s.trim().split(/\s+as\s+/)[0].trim()).filter(Boolean)) {
        names.add(name);
      }
    }
  }
  for (const m of source.matchAll(/export\s+\*\s+from\s*["']([^"']+)["']/g)) {
    starExports.push({ path: m[1], filePath });
  }

  return { names, starExports };
}

function collectExports(dir) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      collectExports(join(dir, entry.name));
      continue;
    }
    if (!entry.name.endsWith(".mjs")) continue;
    const filePath = join(dir, entry.name);
    const source = readSource(filePath);
    if (!source) continue;
    exportsMap.set(filePath, parseExports(source, filePath));
  }
}

function resolveStar(specifier, fromFilePath) {
  if (specifier.startsWith(".")) {
    return join(dirname(fromFilePath), specifier);
  }
  try {
    const resolved = import.meta.resolve(specifier, pathToFileURL(fromFilePath).href);
    if (resolved.startsWith("file://")) return fileURLToPath(resolved);
  } catch {
    // fall through
  }
  return null;
}

function resolveAllExports(filePath, visited = new Set()) {
  if (visited.has(filePath)) return new Set();
  visited.add(filePath);
  const entry = exportsMap.get(filePath);
  if (!entry) {
    // Try to read and parse the file dynamically (e.g. external package)
    const source = readSource(filePath);
    if (!source) return new Set();
    const parsed = parseExports(source, filePath);
    const all = new Set(parsed.names);
    for (const star of parsed.starExports) {
      const target = resolveStar(star.path, star.filePath);
      if (target) for (const name of resolveAllExports(target, visited)) all.add(name);
    }
    return all;
  }
  const all = new Set(entry.names);
  for (const star of entry.starExports) {
    const target = resolveStar(star.path, star.filePath);
    if (target) for (const name of resolveAllExports(target, visited)) all.add(name);
  }
  return all;
}

collectExports(ROOT);

const resolvedExportsMap = new Map();
for (const [path] of exportsMap) {
  resolvedExportsMap.set(path, resolveAllExports(path));
}

function checkImports(dir) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      checkImports(join(dir, entry.name));
      continue;
    }
    if (!entry.name.endsWith(".mjs")) continue;
    const filePath = join(dir, entry.name);
    const source = readFileSync(filePath, "utf8");

    for (const m of source.matchAll(/import\s+\{([^}]+)\}\s*from\s*["']([^"']+)["']/g)) {
      const importNames = m[1].split(",").map((s) => s.trim().split(/\s+as\s+/)[0].trim()).filter(Boolean);
      const importPath = m[2];

      if (importPath.startsWith("node:") || !importPath.startsWith(".")) continue;

      const resolvedPath = join(dirname(filePath), importPath);
      const exportedNames = resolvedExportsMap.get(resolvedPath);

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

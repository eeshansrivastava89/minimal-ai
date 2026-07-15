import { realpathSync } from "node:fs";
import { realpath } from "node:fs/promises";
import { basename, dirname, join, parse, relative, resolve } from "node:path";

/**
 * Resolve the canonical absolute path of `target`, tolerating a missing
 * tail component. Walks up until an existing ancestor is found, resolves
 * it with realpath, then rejoins the missing remainder. Falls back to the
 * lexical absolute path when no ancestor exists.
 *
 * Sync variant — used by config.mjs for the data-dir safety check at startup.
 */
export function resolvedPathAllowMissingSync(target) {
  try {
    return realpathSync(target);
  } catch {
    let current = resolve(target);
    const targetPath = resolve(target);
    const root = parse(current).root;
    while (current !== root) {
      try {
        return join(realpathSync(current), relative(current, targetPath));
      } catch {
        const parent = resolve(current, "..");
        if (parent === current) break;
        current = parent;
      }
    }
    return targetPath;
  }
}

/**
 * Async variant of resolvedPathAllowMissingSync — used by models-delete.mjs
 * where the deletion target may not yet exist and fs/promises is the norm.
 */
export async function resolvedPathAllowMissing(target) {
  const missingTail = [];
  let current = resolve(target);
  while (true) {
    try {
      const canonical = await realpath(current);
      return join(canonical, ...missingTail.reverse());
    } catch (error) {
      if (error?.code !== "ENOENT") return null;
      const parent = dirname(current);
      if (parent === current) return null;
      missingTail.push(basename(current));
      current = parent;
    }
  }
}
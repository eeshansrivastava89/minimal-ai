import { isAbsolute, normalize, resolve, sep } from "node:path";

export function assertSafeRunAssetPath(asset: string): string {
  const normalized = normalize(asset);

  if (
    normalized.length === 0 ||
    normalized === "." ||
    isAbsolute(normalized) ||
    normalized === ".." ||
    normalized.startsWith(`..${sep}`) ||
    normalized.includes(`${sep}..${sep}`) ||
    normalized.endsWith(`${sep}..`)
  ) {
    throw new Error("Asset path must stay inside a run folder.");
  }

  return normalized;
}

export function resolveRunAssetPath(runDirectory: string, asset: string): string {
  const safeAsset = assertSafeRunAssetPath(asset);
  const assetPath = resolve(runDirectory, safeAsset);

  if (!isPathInside(assetPath, resolve(runDirectory))) {
    throw new Error("Asset path must stay inside a run folder.");
  }

  return assetPath;
}

export function assertSafePathSegment(segment: string, label = "Path segment"): string {
  if (!/^[A-Za-z0-9._-]+$/u.test(segment) || segment === "." || segment === "..") {
    throw new Error(`${label} must be a safe filename segment.`);
  }

  return segment;
}

export function isPathInside(path: string, root: string): boolean {
  return path === root || path.startsWith(`${root}${sep}`);
}

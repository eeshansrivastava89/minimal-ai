// Hardware detection — pure functions, no side effects.
// Ported from deprecated-offgrid-desktop/src/main/hardware.ts.
//
// Used by mlx-vlm backend selection (Apple Silicon → mlx-vlm) and by memory
// estimation. offgrid-ai previously had no dedicated hardware module; this is
// the canonical source for hardware facts the model-serving logic needs.

import { totalmem } from "node:os";
import { statfsSync, existsSync } from "node:fs";
import { dirname } from "node:path";

/**
 * Detect system hardware via the Node.js `os` module.
 * Pure function — no side effects, trivially testable.
 */
export function detectHardware() {
  return {
    totalRamBytes: totalmem(),
    platform: process.platform,
    arch: process.arch,
  };
}

/**
 * Get available disk space for a directory (in bytes).
 *
 * If the directory doesn't exist yet, walks up to the nearest existing parent
 * directory. Returns a very large number if the check fails (so we don't block
 * a download unnecessarily).
 */
export function getFreeDiskBytes(dir) {
  try {
    let checkDir = dir;
    while (!existsSync(checkDir)) {
      const parent = dirname(checkDir);
      if (parent === checkDir) break; // reached root
      checkDir = parent;
    }
    const stats = statfsSync(checkDir);
    return stats.bavail * stats.bsize;
  } catch {
    return Number.MAX_SAFE_INTEGER;
  }
}
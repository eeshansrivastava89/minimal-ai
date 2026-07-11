// Hardware detection — pure functions, no side effects.
// Ported from deprecated-offgrid-desktop/src/main/hardware.ts.
//
// This is the canonical source for hardware facts the model-serving logic
// needs: recommendations, onboarding, MLX context sizing, disk-space guards,
// and memory estimation.

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

/** Installed RAM in GB (integer). */
export function installedRamGB() {
  return Math.round(totalmem() / (1024 ** 3));
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
    return 0;
  }
}
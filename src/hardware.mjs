// Hardware detection — pure functions, no side effects.
// Ported from deprecated-offgrid-desktop/src/main/hardware.ts.
//
// This is the canonical source for hardware facts the model-serving logic
// needs: recommendations, onboarding, MLX context sizing, disk-space guards,
// and memory estimation.

import { totalmem, freemem, platform } from "node:os";
import { execFileSync } from "node:child_process";
import { statfsSync, existsSync } from "node:fs";
import { dirname } from "node:path";

/** One gigabyte in bytes. Single source of truth for all GB-based math. */
export const GB = 1024 ** 3;

/** Memory fit thresholds (ratio of total estimate vs available RAM). */
const FIT_GREEN = 0.70;  // ≤ 70% of available RAM = comfortable
const FIT_YELLOW = 0.90; // ≤ 90% = tight, may work

/**
 * Check whether a memory estimate fits in available RAM.
 * Returns "fits", "tight", or "won't fit" — the single canonical fit check
 * used by the quant picker, heatmap, and memory estimate display.
 *
 * @param {number} totalBytes - total estimated memory (model + KV + overhead)
 * @param {number} availableBytes - available RAM (from availableRamBytes())
 * @returns {{ status: "fits"|"tight"|"won't fit", ratio: number }}
 */
export function fitCheck(totalBytes, availableBytes) {
  const ratio = totalBytes / availableBytes;
  if (ratio <= FIT_GREEN) return { status: "fits", ratio };
  if (ratio <= FIT_YELLOW) return { status: "tight", ratio };
  return { status: "won't fit", ratio };
}

/**
 * Detect system hardware via the Node.js `os` module.
 * Pure function — no side effects, trivially testable.
 */
export function detectHardware() {
  return {
    totalRamBytes: totalmem(),
    availableRamBytes: availableRamBytes(),
    platform: process.platform,
    arch: process.arch,
  };
}

/** Installed RAM in GB (integer). */
export function installedRamGB() {
  return Math.round(totalmem() / GB);
}

/**
 * Estimate actually available RAM for model loading.
 *
 * Node's `freemem()` only counts truly-free pages. On macOS, the OS
 * aggressively uses RAM for file cache (inactive/purgeable pages) that can
 * be reclaimed, so `freemem()` is far too conservative. We use `vm_stat`
 * on macOS to get free + inactive + purgeable + speculative pages.
 *
 * On Linux, `freemem()` from /proc/meminfo's MemAvailable is already
 * reasonable (it includes reclaimable cache). On other platforms we fall
 * back to `freemem()` floored at a sensible minimum.
 */
export function availableRamBytes() {
  if (platform() === "darwin") {
    try {
      const output = execFileSync("vm_stat", { encoding: "utf8", timeout: 2000 });
      const pageSizeMatch = output.match(/page size of (\d+)/);
      const pageSize = Number(pageSizeMatch?.[1] ?? 16384);
      const extract = (label) => {
        const m = output.match(new RegExp(`${label}:\\s+(\\d+)`));
        return m ? Number(m[1]) * pageSize : 0;
      };
      const free = extract("Pages free");
      const inactive = extract("Pages inactive");
      const speculative = extract("Pages speculative");
      const purgeable = extract("Pages purgeable");
      const available = free + inactive + speculative + purgeable;
      if (available > 0) return available;
    } catch { /* fall through */ }
  }
  // Linux: freemem() reads MemAvailable which includes reclaimable cache.
  // Fallback: use freemem() but floor at 1GB so we don't show 0 on busy systems.
  return Math.max(freemem(), 1 * GB);
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
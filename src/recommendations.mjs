import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { detectHardware } from "./hardware.mjs";

const GB = 1024 ** 3;

const RECOMMENDATIONS_PATH = join(dirname(fileURLToPath(import.meta.url)), "..", "resources", "recommendations.json");

function loadRecommendations() {
  try {
    const raw = readFileSync(RECOMMENDATIONS_PATH, "utf8");
    return JSON.parse(raw).models ?? [];
  } catch {
    return [];
  }
}

/** All curated model entries. */
export function getModelEntries() {
  return loadRecommendations();
}

/** Recommend models that fit the detected hardware (max tier first). */
export function recommendModels(hardware) {
  const entries = loadRecommendations();
  const fitting = entries.filter((e) => e.minRamGb * GB <= hardware.totalRamBytes);
  if (fitting.length === 0) return [];
  const maxTier = Math.max(...fitting.map((e) => e.minRamGb));
  // All models at the top fitting tier are genuine alternatives; sort by label
  // so the pick is deterministic regardless of JSON order.
  return fitting
    .filter((e) => e.minRamGb === maxTier)
    .sort((a, b) => a.label.localeCompare(b.label));
}

/** Pick the best format for the platform. */
export function selectFormat(entry, hardware) {
  if (hardware.platform === "darwin" && hardware.arch === "arm64") {
    if (entry.mlx) return "mlx";
    if (entry.gguf) return "gguf";
  } else {
    if (entry.gguf) return "gguf";
  }
  return null;
}

/** Primary recommendation for this machine. */
export function recommendedModel(hardware) {
  const fitting = recommendModels(hardware ?? detectHardware());
  return fitting[0] ?? null;
}

/** All models that fit, sorted best-first (tier desc, then label). */
export function allFittingModels(hardware) {
  const entries = loadRecommendations();
  const fitting = entries.filter((e) => e.minRamGb * GB <= hardware.totalRamBytes);
  return fitting.sort((a, b) => b.minRamGb - a.minRamGb || a.label.localeCompare(b.label));
}

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

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

/** All models that fit, sorted best-first (tier desc, then label). */
export function allFittingModels(hardware) {
  const entries = loadRecommendations();
  const fitting = entries.filter((e) => e.minRamGb * GB <= hardware.totalRamBytes);
  return fitting.sort((a, b) => b.minRamGb - a.minRamGb || a.label.localeCompare(b.label));
}

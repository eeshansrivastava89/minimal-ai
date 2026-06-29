import { totalmem } from "node:os";
export { hasHuggingfaceHub, resolveHfDownload, downloadToHfCache } from "./huggingface.mjs";
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
  return fitting.filter((e) => e.minRamGb === maxTier);
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

/** All models that fit, sorted best-first. */
export function allFittingModels(hardware) {
  const entries = loadRecommendations();
  const fitting = entries.filter((e) => e.minRamGb * GB <= hardware.totalRamBytes);
  return fitting.sort((a, b) => b.minRamGb - a.minRamGb);
}

export function detectHardware() {
  return {
    totalRamBytes: totalmem(),
    platform: process.platform,
    arch: process.arch,
  };
}

export function installedRamGB() {
  return (totalmem() / (1024 ** 3)).toFixed(0);
}

/** @deprecated use recommendedModel(hardware) for platform-aware selection. */
export function legacyRecommendedModel() {
  const gb = totalmem() / (1024 ** 3);
  const tiers = [
    { maxGB: 8, label: "Gemma 4 E2B (2B effective)" },
    { maxGB: 16, label: "Gemma 4 E4B (4B effective)" },
    { maxGB: 32, label: "Qwen 3.5 9B" },
    { maxGB: Infinity, label: "Qwen 3.6 35B-A3B" },
  ];
  return tiers.find((tier) => gb <= tier.maxGB) ?? tiers[tiers.length - 1];
}

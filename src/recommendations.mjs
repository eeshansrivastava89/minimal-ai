import { totalmem } from "node:os";

const MODEL_TIERS = [
  { maxGB: 8, lms: "google/gemma-4-e2b", ollama: "gemma4:e2b", label: "Gemma 4 E2B (2B effective)" },
  { maxGB: 16, lms: "google/gemma-4-e4b", ollama: "gemma4:e4b", label: "Gemma 4 E4B (4B effective)" },
  { maxGB: 32, lms: "qwen/qwen3.5-9b", ollama: "qwen3.5:9b-q4_K_M", label: "Qwen 3.5 9B" },
  { maxGB: Infinity, lms: "qwen/qwen3.6-35b-a3b", ollama: "qwen3.6:35b-a3b", label: "Qwen 3.6 35B-A3B" },
];

export function recommendedModel() {
  const gb = totalmem() / (1024 ** 3);
  return MODEL_TIERS.find((tier) => gb <= tier.maxGB) ?? MODEL_TIERS[MODEL_TIERS.length - 1];
}

export function installedRamGB() {
  return (totalmem() / (1024 ** 3)).toFixed(0);
}

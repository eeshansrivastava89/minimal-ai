import { BACKENDS } from "./backends.mjs";
import { omlxEnabled, ollamaEnabled } from "./config.mjs";

export async function scanManagedModels() {
  const enabledBackends = [];
  if (await omlxEnabled()) enabledBackends.push("omlx");
  if (await ollamaEnabled()) enabledBackends.push("ollama");
  if (enabledBackends.length === 0) return [];
  const results = [];
  for (const backendId of enabledBackends) {
    const backend = BACKENDS[backendId];
    try {
      const models = await backend.scanModels();
      results.push({ backendId, models, status: "ok" });
    } catch (error) {
      results.push({ backendId, models: [], status: "unavailable", reason: error?.message ?? String(error) });
    }
  }
  return results;
}
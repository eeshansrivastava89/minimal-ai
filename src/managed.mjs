import { BACKENDS } from "./backends.mjs";

export async function scanManagedModels() {
  const results = [];
  for (const backendId of ["omlx", "ollama"]) {
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
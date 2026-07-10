import { BACKENDS } from "./backends.mjs";
import { omlxEnabled } from "./config.mjs";

const MANAGED_BACKEND_IDS = ["omlx"];

export async function scanManagedModels() {
  if (!(await omlxEnabled())) return [];
  const results = [];
  for (const backendId of MANAGED_BACKEND_IDS) {
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

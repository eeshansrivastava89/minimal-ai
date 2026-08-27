import { managedBackends } from "./backends.mjs";

export async function scanManagedModels() {
  const results = [];
  for (const backend of managedBackends()) {
    try {
      const models = await backend.scanModels();
      results.push({ backendId: backend.id, models, status: "ok" });
    } catch (error) {
      results.push({ backendId: backend.id, models: [], status: "unavailable", reason: error?.message ?? String(error) });
    }
  }
  return results;
}
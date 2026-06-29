import { existsSync } from "node:fs";
import { BACKENDS } from "./backends.mjs";
import { commandExists } from "./exec.mjs";

export const MANAGED_BACKEND_IDS = ["omlx"];

export async function scanManagedModels() {
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

export function hasLmStudioInstalled() {
  return existsSync("/Applications/LM Studio.app");
}

export function hasOmlxInstalled() {
  return commandExists("omlx");
}

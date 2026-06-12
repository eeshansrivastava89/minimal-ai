import { existsSync } from "node:fs";
import { BACKENDS } from "./backends.mjs";
import { commandExists } from "./exec.mjs";

export const MANAGED_BACKEND_IDS = ["ollama", "omlx"];

export async function scanManagedModels() {
  const results = [];
  for (const backendId of MANAGED_BACKEND_IDS) {
    const backend = BACKENDS[backendId];
    try {
      const models = await backend.scanModels();
      results.push({ backendId, models });
    } catch {
      // Managed backends are optional and may not be running.
    }
  }
  return results;
}

export function hasLmStudioInstalled() {
  return existsSync("/Applications/LM Studio.app");
}

export function hasOllamaInstalled() {
  return commandExists("ollama");
}

export function hasOmlxInstalled() {
  return commandExists("omlx");
}

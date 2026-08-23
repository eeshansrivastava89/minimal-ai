import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import YAML from "yaml";
import { commandExists } from "./exec.mjs";
import {
  launchModel,
  modelDescriptor,
  providerHasModel,
  removeProviderModel,
  syncProviderConfig,
} from "./harness-shared.mjs";

const OMP_CONFIG = join(homedir(), ".omp", "agent", "models.yml");

// omp (oh-my-pi, a Pi fork) drives thinking via top-level reasoning_effort.
// Wire-verified 2026-08: oMLX reads it (levels work); llama.cpp ignores it
// (needs chat_template_kwargs, which omp can't send per-request); Ollama's
// /v1 ignores every thinking field. So we only advertise reasoning for oMLX
// models — showing thinking controls that provably do nothing is how the
// Ollama/Pi bug happened.
function ompReasoning(profile) {
  if (profile.backend !== "omlx") return false;
  return modelDescriptor(profile).thinking === true;
}

function ompModelConfig(profile) {
  const base = modelDescriptor(profile);
  return {
    id: base.id,
    name: base.name,
    reasoning: ompReasoning(profile),
    input: base.input,
    maxTokens: base.maxTokens,
    ...(base.contextWindow ? { contextWindow: base.contextWindow } : {}),
    cost: base.cost,
  };
}

async function readOmpConfig() {
  if (!existsSync(OMP_CONFIG)) return { providers: {} };
  const parsed = YAML.parse(await readFile(OMP_CONFIG, "utf8"));
  const config = parsed && typeof parsed === "object" ? parsed : {};
  config.providers ??= {};
  return config;
}

async function writeOmpConfig(config) {
  await mkdir(join(homedir(), ".omp", "agent"), { recursive: true });
  await writeFile(OMP_CONFIG, YAML.stringify(config), "utf8");
}

const OMP_IO = {
  configPath: OMP_CONFIG,
  readConfig: readOmpConfig,
  writeConfig: writeOmpConfig,
};

export const ompHarness = {
  id: "omp",
  label: "oh-my-pi",
  bin: "omp",
  npm: "@oh-my-pi/pi-coding-agent",
  thinking: "reasoning-effort",
  modelConfig: ompModelConfig,

  async detect() {
    return await commandExists(this.bin);
  },

  async syncConfig(profile) {
    await syncProviderConfig(this, profile, OMP_IO);
  },

  async removeModel(profile) {
    return await removeProviderModel(this, profile, OMP_IO);
  },

  async hasModel(profile) {
    return await providerHasModel(profile, OMP_IO);
  },

  async launch(profile, options = {}) {
    await launchModel(this, profile, options);
  },
};

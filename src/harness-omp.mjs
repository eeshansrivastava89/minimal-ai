import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import YAML from "yaml";
import { commandExists } from "./exec.mjs";
import { status, theme } from "./ui.mjs";
import {
  activeProviderProfiles,
  harnessModelRef,
  modelDescriptor,
  providerCompat,
  runForeground,
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

export const ompHarness = {
  id: "omp",
  label: "oh-my-pi",
  bin: "omp",
  npm: "@oh-my-pi/pi-coding-agent",
  thinking: "reasoning-effort",

  async detect() {
    return await commandExists(this.bin);
  },

  async syncConfig(profile) {
    const profiles = await activeProviderProfiles(profile);
    const config = await readOmpConfig();
    config.providers[profile.providerId] = {
      baseUrl: profile.baseUrl,
      api: "openai-completions",
      apiKey: "none",
      compat: providerCompat(),
      models: profiles.map(ompModelConfig),
    };
    await writeOmpConfig(config);
    console.log(status({ kind: "success", message: `Synced omp config: ${OMP_CONFIG} (${profiles.length} model${profiles.length === 1 ? "" : "s"})` }));
  },

  async removeModel(profile) {
    const config = await readOmpConfig();
    const provider = config.providers[profile.providerId];
    if (!provider?.models) return { cleaned: false, reason: `no ${profile.providerId} provider in omp config` };
    const before = provider.models.length;
    provider.models = provider.models.filter((m) => m.id !== profile.modelAlias);
    if (provider.models.length === 0) delete config.providers[profile.providerId];
    if (before > provider.models.length) {
      await writeOmpConfig(config);
      return { cleaned: true, removed: before - provider.models.length };
    }
    return { cleaned: false, reason: `${profile.modelAlias} not in omp config` };
  },

  async hasModel(profile) {
    if (!existsSync(OMP_CONFIG)) return false;
    const config = await readOmpConfig();
    return Boolean(config.providers?.[profile.providerId]?.models?.some?.((m) => m.id === profile.modelAlias));
  },

  async launch(profile, { cwd, message } = {}) {
    const model = harnessModelRef(profile);
    const args = ["--model", model];
    if (message) args.push(message);
    console.log(theme.bold(`[omp] omp --model ${model}`));
    await runForeground(this.bin, args, { cwd });
  },
};

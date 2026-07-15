import { existsSync } from "node:fs";
import { cp, readdir, mkdir } from "node:fs/promises";
import { spawn } from "node:child_process";
import { homedir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { PI_CONFIG } from "./config.mjs";
import { loadProfiles } from "./profiles.mjs";
import { readJson, writeJson } from "./json.mjs";
import { execCommand, commandExists } from "./exec.mjs";
import pc from "picocolors";

const RESOURCES_DIR = join(dirname(fileURLToPath(import.meta.url)), "..", "resources");
const PI_DIR = join(homedir(), ".pi");
const PI_AGENT_DIR = join(PI_DIR, "agent");
const PI_SETTINGS = join(PI_AGENT_DIR, "settings.json");
const PI_SKILLS_DIR = join(PI_AGENT_DIR, "skills");
const PI_WEB_SEARCH = join(PI_DIR, "web-search.json");

// Pi packages to install for a good out-of-box experience
const PI_PACKAGES = [
  "npm:pi-web-access",
  "npm:pi-powerline-footer",
  "npm:pi-smart-fetch",
];

// ── Pi model id ─────────────────────────────────────────────────────────────

/**
 * The model id Pi must send in requests. All backends use the friendly
 * modelAlias as the API model id.
 */
export function piApiModelId(profile) {
  return profile.modelAlias;
}

// ── Sync Pi config ─────────────────────────────────────────────────────────

export async function syncPiConfig(profile) {
  const profiles = await activeProviderProfiles(profile);
  const config = await readJson(PI_CONFIG, { providers: {} });
  config.providers ??= {};
  config.providers[profile.providerId] = {
    baseUrl: profile.baseUrl,
    api: "openai-completions",
    apiKey: piApiKey(),
    compat: providerCompat(),
    models: profiles.map(piModelConfig),
  };
  await writeJson(PI_CONFIG, config);
  console.log(pc.green(`Synced Pi config: ${PI_CONFIG} (${profiles.length} model${profiles.length === 1 ? "" : "s"})`));
}

// ── Remove from Pi config ──────────────────────────────────────────────────

export async function removeFromPiConfig(profile) {
  const config = await readJson(PI_CONFIG, { providers: {} });
  config.providers ??= {};
  const provider = config.providers[profile.providerId];
  if (!provider?.models) return { cleaned: false, reason: `no ${profile.providerId} provider in Pi config` };
  const before = provider.models.length;
  const apiId = piApiModelId(profile);
  provider.models = provider.models.filter((m) => m.id !== apiId);
  if (provider.models.length === 0) delete config.providers[profile.providerId];
  if (before > provider.models.length) {
    await writeJson(PI_CONFIG, config);
    return { cleaned: true, removed: before - provider.models.length };
  }
  return { cleaned: false, reason: `${apiId} not in Pi config` };
}

// ── Check if Pi has the model ──────────────────────────────────────────────

export async function hasPiModel(profile) {
  const config = await readJson(PI_CONFIG, null);
  return Boolean(config?.providers?.[profile.providerId]?.models?.some?.((m) => m.id === piApiModelId(profile)));
}

// ── Launch Pi ──────────────────────────────────────────────────────────────

export async function launchPi(profile) {
  const model = `${profile.providerId}/${piApiModelId(profile)}`;
  console.log(pc.bold(`[pi] pi --model ${model}`));
  await runForeground("pi", ["--model", model]);
}

// ── Check if Pi is installed ───────────────────────────────────────────────

export async function hasPi() {
  return await commandExists("pi");
}

// ── Pi setup (skills, packages, web-search) ───────────────────────────────

/**
 * Set up Pi with bundled skills, npm packages, and web-search config.
 * Called after Pi is installed during onboarding. Idempotent — skips skills
 * and web-search config that already exist (preserving user edits), installs missing packages.
 */
export async function setupPiConfig() {
  let configured = 0;

  // 1. Copy bundled skills to ~/.pi/agent/skills/
  const bundledSkillsDir = join(RESOURCES_DIR, "skills");
  if (existsSync(bundledSkillsDir)) {
    try {
      const skills = await readdir(bundledSkillsDir, { withFileTypes: true });
      await mkdir(PI_SKILLS_DIR, { recursive: true });
      for (const entry of skills) {
        if (!entry.isDirectory()) continue;
        const src = join(bundledSkillsDir, entry.name);
        const dest = join(PI_SKILLS_DIR, entry.name);
        if (!existsSync(dest)) await cp(src, dest, { recursive: true });
      }
      console.log(pc.green(`✓ Pi skills installed (${skills.filter(s => s.isDirectory()).length} skills)`));
      configured++;
    } catch (err) {
      console.log(pc.yellow(`  Could not copy Pi skills: ${err.message}`));
    }
  }

  // 2. Install Pi packages (web access, powerline footer, smart fetch)
  for (const pkg of PI_PACKAGES) {
    try {
      await execCommand("pi", ["install", pkg], { label: pkg, verbose: true });
      configured++;
    } catch (err) {
      console.log(pc.dim(`  Skipped ${pkg}: ${err.message}`));
    }
  }

  // 3. Copy web-search.json
  const bundledWebSearch = join(RESOURCES_DIR, "web-search.json");
  if (existsSync(bundledWebSearch)) {
    try {
      const { readFile, writeFile } = await import("node:fs/promises");
      const content = await readFile(bundledWebSearch, "utf8");
      if (!existsSync(PI_WEB_SEARCH)) await writeFile(PI_WEB_SEARCH, content, "utf8");
      console.log(pc.green("✓ Pi web-search config installed"));
      configured++;
    } catch (err) {
      console.log(pc.yellow(`  Could not copy web-search config: ${err.message}`));
    }
  }

  // 4. Enable skill commands in settings.json
  try {
    const settings = await readJson(PI_SETTINGS, {});
    if (!settings.enableSkillCommands) {
      settings.enableSkillCommands = true;
      await writeJson(PI_SETTINGS, settings);
    }
  } catch (err) {
    console.log(pc.dim(`  Could not enable skill commands: ${err.message}`));
  }

  if (configured > 0) {
    console.log(pc.green(`✓ Pi configured (${configured} items set up)`));
  }
}

// ── Internals ──────────────────────────────────────────────────────────────

async function activeProviderProfiles(currentProfile) {
  const allProfiles = await loadProfiles();
  const byAlias = new Map();
  for (const item of [...allProfiles, currentProfile]) {
    if (item.providerId !== currentProfile.providerId) continue;
    if (item.backend !== "llama-cpp") {
      byAlias.set(item.modelAlias, item);
      continue;
    }
    if (!item.modelPath || !existsSync(item.modelPath)) continue;
    byAlias.set(item.modelAlias, item);
  }
  return Array.from(byAlias.values()).sort((a, b) => a.modelAlias.localeCompare(b.modelAlias));
}

function piModelConfig(profile) {
  const compat = modelCompat(profile);
  const reasoning = modelReasoning(profile);
  return {
    id: piApiModelId(profile),
    name: profile.label,
    input: modelInput(profile),
    maxTokens: profile.flags?.ctxSize ?? 16384,
    ...(reasoning === undefined ? {} : { reasoning }),
    ...(compat ? { compat } : {}),
    ...(profile.flags?.ctxSize ? { contextWindow: profile.flags.ctxSize } : {}),
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  };
}

function modelInput(profile) {
  if (profile.mmprojPath && existsSync(profile.mmprojPath)) return ["text", "image"];
  if (profile.capabilities?.vision) return ["text", "image"];
  return ["text"];
}

function modelCompat(profile) {
  if (profile.compat) return profile.compat;
  const family = modelFamily(profile);
  if (family.includes("qwen") || family.includes("gemma-4") || family.includes("gemma 4")) {
    return { thinkingFormat: "qwen-chat-template" };
  }
  return null;
}

function modelReasoning(profile) {
  return profile.capabilities?.thinking === true ? true : undefined;
}

function modelFamily(profile) {
  return [profile.id, profile.label, profile.modelAlias, profile.omlxModel, profile.ollamaModel].filter(Boolean).join(" ").toLowerCase();
}

function piApiKey() {
  return "none";
}

function providerCompat() {
  return { supportsDeveloperRole: false, supportsReasoningEffort: false, maxTokensField: "max_tokens" };
}

function runForeground(cmd, argv) {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, argv, { stdio: "inherit" });
    child.on("error", reject);
    child.on("exit", (code) => code === 0 ? resolve() : reject(new Error(`${cmd} exited with code ${code}`)));
  });
}
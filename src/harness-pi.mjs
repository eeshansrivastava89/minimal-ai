import { existsSync } from "node:fs";
import { cp, readdir, mkdir } from "node:fs/promises";
import { homedir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { readJson, writeJson } from "./json.mjs";
import { execCommand, commandExists } from "./exec.mjs";
import { status, theme } from "./ui.mjs";
import {
  activeProviderProfiles,
  harnessModelRef,
  modelDescriptor,
  modelFamily,
  providerCompat,
  runForeground,
} from "./harness-shared.mjs";

const RESOURCES_DIR = join(dirname(fileURLToPath(import.meta.url)), "..", "resources");
const PI_DIR = join(homedir(), ".pi");
const PI_AGENT_DIR = join(PI_DIR, "agent");
const PI_CONFIG = join(PI_AGENT_DIR, "models.json");
const PI_SETTINGS = join(PI_AGENT_DIR, "settings.json");
const PI_SKILLS_DIR = join(PI_AGENT_DIR, "skills");
const PI_WEB_SEARCH = join(PI_DIR, "web-search.json");

const PI_PACKAGES = [
  "npm:pi-web-access",
  "npm:pi-powerline-footer",
  "npm:pi-smart-fetch",
];

// Pi thinking levels → reasoning_effort values sent to the server. oMLX
// normalizes aliases and falls back to the model template's default on
// unknown values; llama.cpp passes them through to the template (levels
// land only if the template reads reasoning_effort). Ollama models never
// see this map — see piReasoning. minimal/max stay hidden — local
// templates generally accept only low/medium/high (harmony) or
// low/medium/xhigh (Qwen3.x), and oMLX remaps across the two families
// automatically.
const THINKING_LEVEL_MAP = { minimal: null, low: "low", medium: "medium", high: "high", xhigh: "xhigh", max: null };

function piModelConfig(profile) {
  const compat = piModelCompat(profile);
  const reasoning = piReasoning(profile);
  const base = modelDescriptor(profile);
  return {
    id: base.id,
    name: base.name,
    input: base.input,
    maxTokens: base.maxTokens,
    ...(reasoning === undefined ? {} : { reasoning, thinkingLevelMap: THINKING_LEVEL_MAP }),
    ...(compat ? { compat } : {}),
    ...(base.contextWindow ? { contextWindow: base.contextWindow } : {}),
    cost: base.cost,
  };
}

function piModelCompat(profile) {
  if (profile.compat) return profile.compat;
  if (profile.backend === "ollama") return null; // no thinking controls — see piReasoning
  const family = modelFamily(profile);
  if (family.includes("qwen") || family.includes("gemma-4") || family.includes("gemma 4")) {
    // Generic chat-template kwargs carry BOTH the on/off toggle and the
    // effort level. Pi's "qwen-chat-template" format only sends the toggle
    // and silently drops the level — leaving models like Qwen3.8 stuck at
    // their template default (xhigh) no matter what the user picks.
    // oMLX reads chat_template_kwargs natively; llama.cpp passes them
    // through to the template. Ollama models never reach this branch —
    // see piReasoning.
    return {
      thinkingFormat: "chat-template",
      chatTemplateKwargs: {
        enable_thinking: { $var: "thinking.enabled" },
        reasoning_effort: { $var: "thinking.effort", omitWhenOff: true },
        preserve_thinking: true,
      },
    };
  }
  return null;
}

function piReasoning(profile) {
  // Ollama's OpenAI-compatible /v1 endpoint ignores every thinking field
  // (curl-verified: chat_template_kwargs, reasoning_effort, reasoning, and
  // Ollama's own think field) — only native /api/chat honors them, and Pi
  // doesn't speak it. Advertising reasoning here would show thinking
  // controls that provably do nothing, so don't.
  if (profile.backend === "ollama") return undefined;
  return modelDescriptor(profile).thinking || undefined;
}

export const piHarness = {
  id: "pi",
  label: "Pi",
  bin: "pi",
  npm: "@earendil-works/pi-coding-agent",
  thinking: "chat-template-kwargs",

  async detect() {
    return await commandExists(this.bin);
  },

  async syncConfig(profile) {
    const profiles = await activeProviderProfiles(profile);
    const config = await readJson(PI_CONFIG, { providers: {} });
    config.providers ??= {};
    config.providers[profile.providerId] = {
      baseUrl: profile.baseUrl,
      api: "openai-completions",
      apiKey: "none",
      compat: providerCompat(),
      models: profiles.map(piModelConfig),
    };
    await writeJson(PI_CONFIG, config);
    console.log(status({ kind: "success", message: `Synced Pi config: ${PI_CONFIG} (${profiles.length} model${profiles.length === 1 ? "" : "s"})` }));
  },

  async removeModel(profile) {
    const config = await readJson(PI_CONFIG, { providers: {} });
    config.providers ??= {};
    const provider = config.providers[profile.providerId];
    if (!provider?.models) return { cleaned: false, reason: `no ${profile.providerId} provider in Pi config` };
    const before = provider.models.length;
    provider.models = provider.models.filter((m) => m.id !== profile.modelAlias);
    if (provider.models.length === 0) delete config.providers[profile.providerId];
    if (before > provider.models.length) {
      await writeJson(PI_CONFIG, config);
      return { cleaned: true, removed: before - provider.models.length };
    }
    return { cleaned: false, reason: `${profile.modelAlias} not in Pi config` };
  },

  async hasModel(profile) {
    const config = await readJson(PI_CONFIG, null);
    return Boolean(config?.providers?.[profile.providerId]?.models?.some?.((m) => m.id === profile.modelAlias));
  },

  async launch(profile, { cwd, message } = {}) {
    const model = harnessModelRef(profile);
    const args = ["--model", model];
    if (message) args.push(message);
    console.log(theme.bold(`[pi] pi --model ${model}`));
    await runForeground(this.bin, args, { cwd });
  },

  // One-time Pi setup: bundled skills, recommended packages, web search.
  async setup() {
    let configured = 0;

    const bundledSkillsDir = join(RESOURCES_DIR, "skills");
    if (existsSync(bundledSkillsDir)) {
      try {
        const skills = await readdir(bundledSkillsDir, { withFileTypes: true });
        await mkdir(PI_SKILLS_DIR, { recursive: true });
        for (const entry of skills) {
          if (!entry.isDirectory()) continue;
          const src = join(PI_SKILLS_DIR, entry.name);
          const dest = join(PI_SKILLS_DIR, entry.name);
          if (!existsSync(dest)) await cp(src, dest, { recursive: true });
        }
        console.log(status({ kind: "success", message: `Pi skills installed (${skills.filter(s => s.isDirectory()).length} skills)` }));
        configured++;
      } catch (err) {
        console.log(status({ kind: "warning", message: `Could not copy Pi skills: ${err.message}` }));
      }
    }

    for (const pkg of PI_PACKAGES) {
      try {
        await execCommand("pi", ["install", pkg], { label: pkg, verbose: true });
        configured++;
      } catch (err) {
        console.log(theme.subtle(`  Skipped ${pkg}: ${err.message}`));
      }
    }

    const bundledWebSearch = join(RESOURCES_DIR, "web-search.json");
    if (existsSync(bundledWebSearch)) {
      try {
        const { readFile, writeFile } = await import("node:fs/promises");
        const content = await readFile(bundledWebSearch, "utf8");
        if (!existsSync(PI_WEB_SEARCH)) await writeFile(PI_WEB_SEARCH, content, "utf8");
        console.log(status({ kind: "success", message: "Pi web-search config installed" }));
        configured++;
      } catch (err) {
        console.log(status({ kind: "warning", message: `Could not copy web-search config: ${err.message}` }));
      }
    }

    try {
      const settings = await readJson(PI_SETTINGS, {});
      if (!settings.enableSkillCommands) {
        settings.enableSkillCommands = true;
        await writeJson(PI_SETTINGS, settings);
      }
    } catch (err) {
      console.log(theme.subtle(`  Could not enable skill commands: ${err.message}`));
    }

    if (configured > 0) {
      console.log(status({ kind: "success", message: `Pi configured (${configured} items set up)` }));
    }
  },
};

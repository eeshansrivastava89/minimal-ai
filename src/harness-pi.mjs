import { existsSync } from "node:fs";
import { cp, readdir, mkdir } from "node:fs/promises";
import { homedir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { readJson, writeJson } from "./json.mjs";
import { execCommand, commandExists } from "./exec.mjs";
import { status, theme } from "./ui.mjs";
import {
  launchModel,
  modelDescriptor,
  modelFamily,
  providerHasModel,
  removeProviderModel,
  syncProviderConfig,
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

// Qwen3.5/3.6/3.8-family templates accept only low/medium/xhigh, with xhigh
// as the template default. Sending "high" makes the template raise and
// oMLX's alias fallback silently remaps it to xhigh — Pi "high" would mean
// maximum thinking with no way back. Omitting the value (minimal/max in the
// standard map) also falls to the xhigh default. So every level is mapped to
// a value the template accepts.
const QWEN3X_THINKING_LEVEL_MAP = { minimal: "low", low: "low", medium: "medium", high: "xhigh", xhigh: "xhigh", max: "xhigh" };

function isQwen3xFamily(family) {
  return /qwen3[._-]?(?:[568]|next)/i.test(family);
}

export function thinkingLevelMapFor(profile) {
  return isQwen3xFamily(modelFamily(profile)) ? QWEN3X_THINKING_LEVEL_MAP : THINKING_LEVEL_MAP;
}

function piModelConfig(profile) {
  const compat = piModelCompat(profile);
  const reasoning = piReasoning(profile);
  const base = modelDescriptor(profile);
  return {
    id: base.id,
    name: base.name,
    input: base.input,
    maxTokens: base.maxTokens,
    ...(reasoning === undefined ? {} : { reasoning, thinkingLevelMap: thinkingLevelMapFor(profile) }),
    // Compat only makes sense for models we know can think — attaching
    // chat-template kwargs to a non-thinking model would show Pi thinking
    // controls that do nothing.
    ...(reasoning !== undefined && compat ? { compat } : {}),
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

const PI_IO = {
  configPath: PI_CONFIG,
  readConfig: () => readJson(PI_CONFIG, { providers: {} }),
  writeConfig: (config) => writeJson(PI_CONFIG, config),
};

export const piHarness = {
  id: "pi",
  label: "Pi",
  bin: "pi",
  npm: "@earendil-works/pi-coding-agent",
  thinking: "chat-template-kwargs",
  modelConfig: piModelConfig,

  async detect() {
    return await commandExists(this.bin);
  },

  async syncConfig(profile) {
    await syncProviderConfig(this, profile, PI_IO);
  },

  async removeModel(profile) {
    return await removeProviderModel(this, profile, PI_IO);
  },

  async hasModel(profile) {
    return await providerHasModel(profile, PI_IO);
  },

  async launch(profile, options = {}) {
    await launchModel(this, profile, options);
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
          const src = join(bundledSkillsDir, entry.name);
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

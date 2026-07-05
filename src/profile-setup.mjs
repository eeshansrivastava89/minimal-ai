import { existsSync } from "node:fs";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { estimateMemory } from "./estimate.mjs";
import { findLlamaServer } from "./config.mjs";
import { baseUrlForFlags } from "./backends.mjs";
import { pc, formatBytes, renderRows, renderSection } from "./ui.mjs";
import { detectCapabilities } from "./autodetect.mjs";
import { matchDrafter } from "./scan.mjs";
import { scanGgufModels } from "./scan.mjs";
import { capabilitySummary } from "./model-summary.mjs";
import { detectOmlxMtpCapability, findOmlxModelDir } from "./mlx-discovery.mjs";

const execFileAsync = promisify(execFile);

const CACHE_CHOICES = [
  { value: "bf16", label: "bf16", hint: "16-bit · best quality · 2 bytes/elem" },
  { value: "f16", label: "f16", hint: "16-bit · stable fallback · 2 bytes/elem" },
  { value: "q8_0", label: "q8_0", hint: "8-bit · half memory · usually safe · 1 byte/elem" },
  { value: "q4_0", label: "q4_0", hint: "4-bit · quarter memory · quality tradeoff · 0.5 bytes/elem" },
];

function quickKvBytes(modelPath, flags) {
  try {
    return estimateMemory(modelPath, null, null, flags).kvBytes;
  } catch {
    return 0;
  }
}

function cacheMemoryRows(modelPath, flags, ctxSize) {
  const combos = [["bf16", "bf16"], ["f16", "f16"], ["q8_0", "q8_0"], ["q4_0", "q4_0"]];
  return combos.map(([k, v]) => {
    const bytes = quickKvBytes(modelPath, { ...flags, ctxSize, cacheTypeK: k, cacheTypeV: v });
    return [`${k}/${v} KV cache`, bytes ? `~${formatBytes(bytes)}` : "unknown"];
  });
}

const GENERAL_DEFAULTS = {
  topK: 20,
  presencePenalty: 1.5,
  repeatPenalty: 1.0,
};

const THINKING_DEFAULTS = {
  topK: 64,
  presencePenalty: 0,
  repeatPenalty: 1.1,
  chatTemplateKwargs: { enable_thinking: true },
};

export async function configureLocalProfile(prompt, profile) {
  let configured = profile;
  // Re-detect capabilities from the model file and check for drafters
  // so that re-setup can pick up MTP availability, vision changes, etc.
  const freshCaps = detectCapabilities(profile.modelPath, profile.mmprojPath);
  let drafterPath = profile.drafterPath ?? null;
  if (drafterPath && !existsSync(drafterPath)) {
    drafterPath = null;
  }
  if (!drafterPath) {
    const { drafters } = await scanGgufModels();
    const drafter = matchDrafter(profile.modelPath, drafters);
    if (drafter) drafterPath = drafter.path;
  }
  const hasMtp = freshCaps.mtp || Boolean(drafterPath);
  const caps = { ...freshCaps, mtp: hasMtp };
  configured = { ...configured, drafterPath: drafterPath ?? null, capabilities: { ...configured.capabilities, mtp: hasMtp } };
  if (configured.disabledMmprojPath && configured.mmprojPath === null && freshCaps.vision) {
    configured = { ...configured, mmprojPath: configured.disabledMmprojPath, disabledMmprojPath: undefined, capabilities: { ...configured.capabilities, vision: true, visionDisabledReason: undefined } };
  }

  // ── Model overview ──────────────────────────────────────────────────────
  console.log("");
  console.log(renderSection("Model overview", renderRows([
    ["Model", pc.bold(profile.label)],
    ["Detected", capabilitySummary(caps)],
    ["Backend", "llama.cpp (local server)"],
    ["Model file", profile.modelPath],
  ])));

  // ── MTP ────────────────────────────────────────────────────────────────
  if (caps.mtp) {
    console.log("");
    console.log(renderSection("MTP (Multi-Token Prediction)", renderRows([
      ["What it does", "Speculative decoding — predicts multiple tokens at once, verifies them"],
      ["Speed", "1.5–3x faster generation"],
      ["Quality", "No loss — rejected predictions fall back to normal"],
      ["Memory", "Slightly more for draft model weights"],
      ["Flags", "--spec-type draft-mtp --spec-draft-n-max 4"],
      ...(configured.drafterPath ? [["Drafter", configured.drafterPath]] : []),
    ])));
    const useMtp = await prompt.yesNo("Enable MTP speculative decoding?", true);
    configured = useMtp ? applyMtpDefaults(configured) : removeMtpDefaults(configured);
  }

  // ── Vision ─────────────────────────────────────────────────────────────
  if (caps.vision && profile.mmprojPath) {
    console.log("");
    const gemma4Unified = isGemma4UnifiedProjector(caps.mmprojProjectorType);
    const supported = !gemma4Unified || await runtimeSupportsGemma4Unified();
    console.log(renderSection("Vision projector", renderRows([
      ["What it does", "Enables image understanding — model can see and reason about images"],
      ["Projector type", caps.mmprojProjectorType ?? "unknown"],
      ["Flag", `--mmproj ${profile.mmprojPath}`],
      ["Memory", "~200 MB for projector weights (varies by model)"],
      ...(gemma4Unified && !supported ? [["Note", pc.yellow("Gemma 4 unified projectors need llama.cpp b9549+.")]] : []),
    ])));
    const useVision = await prompt.yesNo("Enable vision?", supported);
    configured = useVision ? applyVisionDefaults(configured) : removeVisionDefaults(configured, gemma4Unified && !supported ? "gemma4-unified-unsupported" : "user-disabled");
  }

  // ── Thinking ───────────────────────────────────────────────────────────
  if (caps.thinking) {
    console.log("");
    console.log(renderSection("Thinking mode", renderRows([
      ["What it does", "Model reasons step-by-step before answering"],
      ["Benefit", "Better results for math, code, logic — but slower (more output tokens)"],
      ["Sampling changes", "top-k → 64, presence penalty → 0, repeat penalty → 1.1 (adjustable below)"],
      ["Template", "--chat-template-kwargs { enable_thinking: true }"],
    ])));
    const useThinking = await prompt.yesNo("Use thinking/loop-safe defaults?", true);
    configured = useThinking ? applyThinkingDefaults(configured) : removeThinkingDefaults(configured);
  }

  // ── Context window ─────────────────────────────────────────────────────
  const maxCtx = caps.metaCtx ?? 1048576;
  console.log("");
  console.log(renderSection("Context window", renderRows([
    ["What it does", "Maximum tokens the model can process at once (prompt + response + history)"],
    ["Range", `1,024 – ${maxCtx.toLocaleString()} tokens`],
    ["Memory", "KV cache grows linearly — larger context = more RAM"],
    ["Guidance", "8k–32k: chat · 32k–80k: coding/long convos · 128k+: long documents"],
    ["Model max", `${maxCtx.toLocaleString()} tokens`],
    ["Default", `${configured.flags.ctxSize.toLocaleString()} tokens`],
  ])));
  const ctxSize = await prompt.number("Context window tokens", configured.flags.ctxSize, 1024, maxCtx);
  configured = applyRuntimeFlagOverrides(configured, { ctxSize });

  // ── K cache precision ──────────────────────────────────────────────────
  console.log("");
  console.log(renderSection("K cache precision", renderRows([
    ["What it is", "KV cache stores attention 'keys' — previous token states used for prediction"],
    ["Tradeoff", "Lower precision = less memory, potential quality loss"],
    ...cacheMemoryRows(profile.modelPath, configured.flags, ctxSize),
  ])));
  const cacheTypeK = await prompt.choice("K cache precision", CACHE_CHOICES, configured.flags.cacheTypeK);
  configured = applyRuntimeFlagOverrides(configured, { cacheTypeK });

  // ── V cache precision ──────────────────────────────────────────────────
  console.log("");
  console.log(renderSection("V cache precision", renderRows([
    ["What it is", "KV cache stores attention 'values' — token representations from previous layers"],
    ["Tradeoff", "Same as K cache. Some models are more sensitive to V precision than K"],
    ...cacheMemoryRows(profile.modelPath, configured.flags, ctxSize),
  ])));
  const cacheTypeV = await prompt.choice("V cache precision", CACHE_CHOICES, configured.flags.cacheTypeV);
  configured = applyRuntimeFlagOverrides(configured, { cacheTypeV });

  // ── Memory estimate (with chosen context + cache) ──────────────────────
  console.log("");
  console.log(renderMemoryEstimate(configured));

  // ── Temperature ────────────────────────────────────────────────────────
  console.log("");
  console.log(renderSection("Temperature", renderRows([
    ["What it does", "Controls randomness in token selection"],
    ["Range", "0.0 – 2.0"],
    ["0.0", "Deterministic — always picks most likely token"],
    ["0.6", "Balanced — default for most models"],
    ["1.0+", "Creative — more random, may hallucinate"],
    ["Guidance", "0–0.3: coding/factual · 0.4–0.8: chat · 0.9+: creative writing"],
  ])));
  const temperature = await prompt.number("Temperature", configured.flags.temperature, 0, 2, { float: true });
  configured = applyRuntimeFlagOverrides(configured, { temperature });

  // ── Top-p ──────────────────────────────────────────────────────────────
  console.log("");
  console.log(renderSection("Top-p (nucleus sampling)", renderRows([
    ["What it does", "Only considers tokens in the top p fraction of probability mass"],
    ["Range", "0.0 – 1.0 (1.0 = consider all tokens)"],
    ["Guidance", "0.9–0.95: good default · Lower = more focused · Higher = more diverse"],
  ])));
  const topP = await prompt.number("Top-p", configured.flags.topP, 0, 1, { float: true });
  configured = applyRuntimeFlagOverrides(configured, { topP });

  // ── Top-k ──────────────────────────────────────────────────────────────
  console.log("");
  console.log(renderSection("Top-k", renderRows([
    ["What it does", "Limits token selection to top K most likely tokens at each step"],
    ["Range", "0 – 1000 (0 = disabled, uses top-p instead)"],
    ["Guidance", "20: general chat · 40–64: thinking/reasoning · 0: rely on top-p"],
  ])));
  const topK = await prompt.number("Top-k", configured.flags.topK, 0, 1000);
  configured = applyRuntimeFlagOverrides(configured, { topK });

  // ── Min-p ──────────────────────────────────────────────────────────────
  console.log("");
  console.log(renderSection("Min-p", renderRows([
    ["What it does", "Excludes tokens with probability below this threshold"],
    ["Range", "0.0 – 1.0 (0 = disabled)"],
    ["Guidance", "0: off (default) · 0.05–0.1: reduces hallucination while keeping creativity"],
  ])));
  const minP = await prompt.number("Min-p", configured.flags.minP, 0, 1, { float: true });
  configured = applyRuntimeFlagOverrides(configured, { minP });

  // ── Presence penalty ───────────────────────────────────────────────────
  console.log("");
  console.log(renderSection("Presence penalty", renderRows([
    ["What it does", "Discourages repeated tokens — each used token gets a fixed logit penalty"],
    ["Range", "0.0 – 2.0 (0 = off)"],
    ["Guidance", "0: thinking/reasoning · 1.0–1.5: general chat · Too high = incoherent"],
  ])));
  const presencePenalty = await prompt.number("Presence penalty", configured.flags.presencePenalty, 0, 2, { float: true });
  configured = applyRuntimeFlagOverrides(configured, { presencePenalty });

  // ── Repeat penalty ─────────────────────────────────────────────────────
  console.log("");
  console.log(renderSection("Repeat penalty", renderRows([
    ["What it does", "Multiplies probability of repeated tokens (multiplicative, vs presence's additive)"],
    ["Range", "0.0 – 2.0 (1.0 = no effect)"],
    ["Guidance", "1.0–1.1: most use cases · Higher = aggressive anti-repeat · Can break code patterns"],
  ])));
  const repeatPenalty = await prompt.number("Repeat penalty", configured.flags.repeatPenalty, 0, 2, { float: true });
  configured = applyRuntimeFlagOverrides(configured, { repeatPenalty });

  // ── Batch size ─────────────────────────────────────────────────────────
  console.log("");
  console.log(renderSection("Batch size", renderRows([
    ["What it does", "Tokens processed in parallel during prompt processing (before generation)"],
    ["Range", "1 – 4096"],
    ["Guidance", "512: good default · 2048+: faster for long prompts · Lower if memory tight"],
  ])));
  const batchSize = await prompt.number("Batch size", configured.flags.batchSize, 1, 4096);
  configured = applyRuntimeFlagOverrides(configured, { batchSize });

  // ── Parallel slots ─────────────────────────────────────────────────────
  console.log("");
  console.log(renderSection("Parallel slots", renderRows([
    ["What it does", "Number of concurrent request slots (each handles an independent conversation)"],
    ["Range", "1 – 10"],
    ["Memory", "KV cache is multiplied by this number"],
    ["Guidance", "1: single-user local · 2+: multiple clients connecting simultaneously"],
  ])));
  const parallel = await prompt.number("Parallel slots", configured.flags.parallel, 1, 10);
  configured = applyRuntimeFlagOverrides(configured, { parallel });

  // ── Flash attention ────────────────────────────────────────────────────
  console.log("");
  console.log(renderSection("Flash attention", renderRows([
    ["What it does", "Memory-efficient attention algorithm — faster and less RAM than standard"],
    ["Guidance", "Always on for modern hardware · Turn off only for old GPU driver compat issues"],
  ])));
  const flashAttn = await prompt.yesNo("Enable flash attention?", true);
  configured = applyRuntimeFlagOverrides(configured, { flashAttention: flashAttn ? "on" : "off" });

  // ── Jinja templates ────────────────────────────────────────────────────
  console.log("");
  console.log(renderSection("Jinja chat templates", renderRows([
    ["What it does", "Enables Jinja2 template rendering for proper chat formatting"],
    ["Guidance", "Always on for modern models · Turn off only for very old models without chat templates"],
  ])));
  const jinja = await prompt.yesNo("Enable Jinja templates?", true);
  configured = applyRuntimeFlagOverrides(configured, { jinja });

  // ── Final summary ──────────────────────────────────────────────────────
  console.log("");
  console.log(renderSection("Configuration summary", renderRows([
    ["Model", pc.bold(configured.label)],
    ["Backend", configured.backend],
    ["Endpoint", configured.baseUrl],
    ["Context", `${configured.flags.ctxSize.toLocaleString()} tokens`],
    ["KV cache", `${configured.flags.cacheTypeK}/${configured.flags.cacheTypeV}`],
    ["Temperature", String(configured.flags.temperature)],
    ["Top-p", String(configured.flags.topP)],
    ["Top-k", String(configured.flags.topK)],
    ["Min-p", String(configured.flags.minP)],
    ["Presence penalty", String(configured.flags.presencePenalty)],
    ["Repeat penalty", String(configured.flags.repeatPenalty)],
    ["Batch size", String(configured.flags.batchSize)],
    ["Parallel", String(configured.flags.parallel)],
    ["Flash attention", configured.flags.flashAttention],
    ["Jinja", configured.flags.jinja ? "on" : "off"],
    ...(configured.capabilities?.mtp ? [["MTP", "enabled"]] : []),
    ...(configured.capabilities?.vision ? [["Vision", "enabled"]] : []),
    ...(configured.capabilities?.thinking ? [["Thinking", "enabled"]] : []),
  ])));

  console.log("");
  console.log(renderMemoryEstimate(configured));
  if (!(await prompt.yesNo("Save profile with these settings?", true))) return null;
  return configured;
}

export function applyRuntimeFlagOverrides(profile, overrides) {
  const flags = { ...profile.flags, ...overrides };
  return applyProfileFlags(profile, flags);
}

export function applyMtpDefaults(profile) {
  return applyProfileFlags({
    ...profile,
    capabilities: { ...(profile.capabilities ?? {}), mtp: true },
  }, profile.flags);
}

export function removeMtpDefaults(profile) {
  return applyProfileFlags({
    ...profile,
    drafterPath: null,
    capabilities: { ...(profile.capabilities ?? {}), mtp: false },
  }, profile.flags);
}

// ── oMLX (managed server) profile configuration ───────────────────────────

export async function configureManagedProfile(prompt, profile) {
  let configured = profile;
  const modelId = profile.omlxModel ?? profile.modelAlias ?? profile.id;

  // Detect MTP capability from the model's config.json
  const modelDir = await findOmlxModelDir(modelId);
  if (modelDir) {
    const mtpResult = await detectOmlxMtpCapability(modelDir);
    if (mtpResult.compatible) {
      console.log("");
      console.log(renderSection("MTP detected", renderRows([
        ["Feature", "Multi-Token Prediction (speculative decoding)"],
        ["Mechanism", "oMLX native MTP (enabled via admin API at load time)"],
      ])));
      const useMtp = await prompt.yesNo("Use MTP speculative decoding?", true);
      configured = { ...configured, capabilities: { ...(configured.capabilities ?? {}), mtp: useMtp } };
    } else if (mtpResult.reason !== "model has no MTP heads in config") {
      // Model declares MTP but can't use it — surface the reason
      console.log("");
      console.log(renderSection("MTP not available", renderRows([
        ["Feature", "Multi-Token Prediction (speculative decoding)"],
        ["Reason", pc.yellow(mtpResult.reason)],
      ])));
    }
    // If reason is "no MTP heads in config", don't surface anything —
    // most models don't have MTP, and showing a card for every non-MTP
    // model would be noise.
  }

  console.log("");
  console.log(renderSection("Model setup", renderRows([
    ["Model", pc.bold(profile.label)],
    ["Backend", "oMLX"],
    ...(configured.capabilities?.mtp ? [["MTP", "enabled"]] : []),
  ])));

  if (!(await prompt.yesNo("Save profile with these settings?", true))) return null;
  return configured;
}

function applyVisionDefaults(profile) {
  if (!profile.mmprojPath) return profile;
  return applyProfileFlags({
    ...profile,
    capabilities: { ...(profile.capabilities ?? {}), vision: true, visionDisabledReason: undefined },
  }, profile.flags, { values: { "--mmproj": profile.mmprojPath } });
}

function removeVisionDefaults(profile, reason) {
  return applyProfileFlags({
    ...profile,
    disabledMmprojPath: profile.mmprojPath,
    mmprojPath: null,
    capabilities: { ...(profile.capabilities ?? {}), vision: false, visionDisabledReason: reason },
  }, profile.flags, { remove: ["--mmproj"] });
}

function applyThinkingDefaults(profile) {
  const flags = { ...profile.flags, ...THINKING_DEFAULTS };
  return applyProfileFlags(profile, flags);
}

function removeThinkingDefaults(profile) {
  const flags = { ...profile.flags, ...GENERAL_DEFAULTS };
  delete flags.chatTemplateKwargs;
  return applyProfileFlags(profile, flags);
}

function applyProfileFlags(profile, flags) {
  const next = {
    ...profile,
    flags,
    baseUrl: baseUrlForFlags(flags),
    harnesses: {
      ...(profile.harnesses ?? {}),
      pi: { ...(profile.harnesses?.pi ?? {}), enabled: true, model: `${profile.providerId ?? profile.backend}/${profile.modelAlias ?? profile.id}` },
    },
  };
  return next;
}


function renderMemoryEstimate(profile) {
  try {
    const est = estimateMemory(profile.modelPath, profile.mmprojPath, profile.drafterPath, profile.flags);
    return renderSection("Memory estimate", renderRows([
      ["Estimated total", pc.bold(`~${formatBytes(est.totalBytes)}`)],
      ["Model", formatBytes(est.modelBytes)],
      ...(est.mmprojBytes ? [["Vision projector", formatBytes(est.mmprojBytes)]] : []),
      ...(est.draftBytes ? [["Drafter (MTP)", formatBytes(est.draftBytes)]] : []),
      ["KV cache", est.kvBytes ? `~${formatBytes(est.kvBytes)} (${profile.flags.ctxSize.toLocaleString()} ctx, ${profile.flags.cacheTypeK}/${profile.flags.cacheTypeV})` : "unknown"],
      ...(est.note ? [["Note", pc.yellow(est.note)]] : []),
    ]));
  } catch {
    return renderSection("Memory estimate", pc.dim("Estimate unavailable for this model."));
  }
}

function isGemma4UnifiedProjector(projectorType) {
  return /gemma4u[va]/i.test(String(projectorType ?? ""));
}

async function runtimeSupportsGemma4Unified() {
  try {
    const binary = await findLlamaServer();
    if (!binary) return false;
    const { stdout, stderr } = await execFileAsync(binary, ["--version"]);
    const output = `${stdout}\n${stderr}`;
    const version = Number(output.match(/version:\s*(\d+)/i)?.[1]);
    return Number.isFinite(version) && version >= 9549;
  } catch {
    return false;
  }
}




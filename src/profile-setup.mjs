import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { estimateMemory } from "./estimate.mjs";
import { findLlamaServer } from "./config.mjs";
import { baseUrlForFlags, LLAMA_CPP_PORT, LLAMA_CPP_MTP_PORT } from "./backends.mjs";
import { pc, formatBytes, renderRows, renderSection } from "./ui.mjs";

const execFileAsync = promisify(execFile);

const CACHE_CHOICES = [
  { value: "bf16", label: "bf16", hint: "default: stable, good quality" },
  { value: "f16", label: "f16", hint: "stable fallback, similar memory to bf16" },
  { value: "q8_0", label: "q8_0", hint: "lower memory, usually safe" },
  { value: "q4_0", label: "q4_0", hint: "lowest memory, quality/speed tradeoff" },
];

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
  const caps = profile.capabilities ?? {};

  console.log("");
  console.log(renderSection("Model setup", renderRows([
    ["Model", pc.bold(profile.label)],
    ["Detected", detectionSummary(caps)],
    ["Context", `${profile.flags.ctxSize.toLocaleString()} tokens`],
    ["KV cache", `${profile.flags.cacheTypeK}/${profile.flags.cacheTypeV}`],
    ["Sampling", samplingSummary(profile.flags)],
  ])));
  console.log(pc.dim("Larger context windows use more memory. KV cache precision controls memory used by attention history."));
  console.log(pc.dim("Sampling defaults are shown for transparency; you can edit command.json later if needed.\n"));

  if (caps.mtp) {
    console.log(renderSection("MTP detected", renderRows([
      ["Backend", "llama.cpp MTP"],
      ["Port", String(LLAMA_CPP_MTP_PORT)],
      ["Flags", "--spec-type draft-mtp --spec-draft-n-max 2"],
    ])));
    const useMtp = await prompt.yesNo("Use MTP speculative decoding flags?", true);
    configured = useMtp ? applyMtpDefaults(configured) : removeMtpDefaults(configured);
  }

  if (caps.qat) {
    console.log("");
    console.log(renderSection("QAT detected", renderRows([
      ["Meaning", "quantization-aware trained"],
      ["Runtime flags", "none QAT-specific"],
    ])));
  }

  if (caps.vision && profile.mmprojPath) {
    console.log("");
    const gemma4Unified = isGemma4UnifiedProjector(caps.mmprojProjectorType);
    const supported = !gemma4Unified || await runtimeSupportsGemma4Unified();
    console.log(renderSection("Vision projector detected", renderRows([
      ["Projector", caps.mmprojProjectorType ?? "unknown"],
      ["Flag", `--mmproj ${profile.mmprojPath}`],
      ...(gemma4Unified && !supported ? [["Note", pc.yellow("Gemma 4 unified projectors need llama.cpp b9549+.")]] : []),
    ])));
    const useVision = await prompt.yesNo("Enable vision with --mmproj?", supported);
    configured = useVision ? applyVisionDefaults(configured) : removeVisionDefaults(configured, gemma4Unified && !supported ? "gemma4-unified-unsupported" : "user-disabled");
  }

  if (caps.thinking) {
    console.log("");
    console.log(renderSection("Thinking model detected", renderRows([
      ["Defaults", "thinking / loop-safe"],
      ["Flags", "--top-k 64 --presence-penalty 0 --repeat-penalty 1.1"],
      ["Template", "--chat-template-kwargs { enable_thinking: true }"],
    ])));
    const useThinking = await prompt.yesNo("Use these thinking/loop-safe defaults?", true);
    configured = useThinking ? applyThinkingDefaults(configured) : removeThinkingDefaults(configured);
  }

  const ctxSize = await prompt.number("Context window tokens", configured.flags.ctxSize, 1024, 1048576);
  const cacheTypeK = await prompt.choice("K cache precision", CACHE_CHOICES, configured.flags.cacheTypeK);
  const cacheTypeV = await prompt.choice("V cache precision", CACHE_CHOICES, configured.flags.cacheTypeV);
  configured = applyRuntimeFlagOverrides(configured, { ctxSize, cacheTypeK, cacheTypeV });

  console.log("");
  console.log(renderSection("Defaults", renderRows([
    ["Backend", configured.backend],
    ["Endpoint", configured.baseUrl],
    ["Temperature", configured.flags.temperature],
    ["Top-p", configured.flags.topP],
    ["Top-k", configured.flags.topK],
    ["Min-p", configured.flags.minP],
    ["Presence penalty", configured.flags.presencePenalty],
    ["Repeat penalty", configured.flags.repeatPenalty],
  ])));

  console.log("\n" + renderMemoryEstimate(configured));
  if (!(await prompt.yesNo("Save profile with these settings?", true))) return null;
  return configured;
}

export function applyRuntimeFlagOverrides(profile, overrides) {
  const flags = { ...profile.flags, ...overrides };
  return applyProfileFlags(profile, flags);
}

function applyMtpDefaults(profile) {
  const flags = { ...profile.flags, port: LLAMA_CPP_MTP_PORT };
  return applyProfileFlags({ ...profile, backend: "llama-cpp-mtp", providerId: "llama-cpp-mtp" }, flags, {
    values: { "--spec-type": "draft-mtp", "--spec-draft-n-max": 2 },
  });
}

function removeMtpDefaults(profile) {
  const flags = { ...profile.flags, port: LLAMA_CPP_PORT };
  return applyProfileFlags({ ...profile, backend: "llama-cpp", providerId: "llama-cpp" }, flags, {
    remove: ["--spec-type", "--spec-draft-n-max"],
  });
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
  return applyProfileFlags(profile, flags, { remove: ["--chat-template-kwargs"] });
}

function applyProfileFlags(profile, flags, edits = {}) {
  const next = {
    ...profile,
    flags,
    baseUrl: baseUrlForFlags(flags),
    harnesses: {
      ...(profile.harnesses ?? {}),
      pi: { ...(profile.harnesses?.pi ?? {}), enabled: true, model: `${profile.providerId ?? profile.backend}/${profile.modelAlias ?? profile.id}` },
    },
  };
  next.commandArgv = updateArgv(profile.commandArgv ?? [], {
    "--host": flags.host,
    "--port": flags.port,
    "--ctx-size": flags.ctxSize,
    "--cache-type-k": flags.cacheTypeK,
    "--cache-type-v": flags.cacheTypeV,
    "--top-k": flags.topK,
    "--presence-penalty": flags.presencePenalty,
    "--repeat-penalty": flags.repeatPenalty,
    ...(flags.chatTemplateKwargs ? { "--chat-template-kwargs": JSON.stringify(flags.chatTemplateKwargs) } : {}),
  }, edits);
  return next;
}

function updateArgv(argv, values, edits = {}) {
  let next = [...argv];
  for (const flag of edits.remove ?? []) next = removeOption(next, flag);
  for (const [flag, value] of Object.entries({ ...values, ...(edits.values ?? {}) })) {
    if (value === undefined) continue;
    const index = next.indexOf(flag);
    if (index === -1) next.push(flag, String(value));
    else next[index + 1] = String(value);
  }
  return next;
}

function removeOption(argv, flag) {
  const next = [];
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === flag) {
      if (argv[i + 1] && !argv[i + 1].startsWith("--")) i += 1;
      continue;
    }
    next.push(argv[i]);
  }
  return next;
}

function renderMemoryEstimate(profile) {
  try {
    const est = estimateMemory(profile.modelPath, profile.mmprojPath, null, profile.flags);
    return renderSection("Memory estimate", renderRows([
      ["Estimated total", pc.bold(`~${formatBytes(est.totalBytes)}`)],
      ["Model", formatBytes(est.modelBytes)],
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

function detectionSummary(caps) {
  const parts = [];
  if (caps.architecture) parts.push(caps.architecture);
  if (caps.quant) parts.push(caps.quant);
  if (caps.mtp) parts.push("MTP");
  if (caps.qat) parts.push("QAT");

  if (caps.thinking) parts.push("thinking");
  if (caps.vision) parts.push("vision");
  return parts.length > 0 ? parts.join(" · ") : "standard GGUF";
}

function samplingSummary(flags) {
  return `temp ${flags.temperature}, top-p ${flags.topP}, top-k ${flags.topK}`;
}

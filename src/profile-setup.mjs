import { estimateMemory } from "./estimate.mjs";
import { pc, formatBytes, renderRows, renderSection } from "./ui.mjs";

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
    console.log(renderSection("Detected MTP", renderRows([
      ["Backend", "llama.cpp MTP"],
      ["Port", "8081"],
      ["Flags", "--spec-type draft-mtp --spec-draft-n-max 2"],
    ])));
    const useMtp = await prompt.yesNo("Use MTP speculative decoding flags?", true);
    configured = useMtp ? applyMtpDefaults(configured) : removeMtpDefaults(configured);
  }

  if (caps.thinking || caps.qat) {
    console.log("");
    console.log(renderSection(caps.qat ? "Detected QAT / imatrix-style model" : "Detected thinking model", renderRows([
      ["Defaults", "thinking / loop-safe"],
      ["Flags", "--top-k 64 --presence-penalty 0 --repeat-penalty 1.1"],
      ["Template", "--chat-template-kwargs { enable_thinking: true }"],
    ])));
    const useThinking = await prompt.yesNo("Use these thinking/QAT-safe defaults?", true);
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
  const flags = { ...profile.flags, port: 8081 };
  return applyProfileFlags({ ...profile, backend: "llama-cpp-mtp", providerId: "llama-cpp-mtp" }, flags, {
    values: { "--spec-type": "draft-mtp", "--spec-draft-n-max": 2 },
  });
}

function removeMtpDefaults(profile) {
  const flags = { ...profile.flags, port: 8080 };
  return applyProfileFlags({ ...profile, backend: "llama-cpp", providerId: "llama-cpp" }, flags, {
    remove: ["--spec-type", "--spec-draft-n-max"],
  });
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
    baseUrl: `http://${flags.host}:${flags.port}/v1`,
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
    return renderSection("Memory", renderRows([
      ["Estimated total", pc.bold(`~${formatBytes(est.totalBytes)}`)],
      ["Model", formatBytes(est.modelBytes)],
      ["KV cache", est.kvBytes ? `~${formatBytes(est.kvBytes)} (${profile.flags.ctxSize.toLocaleString()} ctx, ${profile.flags.cacheTypeK}/${profile.flags.cacheTypeV})` : "unknown"],
      ...(est.note ? [["Note", pc.yellow(est.note)]] : []),
    ]));
  } catch {
    return renderSection("Memory", pc.dim("Estimate unavailable for this model."));
  }
}

function detectionSummary(caps) {
  const parts = [];
  if (caps.architecture) parts.push(caps.architecture);
  if (caps.quant) parts.push(caps.quant);
  if (caps.mtp) parts.push("MTP");
  if (caps.qat) parts.push("QAT/imatrix");
  if (caps.thinking) parts.push("thinking");
  if (caps.vision) parts.push("vision");
  return parts.length > 0 ? parts.join(" · ") : "standard GGUF";
}

function samplingSummary(flags) {
  return `temp ${flags.temperature}, top-p ${flags.topP}, top-k ${flags.topK}`;
}

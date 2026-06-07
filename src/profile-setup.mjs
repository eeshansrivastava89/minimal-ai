import { estimateMemory } from "./estimate.mjs";
import { pc, formatBytes, renderRows, renderSection, humanCapabilitySummary } from "./ui.mjs";

const CACHE_CHOICES = [
  { value: "bf16", label: "Balanced", hint: "recommended: stable, good quality" },
  { value: "f16", label: "Compatible", hint: "stable fallback, similar memory use" },
  { value: "q8_0", label: "Lower memory", hint: "usually safe, uses less memory" },
  { value: "q4_0", label: "Smallest memory", hint: "maximum savings, quality/speed tradeoff" },
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
  console.log(renderSection("Let's set up this model", renderRows([
    ["Model", pc.bold(profile.label)],
    ["Good for", humanCapabilitySummary(caps)],
    ["Conversation memory", `${profile.flags.ctxSize.toLocaleString()} tokens`],
    ["Memory mode", `${profile.flags.cacheTypeK}/${profile.flags.cacheTypeV}`],
    ["Response style", samplingSummary(profile.flags)],
  ])));
  console.log(pc.dim("You can accept the recommended settings. Bigger conversation memory uses more RAM.\n"));

  if (caps.mtp) {
    console.log(renderSection("MTP available", "This model supports multi-token prediction (MTP). offgrid-ai can run it with llama.cpp MTP on port 8081."));
    const useMtp = await prompt.yesNo("Use MTP for this model?", true);
    configured = useMtp ? applyMtpDefaults(configured) : removeMtpDefaults(configured);
  }

  if (caps.qat) {
    console.log("");
    console.log(renderSection("QAT model", "This model is marked as quantization-aware trained (QAT). No extra runtime settings are needed."));
  }

  if (caps.thinking) {
    console.log("");
    console.log(renderSection("Reasoning mode", "This model can reason step by step. offgrid-ai can use safer defaults that reduce repetitive loops."));
    const useThinking = await prompt.yesNo("Use reasoning-friendly defaults?", true);
    configured = useThinking ? applyThinkingDefaults(configured) : removeThinkingDefaults(configured);
  }

  const ctxSize = await prompt.number("Conversation memory tokens", configured.flags.ctxSize, 1024, 1048576);
  const cacheTypeK = await prompt.choice("Memory mode, part 1", CACHE_CHOICES, configured.flags.cacheTypeK);
  const cacheTypeV = await prompt.choice("Memory mode, part 2", CACHE_CHOICES, configured.flags.cacheTypeV);
  configured = applyRuntimeFlagOverrides(configured, { ctxSize, cacheTypeK, cacheTypeV });

  console.log("");
  console.log(renderSection("Final setup", renderRows([
    ["Runs with", configured.backend],
    ["Local address", configured.baseUrl],
    ["Creativity", configured.flags.temperature],
    ["Focus", configured.flags.topP],
    ["Reasoning breadth", configured.flags.topK],
  ])));

  console.log("\n" + renderMemoryEstimate(configured));
  if (!(await prompt.yesNo("Save this model setup?", true))) return null;
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
    return renderSection("Memory estimate", renderRows([
      ["Estimated total", pc.bold(`~${formatBytes(est.totalBytes)}`)],
      ["Model file", formatBytes(est.modelBytes)],
      ["Conversation memory", est.kvBytes ? `~${formatBytes(est.kvBytes)} (${profile.flags.ctxSize.toLocaleString()} tokens, ${profile.flags.cacheTypeK}/${profile.flags.cacheTypeV})` : "unknown"],
      ...(est.note ? [["Note", pc.yellow(est.note)]] : []),
    ]));
  } catch {
    return renderSection("Memory estimate", pc.dim("Estimate unavailable for this model."));
  }
}

function samplingSummary(flags) {
  return `temp ${flags.temperature}, top-p ${flags.topP}, top-k ${flags.topK}`;
}

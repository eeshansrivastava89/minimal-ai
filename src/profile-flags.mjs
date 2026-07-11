import { baseUrlForFlags } from "./backends.mjs";

const GENERAL_DEFAULTS = {
  topK: 20,
  presencePenalty: 1.0,
  repeatPenalty: 1.0,
};

const THINKING_DEFAULTS = {
  topK: 64,
  presencePenalty: 0,
  repeatPenalty: 1.1,
  chatTemplateKwargs: { enable_thinking: true },
};

export function applyRuntimeFlagOverrides(profile, overrides) {
  const flags = { ...profile.flags, ...overrides };
  return applyProfileFlags(profile, flags);
}

export function removeMtpDefaults(profile) {
  return applyProfileFlags({
    ...profile,
    drafterPath: null,
    capabilities: { ...(profile.capabilities ?? {}), mtp: false },
  }, profile.flags);
}

function applyMtpDefaults(profile) {
  return applyProfileFlags({
    ...profile,
    capabilities: { ...(profile.capabilities ?? {}), mtp: true },
  }, profile.flags);
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

export { applyMtpDefaults, applyVisionDefaults, removeVisionDefaults, applyThinkingDefaults, removeThinkingDefaults, GENERAL_DEFAULTS, THINKING_DEFAULTS };
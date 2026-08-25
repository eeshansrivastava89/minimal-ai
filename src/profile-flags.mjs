import { baseUrlForFlags } from "./backends.mjs";
import { GENERAL_SAMPLER_DEFAULTS, THINKING_SAMPLER_DEFAULTS } from "./autodetect.mjs";

// These mirror the sampler defaults in autodetect.mjs (one source of truth —
// computeFlags seeds the same values into fresh profiles). Derived here so a
// default change in one place can't silently diverge from the other (M3).
// Thinking adds the chat-template toggle on top of the sampler deltas.
const GENERAL_DEFAULTS = {
  topK: GENERAL_SAMPLER_DEFAULTS.topK,
  presencePenalty: GENERAL_SAMPLER_DEFAULTS.presencePenalty,
  repeatPenalty: GENERAL_SAMPLER_DEFAULTS.repeatPenalty,
};

const THINKING_DEFAULTS = {
  topK: THINKING_SAMPLER_DEFAULTS.topK,
  presencePenalty: THINKING_SAMPLER_DEFAULTS.presencePenalty,
  repeatPenalty: THINKING_SAMPLER_DEFAULTS.repeatPenalty,
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
    mtpEnabled: false,
  }, profile.flags);
}

function applyMtpDefaults(profile) {
  return applyProfileFlags({
    ...profile,
    mtpEnabled: true,
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
  return { ...profile, flags, baseUrl: baseUrlForFlags(flags) };
}

export { applyMtpDefaults, applyVisionDefaults, removeVisionDefaults, applyThinkingDefaults, removeThinkingDefaults };
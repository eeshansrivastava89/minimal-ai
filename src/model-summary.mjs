import { existsSync } from "node:fs";
import { basename } from "node:path";
import { backendFor } from "./backends.mjs";
import { matchDrafter } from "./scan.mjs";
import { detectGgufCapabilities } from "./capabilities.mjs";
import { capabilitySummary, formatCtxLabel, status } from "./ui.mjs";
import { isGemma4Architecture } from "./model-family.mjs";

export function isProfileFileMissing(profile) {
  const backend = backendFor(profile.backend);
  if (backend.type === "managed-server") return false;
  if (!profile.modelPath) return true;
  return !existsSync(profile.modelPath);
}

/** Specs-included variant for detail rows: "qwen3 · 4bit · Reasoning · MTP". */
export function capabilitySpecs(caps) {
  return capabilitySummary(caps, { specs: true });
}

function profileMtpLabel(profile, drafters, { detailed = false } = {}) {
  if (profile.drafterPath) {
    return detailed ? status({ kind: "success", message: `MTP enabled (drafter: ${basename(profile.drafterPath)})` }) : status({ kind: "success", message: "MTP enabled" });
  }
  if (drafters && profile.modelPath && matchDrafter(profile.modelPath, drafters)) return status({ kind: "warning", message: "MTP available" });
  if (isGemma4Architecture(profile.capabilities)) {
    return detailed ? status({ kind: "warning", message: "MTP available — download a drafter model to enable 2× speedup" }) : status({ kind: "warning", message: "MTP: needs drafter" });
  }
  return null;
}

function ggufMtpLabel(model, drafter) {
  const caps = detectGgufCapabilities(model.path, model.mmprojPath);
  if (caps.mtp || Boolean(drafter)) return status({ kind: "success", message: "MTP ✓" });
  if (isGemma4Architecture(caps)) return status({ kind: "warning", message: "MTP: needs drafter" });
  return null;
}

export function profileDetailParts(profile, { fileMissing = false, drafters = null } = {}) {
  const parts = [fileMissing ? status({ kind: "error", message: "File not found" }) : capabilitySummary(profile.capabilities ?? {})];
  const mtpLabel = profileMtpLabel(profile, drafters, { detailed: true });
  if (mtpLabel) parts.push(mtpLabel);
  const ctxLabel = profile.flags?.ctxSize ? `${formatCtxLabel(profile.flags.ctxSize)} ctx` : null;
  if (ctxLabel) parts.push(ctxLabel);
  return parts;
}

export function ggufDetailParts(model, drafter) {
  const caps = detectGgufCapabilities(model.path, model.mmprojPath);
  const parts = [capabilitySummary(caps)];
  const mtpLabel = ggufMtpLabel(model, drafter);
  if (mtpLabel) parts.push(mtpLabel);
  const ctxLabel = caps.contextLength ? `${formatCtxLabel(caps.contextLength)} ctx` : null;
  if (ctxLabel) parts.push(ctxLabel);
  return { caps, parts };
}

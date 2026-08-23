import { existsSync } from "node:fs";
import { basename } from "node:path";
import { backendFor } from "./backends.mjs";
import { matchDrafter } from "./scan.mjs";
import { detectGgufCapabilities } from "./capabilities.mjs";
import { humanCapabilitySummary, formatCtxLabel, status } from "./ui.mjs";

export function isProfileFileMissing(profile) {
  const backend = backendFor(profile.backend);
  if (backend.type === "managed-server") return false;
  if (!profile.modelPath) return true;
  return !existsSync(profile.modelPath);
}

export function capabilitySummary(caps) {
  const parts = [];
  if (caps.architecture) parts.push(caps.architecture);
  if (caps.quant) parts.push(caps.quant);
  if (caps.mtp) parts.push("MTP");
  if (caps.qat) parts.push("QAT");
  if (caps.thinking) parts.push("thinking");
  if (caps.vision) parts.push("vision");
  return parts.length > 0 ? parts.join(" · ") : "standard GGUF";
}

function profileMtpLabel(profile, drafters, { detailed = false } = {}) {
  if (profile.drafterPath) {
    return detailed ? status({ kind: "success", message: `MTP enabled (drafter: ${basename(profile.drafterPath)})` }) : status({ kind: "success", message: "MTP enabled" });
  }
  if (drafters && profile.modelPath && matchDrafter(profile.modelPath, drafters)) return status({ kind: "warning", message: "MTP available" });
  if (profile.capabilities?.architecture === "gemma4") {
    return detailed ? status({ kind: "warning", message: "MTP available — download a drafter model to enable 2× speedup" }) : status({ kind: "warning", message: "MTP: needs drafter" });
  }
  return null;
}

function ggufMtpLabel(model, drafter) {
  const caps = detectGgufCapabilities(model.path, model.mmprojPath);
  if (caps.mtp || Boolean(drafter)) return status({ kind: "success", message: "MTP ✓" });
  if (caps.architecture === "gemma4") return status({ kind: "warning", message: "MTP: needs drafter" });
  return null;
}

export function profileDetailParts(profile, { fileMissing = false, drafters = null } = {}) {
  const parts = [fileMissing ? status({ kind: "error", message: "File not found" }) : humanCapabilitySummary(profile.capabilities ?? {})];
  const mtpLabel = profileMtpLabel(profile, drafters, { detailed: true });
  if (mtpLabel) parts.push(mtpLabel);
  const ctxLabel = profile.flags?.ctxSize ? `${formatCtxLabel(profile.flags.ctxSize)} ctx` : null;
  if (ctxLabel) parts.push(ctxLabel);
  return parts;
}

export function ggufDetailParts(model, drafter) {
  const caps = detectGgufCapabilities(model.path, model.mmprojPath);
  const parts = [humanCapabilitySummary(caps)];
  const mtpLabel = ggufMtpLabel(model, drafter);
  if (mtpLabel) parts.push(mtpLabel);
  const ctxLabel = caps.contextLength ? `${formatCtxLabel(caps.contextLength)} ctx` : null;
  if (ctxLabel) parts.push(ctxLabel);
  return { caps, parts };
}

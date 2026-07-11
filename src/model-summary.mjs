import { existsSync } from "node:fs";
import { basename } from "node:path";
import { backendFor } from "./backends.mjs";
import { matchDrafter } from "./scan.mjs";
import { detectCapabilities } from "./autodetect.mjs";
import { pc, humanCapabilitySummary, formatCtxLabel } from "./ui.mjs";

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
    return detailed ? pc.green(`MTP enabled (drafter: ${basename(profile.drafterPath)})`) : pc.green("MTP enabled");
  }
  if (drafters && profile.modelPath && matchDrafter(profile.modelPath, drafters)) return pc.yellow("MTP available");
  if (profile.capabilities?.architecture === "gemma4") {
    return detailed ? pc.yellow("MTP available — download a drafter model to enable 2× speedup") : pc.yellow("MTP: needs drafter");
  }
  return null;
}

function ggufMtpLabel(model, drafter) {
  const caps = detectCapabilities(model.path, model.mmprojPath);
  if (caps.mtp || Boolean(drafter)) return pc.green("MTP ✓");
  if (caps.architecture === "gemma4") return pc.yellow("MTP: needs drafter");
  return null;
}

export function profileDetailParts(profile, { fileMissing = false, drafters = null } = {}) {
  const parts = [fileMissing ? pc.red("File not found") : humanCapabilitySummary(profile.capabilities ?? {})];
  const mtpLabel = profileMtpLabel(profile, drafters, { detailed: true });
  if (mtpLabel) parts.push(mtpLabel);
  const ctxLabel = profile.flags?.ctxSize ? `${formatCtxLabel(profile.flags.ctxSize)} ctx` : null;
  if (ctxLabel) parts.push(ctxLabel);
  return parts;
}

export function ggufDetailParts(model, drafter) {
  const caps = detectCapabilities(model.path, model.mmprojPath);
  const parts = [humanCapabilitySummary(caps)];
  const mtpLabel = ggufMtpLabel(model, drafter);
  if (mtpLabel) parts.push(mtpLabel);
  const ctxLabel = caps.ctxSize ? `${formatCtxLabel(caps.ctxSize)} ctx` : null;
  if (ctxLabel) parts.push(ctxLabel);
  return { caps, parts };
}

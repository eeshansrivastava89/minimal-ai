// oMLX profile setup/reconfigure (A1). Shared machinery lives in
// questions.mjs; the merged settings writer lives in managed-backends.mjs.

import { formatCtxLabel, renderList, theme, promptConfirm } from "../ui.mjs";
import { detectCapabilities, mtpEnabledFor } from "../capabilities.mjs";
import { readOmlxModelSettings } from "../mlx-discovery.mjs";
import { applyProfileSettingsToOmlx } from "../managed-backends.mjs";
import { backendFor } from "../backends.mjs";
import { capabilitySpecs } from "../model-summary.mjs";
import { effectiveModelId } from "../profiles.mjs";
import { hint, ask, CancelSetup, askThinkingLevel, askOmlxThinkingControl } from "./questions.mjs";

export async function configureOmlxProfile(profile) {
  let configured = profile;
  const modelId = effectiveModelId(profile);

  // Server-reported context (max_model_len) beats config.json when available.
  // Profiles created before context-length persistence (v2.5.0) lack this
  // fact; Reconfigure re-detects it.
  let serverContext = null;
  try {
    const entry = (await backendFor("omlx").scanModels())
      .find((m) => m.id.toLowerCase() === modelId.toLowerCase());
    serverContext = entry?.contextLength ?? null;
  } catch { /* oMLX unreachable — detector falls back to config.json */ }

  const { mtpReason, ...facts } = await detectCapabilities({ backend: "omlx", modelId, contextLength: serverContext });
  configured = { ...configured, capabilities: { ...(configured.capabilities ?? {}), ...facts } };
  const serverSettings = await readOmlxModelSettings(modelId);

  console.log("");
  console.log(theme.bold("Model overview"));
  console.log(renderList([
    ["Model", theme.bold(profile.label)],
    ["Detected", capabilitySpecs(facts)],
    ["Backend", "oMLX (managed server)"],
    ["Context", facts.contextLength ? formatCtxLabel(facts.contextLength) : "unknown"],
  ]));

  if (facts.mtp) {
    console.log("");
    hint("oMLX native MTP — speculative decoding enabled at load time");
    const useMtp = await ask(promptConfirm({ message: "Use MTP speculative decoding?", initialValue: mtpEnabledFor(configured) }));
    configured = { ...configured, mtpEnabled: useMtp };
  } else if (mtpReason && mtpReason !== "model has no MTP heads in config") {
    console.log("");
    hint(`MTP not available — ${mtpReason}`);
  }

  const dflashOn = serverSettings?.dflash_enabled === true;
  if (facts.thinking) {
    // Off/budget first: answering "off" makes the level question moot.
    configured = await askOmlxThinkingControl(configured, serverSettings);
    if (!configured.thinkingOff) {
      if (dflashOn) {
        console.log("");
        hint("DFlash engine path: levels apply (soft steering, ~2x swing) — no hard budget on this path.");
      }
      configured = await askThinkingLevel(configured, "omlx");
    } else {
      console.log("");
      hint("Thinking is off — harness thinking toggles for this model are hidden so they can't override it.");
    }
  }

  // Summary repeats only what changed since the overview — Model/Backend/
  // Context were already shown above.
  console.log("");
  console.log(theme.bold("Setup summary"));
  console.log(renderList([
    ["Thinking", configured.thinkingOff
      ? "off entirely (server-side, hard)"
      : (configured.thinkingLevel ?? "harness default") + (dflashOn && facts.thinking ? " · soft steering on DFlash" : "")],
    ...(configured.thinkingBudget ? [["Thinking budget", `${configured.thinkingBudget.toLocaleString()} tokens`]] : []),
    ...(mtpEnabledFor(configured) && facts.mtp ? [["MTP", "enabled"]] : []),
    ...(facts.vision ? [["Vision", "yes"]] : []),
  ]));
  console.log(theme.subtle("  Server settings (quant, KV cache, MTP internals) live in the oMLX dashboard."));

  if (!(await ask(promptConfirm({ message: "Save profile with these settings?", initialValue: true })))) return null;
  // One source-of-truth writer (A4): pushes every profile-owned oMLX setting
  // (MTP, thinking on/off, budget) — drift-only, silent when in sync.
  await applyProfileSettingsToOmlx(configured);
  return configured;
}
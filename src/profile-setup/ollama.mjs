// Ollama profile setup/reconfigure (A1). Thin — Ollama owns everything
// server-side; we only record facts + the thinking level preference.

import { formatCtxLabel, renderList, theme, promptConfirm } from "../ui.mjs";
import { detectCapabilities } from "../capabilities.mjs";
import { capabilitySpecs } from "../model-summary.mjs";
import { effectiveModelId } from "../profiles.mjs";
import { ask, CancelSetup, askThinkingLevel } from "./questions.mjs";

export async function configureOllamaProfile(profile) {
  let configured = profile;
  const modelId = effectiveModelId(profile);
  let facts = null;
  try {
    facts = await detectCapabilities({ backend: "ollama", modelId });
    configured = { ...configured, capabilities: { ...(configured.capabilities ?? {}), ...facts } };
  } catch { /* model info unavailable — keep existing facts */ }

  if (facts) {
    console.log("");
    console.log(theme.bold("Model overview"));
    console.log(renderList([
      ["Model", theme.bold(profile.label)],
      ["Detected", capabilitySpecs(facts)],
      ["Backend", "Ollama (managed server)"],
      ["Context", facts.contextLength ? formatCtxLabel(facts.contextLength) : "unknown"],
      ...(facts.tools ? [["Tools", "yes"]] : []),
    ]));
  }

  configured = await askThinkingLevel(configured, "ollama");

  console.log("");
  console.log(theme.bold("Setup summary"));
  console.log(renderList([
    ["Model ID", modelId],
    ["Thinking", configured.thinkingLevel ?? "harness default"],
  ]));
  console.log(theme.subtle("  Server settings live in the Ollama app / OLLAMA_* environment."));

  if (!(await ask(promptConfirm({ message: "Save profile with these settings?", initialValue: true })))) return null;
  return configured;
}
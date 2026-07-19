import { findLlamaServer, ensureDirs, omlxEnabled, ollamaEnabled } from "../config.mjs";
import { currentPackageVersion } from "../updates.mjs";
import { backendFor } from "../backends.mjs";
import { scanGgufModels } from "../scan.mjs";
import { loadProfiles } from "../profiles.mjs";
import { hasPi } from "../harness-pi.mjs";
import { hasOmlx } from "../omlx-runtime.mjs";
import { hasOllama } from "../ollama-runtime.mjs";
import { scanManagedModels } from "../managed.mjs";
import { appHeader, card, status, startInteractive, theme } from "../ui.mjs";
import { showReleaseNotesIfUpdated } from "../changelog.mjs";
import { onboardFlow } from "./onboard.mjs";
import { modelCommandCenter } from "./models.mjs";
import { statusCommand } from "./status.mjs";

export async function mainFlow({ showReleaseNotes = false } = {}) {
  await ensureDirs();

  const llamaBinary = await findLlamaServer();
  const { models: ggufModels, drafters } = await scanGgufModels();
  const managedModels = await scanManagedModels();
  const profiles = await loadProfiles();
  const hasAnyBackend = llamaBinary || managedModels.some((item) => item.status === "ok" && item.models.length > 0);
  const hasAnyModels = ggufModels.length > 0 || managedModels.some((item) => item.status === "ok" && item.models.length > 0);

  const piInstalled = await hasPi();
  const needsLlama = ggufModels.length > 0 || profiles.some((profile) => backendFor(profile.backend).type === "local-server");
  const missingDeps = [];
  if (needsLlama && !llamaBinary) missingDeps.push("llama-server");
  if (!piInstalled) missingDeps.push("Pi");
  if (missingDeps.length > 0) {
    if (!process.stdin.isTTY) throw new Error(`Missing dependencies: ${missingDeps.join(", ")}. Run offgrid-ai interactively to install.`);
    console.log(status({ kind: "warning", message: `Missing: ${missingDeps.join(", ")}` }));
    console.log(theme.subtle("offgrid-ai needs these to run. Let's finish setup.\n"));
    const result = await onboardFlow();
    if (result === "success") return mainFlow();
    return;
  }

  if (!hasAnyBackend && !hasAnyModels && profiles.length === 0) {
    if (!process.stdin.isTTY) throw new Error("No local LLM backends found. Run offgrid-ai interactively to set up.");
    const result = await onboardFlow();
    if (result === "success") return mainFlow();
    return;
  }

  if (!process.stdin.isTTY) {
    if (!hasAnyModels && profiles.length === 0) throw new Error("No models found. Download a model, then run offgrid-ai.");
    return await statusCommand();
  }

  const omlxOn = await omlxEnabled();
  const ollamaOn = await ollamaEnabled();
  startInteractive("offgrid-ai");
  if (showReleaseNotes) await showReleaseNotesIfUpdated();

  console.log(appHeader({ name: "offgrid-ai", version: currentPackageVersion() }));
  printStatusHeader({
    llamaBinary,
    managedModels,
    piInstalled,
    omlxInstalled: omlxOn ? await hasOmlx() : false,
    showOmlx: omlxOn,
    ollamaInstalled: ollamaOn ? await hasOllama() : false,
    ollamaServerUp: managedModels.some((m) => m.backendId === "ollama" && m.status === "ok"),
    showOllama: ollamaOn,
    profiles,
  });
  console.log("");

  return await modelCommandCenter({ profiles, ggufModels, managedModels, drafters });
}

function printStatusHeader({ llamaBinary, managedModels, piInstalled, omlxInstalled, showOmlx, ollamaInstalled, ollamaServerUp, showOllama, profiles }) {
  const parts = [
    llamaBinary ? status({ kind: "success", message: "llama.cpp" }) : status({ kind: "error", message: "llama.cpp" }),
  ];
  if (showOmlx) {
    const omlxServerUp = managedModels.some((m) => m.backendId === "omlx" && m.status === "ok");
    if (omlxInstalled) {
      parts.push(omlxServerUp ? status({ kind: "success", message: "oMLX · server up" }) : status({ kind: "warning", message: "oMLX · server down" }));
    } else {
      parts.push(status({ kind: "error", message: "oMLX" }));
    }
  }
  if (showOllama) {
    if (ollamaInstalled) {
      parts.push(ollamaServerUp ? status({ kind: "success", message: "Ollama · server up" }) : status({ kind: "warning", message: "Ollama · server down" }));
    } else {
      parts.push(status({ kind: "error", message: "Ollama" }));
    }
  }
  parts.push(piInstalled ? status({ kind: "success", message: "Pi" }) : status({ kind: "error", message: "Pi" }));
  if (profiles.length > 0) {
    const counts = new Map();
    for (const profile of profiles) {
      const label = backendFor(profile.backend).label;
      counts.set(label, (counts.get(label) ?? 0) + 1);
    }
    const ordered = ["llama.cpp"];
    if (showOmlx) ordered.push("oMLX");
    if (showOllama) ordered.push("Ollama");
    for (const label of counts.keys()) {
      if (!ordered.includes(label)) ordered.push(label);
    }
    const breakdown = ordered.map((label) => `${label} (${counts.get(label) ?? 0})`).join(" | ");
    const total = `${profiles.length} model${profiles.length === 1 ? "" : "s"}`;
    parts.push(`${theme.bold(total)} ${theme.subtle("→")} ${breakdown}`);
  }
  console.log(card({ title: "offgrid-ai", body: parts.join("  \n") }));
}


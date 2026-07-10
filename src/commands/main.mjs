import { findLlamaServer, ensureDirs, omlxEnabled, ollamaEnabled } from "../config.mjs";
import { backendFor } from "../backends.mjs";
import { scanGgufModels } from "../scan.mjs";
import { loadProfiles } from "../profiles.mjs";
import { hasPi } from "../harness-pi.mjs";
import { hasOmlx } from "../omlx-runtime.mjs";
import { hasOllama, OLLAMA_URLS } from "../ollama-runtime.mjs";
import { scanManagedModels } from "../managed.mjs";
import { pc, startInteractive, renderCard } from "../ui.mjs";
import { onboardFlow } from "./onboard.mjs";
import { modelCommandCenter } from "./models.mjs";
import { statusCommand } from "./status.mjs";

export async function mainFlow() {
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
    console.log(pc.yellow(`Missing: ${missingDeps.join(", ")}`));
    console.log(pc.dim("offgrid-ai needs these to run. Let's finish setup.\n"));
    const result = await onboardFlow();
    // Chain: on success, re-scan and continue to the picker (fresh state).
    // On decline or failure, exit.
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

  // Interactive: show the picker (even with no models — user can download)
  const omlxOn = await omlxEnabled();
  const ollamaOn = await ollamaEnabled();
  startInteractive("offgrid-ai");
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
  console.log(pc.dim("  No models? Pick \"↓ Download a model\" below — offgrid-ai downloads from HuggingFace"));
  console.log("");
  return await modelCommandCenter({ profiles, ggufModels, managedModels, drafters });
}

function printStatusHeader({ llamaBinary, managedModels, piInstalled, omlxInstalled, showOmlx, ollamaInstalled, ollamaServerUp, showOllama, profiles }) {
  const parts = [
    llamaBinary ? pc.green("llama.cpp ✓") : pc.red("llama.cpp ✗"),
  ];
  if (showOmlx) {
    const omlxServerUp = managedModels.some((m) => m.backendId === "omlx" && m.status === "ok");
    if (omlxInstalled) {
      parts.push(omlxServerUp ? pc.green("oMLX ✓ server up") : pc.yellow("oMLX ✓ server down"));
    } else {
      parts.push(pc.red("oMLX ✗"));
    }
  }
  if (showOllama) {
    if (ollamaInstalled) {
      parts.push(ollamaServerUp ? pc.green("Ollama ✓ server up") : pc.yellow("Ollama ✓ server down"));
    } else {
      parts.push(pc.red("Ollama ✗"));
    }
  }
  parts.push(piInstalled ? pc.green("Pi ✓") : pc.red("Pi ✗"));
  if (profiles.length > 0) parts.push(pc.dim(`${profiles.length} model${profiles.length === 1 ? "" : "s"}`));
  console.log(renderCard("offgrid-ai", parts.join(pc.dim("  ·  ")), { formatBorder: pc.cyan }));
  console.log("");
}
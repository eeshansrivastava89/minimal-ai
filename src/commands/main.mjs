import { findLlamaServer, ensureDirs } from "../config.mjs";
import { currentPackageVersion } from "../updates.mjs";
import { backendFor } from "../backends.mjs";
import { scanGgufModels } from "../scan.mjs";
import { loadProfiles } from "../profiles.mjs";
import { configuredHarness } from "../harnesses.mjs";
import { hasOmlx } from "../omlx-runtime.mjs";
import { hasOllama } from "../ollama-runtime.mjs";
import { scanManagedModels } from "../managed.mjs";
import { appHeader, status, theme, maxWidth, visibleLen } from "../ui.mjs";
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

  const harness = await configuredHarness();
  const harnessInstalled = await harness.detect();
  const needsLlama = ggufModels.length > 0 || profiles.some((profile) => backendFor(profile.backend).type === "local-server");
  const missingDeps = [];
  if (needsLlama && !llamaBinary) missingDeps.push("llama-server");
  if (!harnessInstalled) missingDeps.push(harness.label);
  if (missingDeps.length > 0) {
    if (!process.stdin.isTTY) throw new Error(`Missing dependencies: ${missingDeps.join(", ")}. Run minimal-ai interactively to install.`);
    console.log(status({ kind: "warning", message: `Missing: ${missingDeps.join(", ")}` }));
    console.log(theme.subtle("minimal-ai needs these to run. Let's finish setup.\n"));
    const result = await onboardFlow();
    if (result === "success") return mainFlow();
    return;
  }

  if (!hasAnyBackend && !hasAnyModels && profiles.length === 0) {
    if (!process.stdin.isTTY) throw new Error("No local LLM backends found. Run minimal-ai interactively to set up.");
    const result = await onboardFlow();
    if (result === "success") return mainFlow();
    return;
  }

  if (!process.stdin.isTTY) {
    if (!hasAnyModels && profiles.length === 0) throw new Error("No models found. Download a model, then run minimal-ai.");
    return await statusCommand();
  }

  const isAppleSilicon = process.platform === "darwin" && process.arch === "arm64";
  if (showReleaseNotes) await showReleaseNotesIfUpdated();

  console.log(appHeader({ name: "minimal-ai", version: currentPackageVersion() }));
  printStatusHeader({
    llamaBinary,
    managedModels,
    harness,
    harnessInstalled,
    omlxInstalled: isAppleSilicon ? await hasOmlx() : false,
    showOmlx: isAppleSilicon,
    ollamaInstalled: await hasOllama(),
    ollamaServerUp: managedModels.some((m) => m.backendId === "ollama" && m.status === "ok"),
    profiles,
  });
  console.log("");

  return await modelCommandCenter({ profiles, ggufModels, managedModels, drafters });
}

function printStatusHeader({ llamaBinary, managedModels, harness, harnessInstalled, omlxInstalled, showOmlx, ollamaInstalled, ollamaServerUp, profiles }) {
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
  if (ollamaInstalled) {
    parts.push(ollamaServerUp ? status({ kind: "success", message: "Ollama · server up" }) : status({ kind: "warning", message: "Ollama · server down" }));
  } else {
    parts.push(status({ kind: "error", message: "Ollama" }));
  }
  parts.push(harnessInstalled ? status({ kind: "success", message: harness.label }) : status({ kind: "error", message: harness.label }));
  if (profiles.length > 0) {
    const counts = new Map();
    for (const profile of profiles) {
      const label = backendFor(profile.backend).label;
      counts.set(label, (counts.get(label) ?? 0) + 1);
    }
    const ordered = ["llama.cpp"];
    if (showOmlx) ordered.push("oMLX");
    ordered.push("Ollama");
    for (const label of counts.keys()) {
      if (!ordered.includes(label)) ordered.push(label);
    }
    const breakdown = ordered.map((label) => `${label} (${counts.get(label) ?? 0})`).join(" | ");
    const total = `${profiles.length} model${profiles.length === 1 ? "" : "s"}`;
    parts.push(`${theme.bold(total)} ${theme.subtle("→")} ${breakdown}`);
  }
  // Plain status line(s), no box — one line when it fits, one per item when
  // it doesn't.
  const oneLine = parts.join("  ");
  console.log(visibleLen(oneLine) <= maxWidth() ? oneLine : parts.join("\n"));
}


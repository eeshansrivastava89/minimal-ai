import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { findLlamaServer, getModelScanDirs, addModelScanDir, removeModelScanDir, DEFAULT_MODEL_DIRS, HF_HUB_DIR } from "../config.mjs";
import { backendFor, BACKENDS } from "../backends.mjs";
import { stopOrUnload, serverReady, runningProfiles } from "../process.mjs";
import { hasOmlx } from "../omlx-runtime.mjs";
import { hasOllama } from "../ollama-runtime.mjs";
import { configuredHarness, listHarnesses, harnessFor, setConfiguredHarness, syncAllProfiles } from "../harnesses.mjs";
import { renderList, status, theme, promptChoice, promptText } from "../ui.mjs";

export async function runtimeStatusFlow() {
  while (true) {
    const llamaBinary = await findLlamaServer();
    const omlxInstalled = await hasOmlx();
    const ollamaInstalled = await hasOllama();
    const harness = await configuredHarness();
    const harnessInstalled = await harness.detect();

    const running = await runningProfiles();

    let omlxServerUp = false;
    if (omlxInstalled) omlxServerUp = await serverReady(BACKENDS.omlx.defaultBaseUrl);
    let ollamaServerUp = false;
    if (ollamaInstalled) ollamaServerUp = await serverReady(BACKENDS.ollama.defaultBaseUrl);

    const runtimeRows = [
      ["llama.cpp", llamaBinary ? status({ kind: "success", message: llamaBinary }) : status({ kind: "error", message: "not found" })],
    ];
    runtimeRows.push([
      "oMLX",
      omlxInstalled
        ? (omlxServerUp ? status({ kind: "success", message: "server up" }) : status({ kind: "warning", message: "installed · server down" }))
        : status({ kind: "error", message: "not found" }),
    ]);
    runtimeRows.push([
      "Ollama",
      ollamaInstalled
        ? (ollamaServerUp ? status({ kind: "success", message: "server up" }) : status({ kind: "warning", message: "installed · server down" }))
        : status({ kind: "error", message: "not found" }),
    ]);
    runtimeRows.push([`${harness.label} (harness)`, harnessInstalled ? status({ kind: "success", message: "installed" }) : status({ kind: "error", message: "not found" })]);

    console.log();
    console.log(theme.bold("Runtime status"));
    console.log(renderList(runtimeRows));

    if (running.length > 0) {
      const runningRows = running.map(({ profile, status: s }) => {
        const backend = backendFor(profile.backend);
        const state = s.ready ? status({ kind: "success", message: "running" }) : status({ kind: "warning", message: "starting" });
        return [profile.label, `${backend.label} · ${state} · ${profile.baseUrl}`];
      });
      console.log();
      console.log(theme.bold("Running models"));
      console.log(renderList(runningRows));
    }

    console.log("");

    const choices = [
      ...(running.length > 0 ? [{ value: "stop", label: "Stop a running server" }] : []),
      { value: "done", label: "Done" },
    ];
    const action = await promptChoice({ message: "Runtime status", choices, defaultValue: "done" });

    if (!action || action === "done") return;

    if (action === "stop") {
      const stopChoices = running.map(({ profile }) => ({
        value: profile.id,
        label: profile.label,
        hint: `${backendFor(profile.backend).label} · ${profile.baseUrl}`,
      }));
      stopChoices.push({ value: "__cancel", label: "Cancel" });
      const toStop = await promptChoice({ message: "Stop which server?", choices: stopChoices, defaultValue: stopChoices[0].value });
      if (!toStop || toStop === "__cancel") continue;
      const target = running.find((r) => r.profile.id === toStop);
      if (target) await stopOrUnload(target.profile);
    }
  }
}

export async function discoveryPathsFlow() {
  while (true) {
    const scanDirs = await getModelScanDirs();
    const defaultSet = new Set(DEFAULT_MODEL_DIRS);
    const pathLabels = new Map([
      [join(homedir(), ".lmstudio", "models"), "LM Studio downloads"],
      [join(homedir(), ".omlx", "models"), "oMLX downloads"],
      [HF_HUB_DIR, "HuggingFace CLI downloads"],
    ]);
    const pathRows = scanDirs.map((dir) => {
      const exists = existsSync(dir);
      const isBuiltin = defaultSet.has(dir);
      const desc = pathLabels.get(dir);
      const label = `${exists ? status({ kind: "success", message: "" }) : status({ kind: "error", message: "" })}  ${dir}`;
      const tags = [desc, isBuiltin ? "built-in" : "custom"].filter(Boolean).join(theme.subtle(" · "));
      return [label, theme.subtle(tags)];
    });

    console.log();
    console.log(theme.bold("Discovery paths"));
    console.log(renderList(pathRows));

    console.log("");

    const customDirs = scanDirs.filter((d) => !defaultSet.has(d));
    const choices = [
      { value: "add", label: "Add discovery path" },
      ...(customDirs.length > 0 ? [{ value: "remove", label: "Remove discovery path" }] : []),
      { value: "done", label: "Done" },
    ];
    const action = await promptChoice({ message: "Discovery paths", choices, defaultValue: "done" });

    if (!action || action === "done") return;

    if (action === "add") {
      const dir = await promptText({ message: "Path to model directory", defaultValue: "" });
      if (!dir || !dir.trim()) continue;
      const cleanDir = dir.trim();
      if (!existsSync(cleanDir)) {
        console.log(status({ kind: "error", message: `Directory not found: ${cleanDir}` }));
        continue;
      }
      await addModelScanDir(cleanDir);
      console.log(status({ kind: "success", message: `Added: ${cleanDir}` }));
    }

    if (action === "remove") {
      const removeChoices = customDirs.map((d) => ({ value: d, label: d }));
      const toRemove = await promptChoice({ message: "Remove path", choices: removeChoices });
      if (!toRemove) continue;
      await removeModelScanDir(toRemove);
      console.log(status({ kind: "success", message: `Removed: ${toRemove}` }));
    }
  }
}

export async function harnessFlow() {
  const current = await configuredHarness();
  const choices = listHarnesses().map((h) => ({
    value: h.id,
    label: h.id === current.id ? `${h.label} (current)` : h.label,
    hint: h.bin,
  }));
  const pick = await promptChoice({ message: "Chat harness — the UI minimal-ai launches for chatting", choices, defaultValue: current.id });
  if (!pick || pick === current.id) return;

  const harness = harnessFor(pick);
  await setConfiguredHarness(pick);
  console.log(status({ kind: "success", message: `Harness set to ${harness.label}. New runs will launch ${harness.bin}.` }));

  if (!(await harness.detect())) {
    console.log(status({ kind: "warning", message: `${harness.label} is not installed: npm install -g ${harness.npm}` }));
  }
  const providers = await syncAllProfiles(harness);
  if (providers > 0) {
    console.log(theme.subtle(`Synced existing setups to ${harness.label} so your models are available there.`));
  }
}

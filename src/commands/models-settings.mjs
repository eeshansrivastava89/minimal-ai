import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { findLlamaServer, getModelScanDirs, addModelScanDir, removeModelScanDir, DEFAULT_MODEL_DIRS, HF_HUB_DIR, omlxEnabled, ollamaEnabled } from "../config.mjs";
import { backendFor, BACKENDS } from "../backends.mjs";
import { stopProfile, unloadModelFromServer } from "../process.mjs";
import { serverReady } from "../server-check.mjs";
import { runningProfiles } from "./stop.mjs";
import { hasOmlx } from "../omlx-runtime.mjs";
import { hasOllama } from "../ollama-runtime.mjs";
import { hasPi } from "../harness-pi.mjs";
import { card, renderList, status, theme, promptChoice, promptText } from "../ui.mjs";

export async function runtimeStatusFlow() {
  while (true) {
    const llamaBinary = await findLlamaServer();
    const omlxOn = await omlxEnabled();
    const omlxInstalled = omlxOn ? await hasOmlx() : false;
    const ollamaOn = await ollamaEnabled();
    const ollamaInstalled = ollamaOn ? await hasOllama() : false;
    const piInstalled = await hasPi();

    const running = await runningProfiles();

    let omlxServerUp = false;
    if (omlxInstalled) omlxServerUp = await serverReady(BACKENDS.omlx.defaultBaseUrl);
    let ollamaServerUp = false;
    if (ollamaInstalled) ollamaServerUp = await serverReady(BACKENDS.ollama.defaultBaseUrl);

    const runtimeRows = [
      ["llama.cpp", llamaBinary ? status({ kind: "success", message: llamaBinary }) : status({ kind: "error", message: "not found" })],
    ];
    if (omlxOn) {
      runtimeRows.push([
        "oMLX",
        omlxInstalled
          ? (omlxServerUp ? status({ kind: "success", message: "server up" }) : status({ kind: "warning", message: "installed · server down" }))
          : status({ kind: "error", message: "not found" }),
      ]);
    }
    if (ollamaOn) {
      runtimeRows.push([
        "Ollama",
        ollamaInstalled
          ? (ollamaServerUp ? status({ kind: "success", message: "server up" }) : status({ kind: "warning", message: "installed · server down" }))
          : status({ kind: "error", message: "not found" }),
      ]);
    }
    runtimeRows.push(["Pi", piInstalled ? status({ kind: "success", message: "installed" }) : status({ kind: "error", message: "not found" })]);

    console.log();
    console.log(card({ title: "Runtime status", body: renderList(runtimeRows) }));

    if (running.length > 0) {
      const runningRows = running.map(({ profile, status: s }) => {
        const backend = backendFor(profile.backend);
        const state = s.ready ? status({ kind: "success", message: "running" }) : status({ kind: "warning", message: "starting" });
        return [profile.label, `${backend.label} · ${state} · ${profile.baseUrl}`];
      });
      console.log();
      console.log(card({ title: "Running models", body: renderList(runningRows) }));
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
      if (target) {
        const isManaged = backendFor(target.profile.backend).type === "managed-server";
        if (isManaged) {
          const result = await unloadModelFromServer(target.profile);
          if (result.unloaded) console.log(status({ kind: "success", message: `[unload] ${target.profile.label}: model unloaded` }));
          else if (result.error) console.log(status({ kind: "warning", message: `[unload] ${target.profile.label}: ${result.error}` }));
          else console.log(theme.subtle(`[unload] ${target.profile.label}: ${result.reason ?? "nothing to unload"}`));
        } else {
          const result = await stopProfile(target.profile);
          console.log(result.stopped ? status({ kind: "success", message: `[stop] ${result.message}` }) : theme.subtle(`[stop] ${result.message}`));
        }
      }
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
    console.log(card({ title: "Discovery paths", body: renderList(pathRows) }));

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

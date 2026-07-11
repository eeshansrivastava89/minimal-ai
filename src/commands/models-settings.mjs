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
import { pc, renderCard, renderRows } from "../ui.mjs";

export async function settingsFlow(prompt) {
  while (true) {
    const llamaBinary = await findLlamaServer();
    const omlxOn = await omlxEnabled();
    const omlxInstalled = omlxOn ? await hasOmlx() : false;
    const ollamaOn = await ollamaEnabled();
    const ollamaInstalled = ollamaOn ? await hasOllama() : false;
    const piInstalled = await hasPi();

    // Collect running profiles for the running-models card
    const running = await runningProfiles();

    let omlxServerUp = false;
    if (omlxInstalled) {
      omlxServerUp = await serverReady(BACKENDS.omlx.defaultBaseUrl);
    }
    let ollamaServerUp = false;
    if (ollamaInstalled) {
      ollamaServerUp = await serverReady(BACKENDS.ollama.defaultBaseUrl);
    }

    const runtimeRows = [
      ["llama.cpp", llamaBinary ? pc.green("✓ ") + pc.dim(llamaBinary) : pc.red("✗ not found")],
    ];
    if (omlxOn) {
      runtimeRows.push(["oMLX", omlxInstalled ? (omlxServerUp ? pc.green("✓ server up") : pc.yellow("✓ installed · server down")) : pc.red("✗ not found")]);
    }
    if (ollamaOn) {
      runtimeRows.push(["Ollama", ollamaInstalled ? (ollamaServerUp ? pc.green("✓ server up") : pc.yellow("✓ installed · server down")) : pc.red("✗ not found")]);
    }
    runtimeRows.push(["Pi", piInstalled ? pc.green("✓ installed") : pc.red("✗ not found")]);

    console.log("");
    console.log(renderCard("Runtime status", renderRows(runtimeRows), { formatBorder: pc.cyan }));

    // Show running models card if any servers are active
    if (running.length > 0) {
      const runningRows = running.map(({ profile, status: s }) => {
        const backend = backendFor(profile.backend);
        const state = s.ready ? pc.green("running") : pc.yellow("starting");
        return [`${pc.green("●")} ${profile.label}`, `${backend.label} · ${state} · ${profile.baseUrl}`];
      });
      console.log("");
      console.log(renderCard("Running models", renderRows(runningRows), { formatBorder: pc.green }));
    }

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
      const label = `${exists ? pc.green("✓") : pc.red("✗")}  ${dir}`;
      const tags = [desc, isBuiltin ? "built-in" : "custom"].filter(Boolean).join(pc.dim(" · "));
      return [label, pc.dim(tags)];
    });
    console.log("");
    console.log(renderCard("Discovery paths", renderRows(pathRows), { formatBorder: pc.magenta }));

    const customDirs = scanDirs.filter((d) => !defaultSet.has(d));
    const choices = [
      ...(running.length > 0 ? [{ value: "stop", label: "Stop a running server" }] : []),
      { value: "add", label: "Add discovery path" },
      ...(customDirs.length > 0 ? [{ value: "remove", label: "Remove discovery path" }] : []),
      { value: "done", label: "Done" },
    ];
    const action = await prompt.choice("Settings", choices, "done");

    if (!action || action === "done") return;

    if (action === "stop") {
      const stopChoices = running.map(({ profile }) => ({
        value: profile.id,
        label: profile.label,
        hint: `${backendFor(profile.backend).label} · ${profile.baseUrl}`,
      }));
      stopChoices.push({ value: "__cancel", label: "Cancel" });
      const toStop = await prompt.choice("Stop which server?", stopChoices, stopChoices[0].value);
      if (!toStop || toStop === "__cancel") continue;
      const target = running.find((r) => r.profile.id === toStop);
      if (target) {
        const isManaged = backendFor(target.profile.backend).type === "managed-server";
        if (isManaged) {
          const result = await unloadModelFromServer(target.profile);
          if (result.unloaded) console.log(pc.green(`[unload] ${target.profile.label}: model unloaded`));
          else if (result.error) console.log(pc.yellow(`[unload] ${target.profile.label}: ${result.error}`));
          else console.log(pc.dim(`[unload] ${target.profile.label}: ${result.reason ?? "nothing to unload"}`));
        } else {
          const result = await stopProfile(target.profile);
          console.log(result.stopped ? pc.green(`[stop] ${result.message}`) : pc.dim(`[stop] ${result.message}`));
        }
      }
    }

    if (action === "add") {
      const dir = await prompt.text("Path to model directory", "");
      if (!dir || !dir.trim()) continue;
      const cleanDir = dir.trim();
      if (!existsSync(cleanDir)) {
        console.log(pc.red(`Directory not found: ${cleanDir}`));
        continue;
      }
      await addModelScanDir(cleanDir);
      console.log(pc.green(`Added: ${cleanDir}`));
    }

    if (action === "remove") {
      const removeChoices = customDirs.map((d) => ({ value: d, label: d }));
      const toRemove = await prompt.choice("Remove path", removeChoices);
      if (!toRemove) continue;
      await removeModelScanDir(toRemove);
      console.log(pc.green(`Removed: ${toRemove}`));
    }
  }
}
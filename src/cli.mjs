import { spawn } from "node:child_process";

import { checkForUpdate, currentPackageVersion, detectInvocation, updateCommand, installedGlobalVersion, forceReinstall } from "./updates.mjs";
import { fetchRemoteChangelog, entriesBetween, printReleaseNotes } from "./changelog.mjs";
import { checkLlamaUpdate, installLlamaRelease } from "./runtime.mjs";
import { checkOmlxUpdate } from "./omlx-runtime.mjs";
import { checkOllamaUpdate } from "./ollama-runtime.mjs";
import { createCli, runCli, appHeader, section, infoCard, renderList, status, formatError, theme, promptConfirm } from "./ui.mjs";

import { mainFlow } from "./commands/main.mjs";
import { modelsCommand } from "./commands/models.mjs";
import { runCommand } from "./commands/run.mjs";
import { autotuneCommand } from "./commands/autotune.mjs";
import { statusCommand } from "./commands/status.mjs";
import { stopCommand } from "./commands/stop.mjs";
import { uninstallCommand } from "./commands/uninstall.mjs";

async function offerUpdate() {
  const update = await checkForUpdate();
  if (!update) return false;

  console.log();
  console.log(infoCard("Update available", `v${update.latest} is available (you have v${update.current}).\nRun: minimal-ai update`, { tone: "warning" }));

  const remoteEntries = await fetchRemoteChangelog(`v${update.latest}`);
  const notes = entriesBetween(remoteEntries, update.current, update.latest);
  if (notes.length > 0) {
    printReleaseNotes(notes);
  }

  return true;
}

// External apps (oMLX, Ollama) manage their own updates and channels — we
// only notify. llama.cpp is our managed runtime, so we update it ourselves.
const EXTERNAL_UPDATE_HINTS = {
  "oMLX": "update from the oMLX menubar app",
  "Ollama": "brew upgrade ollama  ·  ollama.com/download",
};

async function offerRuntimeUpdates() {
  if (!process.stdin.isTTY) return;
  const llamaUpdate = await checkLlamaUpdate();
  const externalUpdates = [];
  if (process.platform === "darwin" && process.arch === "arm64") {
    const omlxUpdate = await checkOmlxUpdate();
    if (omlxUpdate) externalUpdates.push({ kind: "oMLX", ...omlxUpdate });
  }
  const ollamaUpdate = await checkOllamaUpdate();
  if (ollamaUpdate) externalUpdates.push({ kind: "Ollama", ...ollamaUpdate });
  if (!llamaUpdate && externalUpdates.length === 0) return;

  const rows = [];
  if (llamaUpdate) rows.push(["llama.cpp", `${llamaUpdate.latest} available (you have ${llamaUpdate.installed})`]);
  for (const u of externalUpdates) {
    rows.push([u.kind, `${u.latest} available (you have ${u.installed}) — ${EXTERNAL_UPDATE_HINTS[u.kind]}`]);
  }
  console.log();
  console.log(theme.bold(theme.warning(section("Runtime updates available"))));
  console.log(renderList(rows));

  if (!llamaUpdate) return;
  const shouldUpdate = await promptConfirm({ message: "Update llama.cpp now?", initialValue: true });
  if (!shouldUpdate) return;
  await installLlamaRelease(llamaUpdate.release);
  console.log(status({ kind: "success", message: "llama.cpp updated." }));
}

async function runUpdate() {
  const invocation = detectInvocation();
  const plan = updateCommand(invocation, ["update"]);
  const before = currentPackageVersion();
  console.log(status({ kind: "info", message: `Running: ${plan.display}` }));
  await new Promise((resolve, reject) => {
    const child = spawn(plan.cmd, plan.args, { stdio: "inherit" });
    child.on("error", reject);
    child.on("exit", (code) => code === 0 ? resolve() : reject(new Error(`${plan.cmd} exited with code ${code}`)));
  });

  let installed = installedGlobalVersion();
  if (installed && installed === before) {
    console.log(status({ kind: "warning", message: "npm didn't update — clearing cache and retrying..." }));
    await forceReinstall(plan);
    installed = installedGlobalVersion();
  }

  if (installed && installed !== before) {
    console.log(status({ kind: "success", message: "Updated. Run minimal-ai again to use the new version." }));
  } else if (installed && installed === before) {
    console.log(status({ kind: "error", message: `Update failed — still v${installed}. Try manually:\n  npm cache clean --force && npm install -g minimal-ai@latest` }));
  } else {
    console.log(status({ kind: "success", message: "Updated. Run minimal-ai again to use the new version." }));
  }
}

async function printVersion() {
  const version = currentPackageVersion();
  console.log(appHeader({ name: "minimal-ai", version }));
  const update = await checkForUpdate();
  if (update) {
    console.log(status({ kind: "warning", message: `Update available: v${update.latest}. Run: minimal-ai update` }));
  }
}

function buildProgram() {
  return createCli({
    name: "minimal-ai",
    description: "A privacy-first local AI runner",
    usage: "[command] [--flags]",
    examples: [
      "minimal-ai",
      "minimal-ai run <profile-id>",
      "minimal-ai run <profile-id> --thinking low",
      "minimal-ai autotune <profile-id>",
      "minimal-ai status",
      "minimal-ai update",
    ],
    globalOptions: [
      { flags: "-v, --version", description: "Show version" },
      { flags: "--verbose", description: "Verbose output where supported (e.g. uninstall)" },
      { flags: "--uninstall", description: "Remove minimal-ai" },
    ],
    rootAction: async (options, thisCommand) => {
      if (options.uninstall) return await uninstallCommand(thisCommand.args);
      if (options.version) return await printVersion();
      if (thisCommand.args.length > 0) {
        throw new Error(`Unknown command: ${thisCommand.args[0]}. Run minimal-ai help`);
      }

      if (process.platform === "win32") {
        console.log(formatError("minimal-ai supports macOS and Linux only."));
        console.log(theme.subtle("Windows is not yet supported. Use WSL or a native macOS/Linux machine."));
        return;
      }

      const hasPackageUpdate = await offerUpdate();
      if (hasPackageUpdate) return;
      await offerRuntimeUpdates();
      return await mainFlow({ showReleaseNotes: true });
    },
    commands: [
      {
        name: "models [id]",
        description: "Show model picker or inspect a profile",
        action: ({ args }) => modelsCommand(args),
      },
      {
        name: "run [model]",
        description: "Run a model non-interactively",
        allowUnknownOption: true,
        allowExcessArguments: true,
        action: ({ args }) => {
          if (args.length === 0) return mainFlow();
          return runCommand(args);
        },
      },
      {
        name: "autotune [profile]",
        description: "Find the fastest oMLX settings for a model (speed tune)",
        options: [
          { flags: "--yes", description: "Run non-interactively and apply the recommendation" },
          { flags: "--dry-run", description: "Preview the sweep plan without running it" },
        ],
        allowUnknownOption: true,
        allowExcessArguments: true,
        action: ({ args }) => autotuneCommand(args),
      },
      {
        name: "status",
        description: "Show runtime status",
        action: statusCommand,
      },
      {
        name: "stop [id]",
        description: "Stop a running model server",
        allowUnknownOption: true,
        allowExcessArguments: true,
        action: ({ args }) => stopCommand(args),
      },
      {
        name: "uninstall",
        description: "Remove minimal-ai",
        allowUnknownOption: true,
        allowExcessArguments: true,
        action: ({ args }) => uninstallCommand(args),
      },
      {
        name: "update",
        description: "Update minimal-ai to the latest version",
        action: runUpdate,
      },
      {
        name: "version",
        description: "Show version",
        action: printVersion,
      },
    ],
  });
}

export async function run(argv) {
  const program = buildProgram();
  await runCli(program, argv);
}

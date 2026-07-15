import { pc, renderRows, renderCard } from "./ui.mjs";
import { checkForUpdate, currentPackageVersion, detectInvocation, updateCommand } from "./updates.mjs";
import { fetchRemoteChangelog, entriesBetween, printReleaseNotes } from "./changelog.mjs";
import { omlxEnabled, ollamaEnabled } from "./config.mjs";
import { checkLlamaUpdate } from "./runtime.mjs";
import { checkOmlxUpdate } from "./omlx-runtime.mjs";
import { checkOllamaUpdate } from "./ollama-runtime.mjs";
import { spawn } from "node:child_process";

import { mainFlow } from "./commands/main.mjs";
import { modelsCommand } from "./commands/models.mjs";
import { runCommand } from "./commands/run.mjs";
import { statusCommand } from "./commands/status.mjs";
import { stopCommand } from "./commands/stop.mjs";
import { uninstallCommand } from "./commands/uninstall.mjs";

async function offerUpdate() {
  const update = await checkForUpdate();
  if (!update) return false;

  console.log(pc.yellow(`\nUpdate available: v${update.latest}. You have v${update.current}.\n`));

  // Show release notes for the new version (fetched from GitHub)
  const remoteEntries = await fetchRemoteChangelog(`v${update.latest}`);
  const notes = entriesBetween(remoteEntries, update.current, update.latest);
  if (notes.length > 0) {
    printReleaseNotes(notes);
  }

  console.log(pc.dim(`Run: offgrid-ai update`));
  console.log();
  return true;
}

async function offerRuntimeUpdates() {
  const updates = [];
  const llamaUpdate = await checkLlamaUpdate();
  if (llamaUpdate) updates.push({ kind: "llama.cpp", ...llamaUpdate });
  if (process.platform === "darwin" && process.arch === "arm64" && (await omlxEnabled())) {
    const omlxUpdate = await checkOmlxUpdate();
    if (omlxUpdate) updates.push({ kind: "oMLX", ...omlxUpdate });
  }
  if (await ollamaEnabled()) {
    const ollamaUpdate = await checkOllamaUpdate();
    if (ollamaUpdate) updates.push({ kind: "Ollama", ...ollamaUpdate });
  }
  for (const u of updates) {
    console.log(pc.yellow(`\n${u.kind} update available: ${u.latest} (you have ${u.installed}).`));
  }
  if (updates.length > 0) console.log();
}

export async function run(argv) {
  if (process.platform === "win32") {
    console.log(pc.red("offgrid-ai supports macOS and Linux only."));
    console.log(pc.dim("Windows is not yet supported. Use WSL or a native macOS/Linux machine."));
    return;
  }
  if (argv.length === 0) {
    await offerUpdate();
    await offerRuntimeUpdates();
    return mainFlow({ showReleaseNotes: true });
  }

  const [command] = argv;
  const handlers = {
    help: () => printHelp(),
    "--help": () => printHelp(),
    "-h": () => printHelp(),
    version: () => printVersion(),
    "--version": () => printVersion(),
    "-v": () => printVersion(),
    update: () => runUpdate(),
    models: () => modelsCommand(argv.slice(1)),
    run: () => {
      const runArgs = argv.slice(1);
      if (!runArgs[0]) return mainFlow();
      return runCommand(runArgs);
    },
    status: () => statusCommand(),
    stop: () => stopCommand(argv.slice(1)),
    uninstall: () => uninstallCommand(argv.slice(1)),
    "--uninstall": () => uninstallCommand(argv.slice(1)),
    "--verbose": () => mainFlow(),
  };
  const handler = handlers[command];
  if (handler) return handler();
  throw new Error(`Unknown command: ${command}. Run offgrid-ai help`);
}

async function runUpdate() {
  const invocation = detectInvocation();
  const plan = updateCommand(invocation, ["update"]);
  console.log(pc.dim(`Running: ${plan.display}`));
  await new Promise((resolve, reject) => {
    const child = spawn(plan.cmd, plan.args, { stdio: "inherit" });
    child.on("error", reject);
    child.on("exit", (code) => code === 0 ? resolve() : reject(new Error(`${plan.cmd} exited with code ${code}`)));
  });
  console.log(pc.green("Updated. Run offgrid-ai again to use the new version."));
}

async function printVersion() {
  const version = currentPackageVersion();
  console.log(`offgrid-ai v${version}`);
  const update = await checkForUpdate();
  if (update) {
    console.log(pc.yellow(`Update available: v${update.latest}. Run: offgrid-ai update`));
  }
}

function printHelp() {
  console.log(renderCard("offgrid-ai", renderRows([
    ["What it is", "A privacy-first local AI runner"],
    ["Start", pc.bold("offgrid-ai")],
    ["Update", "offgrid-ai update"],
    ["Status", "offgrid-ai status"],
    ["Stop", "offgrid-ai stop"],
    ["Uninstall", "offgrid-ai uninstall"],
    ["Version", "offgrid-ai version"],
  ]), { formatBorder: pc.cyan }));
  console.log("\n" + renderCard("How it works", "Run offgrid-ai, choose a local model, and start chatting in Pi.\n\nFirst run walks you through missing tools. After that, offgrid-ai remembers your model setup.", { formatBorder: pc.magenta }));
  console.log("\n" + pc.dim("Tip: use --verbose only when you want detailed install output."));
}

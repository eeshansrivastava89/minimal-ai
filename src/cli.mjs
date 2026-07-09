import { pc, renderRows, renderCard, createPrompt } from "./ui.mjs";
import { checkForUpdate, currentPackageVersion, detectInvocation, updateCommand, runUpdateCommand } from "./updates.mjs";
import { checkLlamaUpdate, installLlamaRelease } from "./runtime.mjs";
import { checkOmlxUpdate, installOmlx } from "./omlx-runtime.mjs";
import { mainFlow } from "./commands/main.mjs";
import { modelsCommand } from "./commands/models.mjs";
import { runCommand } from "./commands/run.mjs";
import { statusCommand } from "./commands/status.mjs";
import { stopCommand } from "./commands/stop.mjs";
import { uninstallCommand } from "./commands/uninstall.mjs";

async function offerUpdate(argv) {
  const invocation = detectInvocation();
  const update = await checkForUpdate();
  if (!update) return false;

  const plan = updateCommand(invocation, argv);
  console.log(pc.yellow(`\nUpdate available: v${update.latest}. You have v${update.current}.`));
  console.log(pc.dim(`Run: ${plan.display}`));
  console.log();

  if (!process.stdin.isTTY) return false;

  const prompt = createPrompt();
  try {
    const shouldUpdate = await prompt.yesNo("Update now?", false);
    if (!shouldUpdate) return false;
    await runUpdateCommand(plan);
    if (plan.mode === "install-global") console.log(pc.green("Updated. Run offgrid-ai again to use the new version."));
    return true;
  } finally {
    prompt.close();
  }
}

async function offerRuntimeUpdates() {
  if (!process.stdin.isTTY) return;
  const updates = [];
  const llamaUpdate = await checkLlamaUpdate();
  if (llamaUpdate) updates.push({ kind: "llama.cpp", ...llamaUpdate });
  if (process.platform === "darwin" && process.arch === "arm64") {
    const omlxUpdate = await checkOmlxUpdate();
    if (omlxUpdate) updates.push({ kind: "oMLX", ...omlxUpdate });
  }
  if (updates.length === 0) return;
  for (const u of updates) {
    console.log(pc.yellow(`\n${u.kind} update available: ${u.latest} (you have ${u.installed}).`));
  }
  const prompt = createPrompt();
  try {
    const shouldUpdate = await prompt.yesNo("Update now?", false);
    if (!shouldUpdate) return;
    for (const u of updates) {
      if (u.kind === "llama.cpp") {
        await installLlamaRelease(u.release);
        console.log(pc.green("✓ llama.cpp updated."));
      } else if (u.kind === "oMLX") {
        await installOmlx();
      }
    }
  } finally {
    prompt.close();
  }
}

export async function run(argv) {
  if (argv.length === 0) {
    if (await offerUpdate(argv)) return;
    await offerRuntimeUpdates();
    return mainFlow();
  }

  const [command] = argv;
  if (command === "help" || command === "--help" || command === "-h") return printHelp();
  if (command === "version" || command === "--version" || command === "-v") return printVersion();
  if (command === "models") return modelsCommand(argv.slice(1));
  if (command === "run") {
    const runArgs = argv.slice(1);
    if (!runArgs[0]) return mainFlow();
    return runCommand(runArgs);
  }
  if (command === "status") return statusCommand();
  if (command === "stop") return stopCommand(argv.slice(1));
  if (command === "uninstall" || command === "--uninstall") return uninstallCommand(argv.slice(1));
  if (command === "--verbose") return mainFlow();

  throw new Error(`Unknown command: ${command}. Run offgrid-ai help`);
}

async function printVersion() {
  const version = currentPackageVersion();
  console.log(`offgrid-ai v${version}`);
  const invocation = detectInvocation();
  const update = await checkForUpdate();
  if (update) {
    const plan = updateCommand(invocation, ["version"]);
    console.log(pc.yellow(`Update available: v${update.latest}. Run: ${plan.display}`));
  }
}

function printHelp() {
  console.log(renderCard("offgrid-ai", renderRows([
    ["What it is", "A privacy-first local AI runner"],
    ["Start", pc.bold("offgrid-ai")],
    ["Status", "offgrid-ai status"],
    ["Stop", "offgrid-ai stop"],
    ["Uninstall", "offgrid-ai uninstall"],
    ["Version", "offgrid-ai version"],
  ]), { formatBorder: pc.cyan }));
  console.log("\n" + renderCard("How it works", "Run offgrid-ai, choose a local model, and start chatting in Pi.\n\nFirst run walks you through missing tools. After that, offgrid-ai remembers your model setup.", { formatBorder: pc.magenta }));
  console.log("\n" + pc.dim("Tip: use --verbose only when you want detailed install output."));
}

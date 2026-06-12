import { pc, renderRows, renderCard, createPrompt } from "./ui.mjs";
import { checkForUpdate, currentPackageVersion, detectInvocation, updateCommand, runUpdateCommand } from "./updates.mjs";
import { mainFlow } from "./commands/main.mjs";
import { modelsCommand } from "./commands/models.mjs";
import { runCommand } from "./commands/run.mjs";
import { statusCommand } from "./commands/status.mjs";
import { stopCommand } from "./commands/stop.mjs";
import { benchmarkCommand } from "./commands/benchmark.mjs";
import { uninstallCommand } from "./commands/uninstall.mjs";

async function offerUpdate(argv) {
  const invocation = detectInvocation();
  const update = await checkForUpdate({ force: true });
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

export async function run(argv) {
  if (argv.length === 0) {
    if (await offerUpdate(argv)) return;
    return mainFlow();
  }

  const [command] = argv;
  if (command === "help" || command === "--help" || command === "-h") return printHelp();
  if (command === "version" || command === "--version" || command === "-v") return printVersion();
  if (command === "models") return modelsCommand(argv.slice(1));
  if (command === "run") return runCommand(argv.slice(1));
  if (command === "status") return statusCommand();
  if (command === "stop") return stopCommand(argv.slice(1));
  if (command === "benchmark") return benchmarkCommand();
  if (command === "uninstall" || command === "--uninstall") return uninstallCommand(argv.slice(1));
  if (command === "--verbose") return mainFlow();

  throw new Error(`Unknown command: ${command}. Run offgrid-ai help`);
}

async function printVersion() {
  const version = currentPackageVersion();
  console.log(`offgrid-ai v${version}`);
  const invocation = detectInvocation();
  const update = await checkForUpdate({ force: true });
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
    ["Benchmark", "offgrid-ai benchmark"],
    ["Uninstall", "offgrid-ai uninstall"],
    ["Version", "offgrid-ai version"],
  ]), { formatBorder: pc.cyan }));
  console.log("\n" + renderCard("How it works", "Run offgrid-ai, choose a local model, and start chatting in Pi.\n\nFirst run walks you through missing tools. After that, offgrid-ai remembers your model setup.\n\nFor benchmarks, run offgrid-ai benchmark to prepare a visual or data-science benchmark run.", { formatBorder: pc.magenta }));
  console.log("\n" + pc.dim("Tip: use --verbose only when you want detailed install output."));
}

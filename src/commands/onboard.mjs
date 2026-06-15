import { existsSync } from "node:fs";
import { ensureDirs, findLlamaServer, hasHomebrew } from "../config.mjs";
import { BACKENDS } from "../backends.mjs";
import { scanGgufModels } from "../scan.mjs";
import { hasPi } from "../harness-pi.mjs";
import { offerManagedLlamaRuntimeUpdate } from "../runtime.mjs";
import { scanManagedModels } from "../managed.mjs";
import { BACKEND_INSTALL_CHOICES, BACKEND_INSTALLERS } from "../backend-installers.mjs";
import { installedRamGB, recommendedModel } from "../recommendations.mjs";
import { runCommand } from "../exec.mjs";
import { pc, renderRows, renderSection, startInteractive, createPrompt } from "../ui.mjs";

export async function onboardFlow() {
  await ensureDirs();
  startInteractive("offgrid-ai setup");
  const prompt = createPrompt();
  const verbose = process.argv.includes("--verbose");
  const run = (cmd, args, label) => runCommand(cmd, args, { label, verbose });

  try {
    console.log(pc.bold("Welcome to offgrid-ai!"));
    console.log(pc.dim("Let's make sure you have everything you need to run local models.\n"));

    const llamaBinary = await ensureLlamaRuntime(prompt);
    if (!(await ensurePi(prompt, run))) return;

    const { models: ggufModels } = await scanGgufModels();
    const managedModels = await scanManagedModels();
    const totalManaged = managedModels.reduce((sum, item) => sum + item.models.length, 0);
    const hasModels = ggufModels.length > 0 || totalManaged > 0;

    if (hasModels) {
      printFoundModels(ggufModels, managedModels, llamaBinary);
    } else {
      await offerBackendInstall(prompt, run);
      return;
    }

    console.log(pc.green("\n✓ Setup complete! Run offgrid-ai to pick and run a model."));
  } finally {
    prompt.close();
  }
}

async function ensureLlamaRuntime(prompt) {
  let llamaBinary = await findLlamaServer();
  if (!llamaBinary) {
    console.log(renderSection("llama.cpp runtime", renderRows([
      ["Status", pc.yellow("not installed")],
      ["Used for", "local GGUF models"],
      ["Install", "managed by offgrid-ai under ~/.offgrid-ai/runtime"],
    ]), { formatBorder: pc.cyan }));
    await offerManagedLlamaRuntimeUpdate(prompt);
    llamaBinary = await findLlamaServer();
    if (!llamaBinary) console.log(pc.yellow("Skipping llama.cpp for now. You can still use Ollama/oMLX, or run offgrid-ai again to install the managed runtime."));
  }
  if (llamaBinary) console.log(pc.green(`✓ llama-server: ${llamaBinary}`));
  return llamaBinary;
}

async function ensurePi(prompt, run) {
  if (await hasPi()) {
    console.log(pc.green("✓ Pi found"));
    return true;
  }
  const install = await prompt.yesNo("Pi coding agent is required to chat with models. Install via npm?", true);
  if (!install) {
    console.log(pc.red("offgrid-ai needs Pi to run models."));
    console.log(pc.dim("Install it manually: npm install -g --ignore-scripts @earendil-works/pi-coding-agent"));
    return false;
  }
  console.log(pc.cyan("Installing Pi..."));
  try {
    await run("npm", ["install", "-g", "--ignore-scripts", "@earendil-works/pi-coding-agent"], "Pi");
  } catch {
    console.log(pc.red("✗ Failed to install Pi."));
    console.log(pc.dim("Install it manually: npm install -g --ignore-scripts @earendil-works/pi-coding-agent"));
    return false;
  }
  if (!(await hasPi())) {
    console.log(pc.yellow("Pi was installed but not found on PATH. Restart your terminal and run offgrid-ai again."));
    return false;
  }
  console.log(pc.green("✓ Pi found"));
  return true;
}

function printFoundModels(ggufModels, managedModels, llamaBinary) {
  if (ggufModels.length > 0) {
    console.log(pc.green(`✓ Found ${ggufModels.length} GGUF model${ggufModels.length === 1 ? "" : "s"}`));
    if (!llamaBinary) console.log(pc.yellow("Install the managed llama.cpp runtime to run these GGUF models."));
  }
  for (const { backendId, models, status, reason } of managedModels) {
    if (status === "unavailable") {
      console.log(pc.yellow(`${BACKENDS[backendId].label}: unavailable${reason ? ` — ${reason}` : ""}`));
    } else if (models.length > 0) {
      console.log(pc.green(`✓ ${BACKENDS[backendId].label}: ${models.length} model${models.length === 1 ? "" : "s"}`));
    }
  }
}

async function offerBackendInstall(prompt, run) {
  console.log(pc.yellow("\nNo models found."));
  console.log(pc.dim("You need at least one model backend to use offgrid-ai.\n"));
  const choice = await prompt.choice("Install a model backend?", BACKEND_INSTALL_CHOICES, "lmstudio");
  const model = recommendedModel();

  if (choice === "skip") {
    console.log(pc.dim("Run offgrid-ai again when you've set up a model backend."));
    return;
  }
  if (choice === "all") {
    await installAllBackends(prompt, run, model);
    return;
  }
  await installBackend(prompt, run, choice, model);
}

async function ensureHomebrewFor(prompt, run, label) {
  if (await hasHomebrew()) return true;
  const install = await prompt.yesNo(`Homebrew is needed to install ${label}. Install Homebrew now?`, true);
  if (!install) {
    console.log(pc.dim(`Install ${label} manually, or install Homebrew from https://brew.sh and run offgrid-ai again.`));
    return false;
  }
  console.log(pc.cyan("Installing Homebrew..."));
  try {
    await run("/bin/bash", ["-c", "NONINTERACTIVE=1 /bin/bash -c \"$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)\""], "Homebrew");
    for (const path of ["/opt/homebrew/bin", "/usr/local/bin"]) {
      if (existsSync(path)) {
        process.env.PATH = `${path}:${process.env.PATH}`;
        break;
      }
    }
  } catch {
    console.log(pc.red("✗ Homebrew installation failed."));
    console.log(pc.dim("Install it manually from https://brew.sh, then run offgrid-ai again."));
    return false;
  }
  if (!(await hasHomebrew())) {
    console.log(pc.red("Homebrew was installed but not found on PATH. Restart your terminal and run offgrid-ai again."));
    return false;
  }
  console.log(pc.green("✓ Homebrew found"));
  return true;
}

async function installBackend(prompt, run, backendId, model) {
  const installer = BACKEND_INSTALLERS[backendId];
  if (!(await ensureHomebrewFor(prompt, run, installer.label))) return;
  console.log(pc.cyan(`Installing ${installer.label} via Homebrew...`));
  try {
    await runInstallerCommands(run, installer);
    installer.success(model);
  } catch {
    console.log(pc.red(`✗ ${installer.label} installation failed.`));
    console.log(pc.dim(installer.failure));
  }
}

async function installAllBackends(prompt, run, model) {
  if (!(await ensureHomebrewFor(prompt, run, "model backends"))) return;
  const installed = [];
  for (const installer of Object.values(BACKEND_INSTALLERS)) {
    console.log(pc.cyan(`Installing ${installer.label} via Homebrew...`));
    try {
      await runInstallerCommands(run, installer);
      installed.push(installer.label);
    } catch {
      console.log(pc.yellow(installer.allFailure));
    }
  }
  if (installed.length > 0) {
    console.log(pc.green(`\n✓ Installed: ${installed.join(", ")}`));
    console.log(pc.dim(`Recommended for your machine (${installedRamGB()}GB RAM): ${model.label}`));
  }
}

async function runInstallerCommands(run, installer) {
  for (const [cmd, args, label] of installer.commands) await run(cmd, args, label);
}

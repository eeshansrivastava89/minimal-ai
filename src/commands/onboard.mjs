import { ensureDirs, findLlamaServer } from "../config.mjs";
import { BACKENDS } from "../backends.mjs";
import { scanGgufModels } from "../scan.mjs";
import { hasPi, setupPiConfig } from "../harness-pi.mjs";
import { offerManagedLlamaRuntimeUpdate } from "../runtime.mjs";
import { hasOmlx } from "../omlx-runtime.mjs";
import { scanManagedModels } from "../managed.mjs";
import { downloadFlow } from "../download.mjs";
import { runCommand } from "../exec.mjs";
import { pc, renderRows, renderSection, startInteractive, createPrompt } from "../ui.mjs";

export async function onboardFlow() {
  await ensureDirs();
  startInteractive("offgrid-ai setup");
  const prompt = createPrompt();

  try {
    console.log(pc.bold("Welcome to offgrid-ai!"));
    console.log(pc.dim("Let's make sure you have everything you need to run local models.\n"));

    const llamaBinary = await ensureLlamaRuntime(prompt);
    await noteOmlxStatus();
    if (!(await ensurePi(prompt))) return;

    const [{ models: ggufModels }, managedModels] = await Promise.all([
      scanGgufModels(),
      scanManagedModels(),
    ]);
    const totalManaged = managedModels.reduce((sum, item) => sum + item.models.length, 0);
    const hasModels = ggufModels.length > 0 || totalManaged > 0;

    if (hasModels) {
      printFoundModels(ggufModels, managedModels, llamaBinary);
    } else {
      const downloaded = await downloadFlow(prompt);
      if (!downloaded) {
        console.log(pc.dim("\nRun offgrid-ai again when you've downloaded a model."));
      }
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
    if (!llamaBinary) console.log(pc.yellow("Skipping llama.cpp for now. You can still use oMLX, or run offgrid-ai again to install the managed runtime."));
  }
  if (llamaBinary) console.log(pc.green(`✓ llama-server: ${llamaBinary}`));
  return llamaBinary;
}

async function ensurePi(prompt) {
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
    await runCommand("npm", ["install", "-g", "--ignore-scripts", "@earendil-works/pi-coding-agent"], { label: "Pi", verbose: true });
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
  await setupPiConfig();
  return true;
}

// Check oMLX status without blocking — just note it and move on.
// Users can install oMLX later from the model picker.
async function noteOmlxStatus() {
  if (process.platform !== "darwin" || process.arch !== "arm64") return;
  if (await hasOmlx()) {
    console.log(pc.green("✓ oMLX found"));
  } else {
    console.log(pc.dim("oMLX not installed — you can install it later from the model picker."));
  }
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


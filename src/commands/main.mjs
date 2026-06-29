import { findLlamaServer, ensureDirs } from "../config.mjs";
import { backendFor } from "../backends.mjs";
import { scanGgufModels } from "../scan.mjs";
import { loadProfiles } from "../profiles.mjs";
import { hasPi } from "../harness-pi.mjs";
import { offerManagedLlamaRuntimeUpdate } from "../runtime.mjs";
import { hasLmStudioInstalled, hasOmlxInstalled, scanManagedModels } from "../managed.mjs";
import { recommendedModel } from "../recommendations.mjs";
import { pc, startInteractive, createPrompt } from "../ui.mjs";
import { onboardFlow } from "./onboard.mjs";
import { modelCommandCenter } from "./models.mjs";
import { statusCommand } from "./status.mjs";

export async function mainFlow() {
  await ensureDirs();

  if (process.stdin.isTTY) {
    const runtimePrompt = createPrompt();
    try {
      await offerManagedLlamaRuntimeUpdate(runtimePrompt);
    } finally {
      runtimePrompt.close();
    }
  }

  const llamaBinary = await findLlamaServer();
  const { models: ggufModels, drafters } = await scanGgufModels();
  const managedModels = await scanManagedModels();
  const profiles = await loadProfiles();
  const hasAnyBackend = llamaBinary || managedModels.some((item) => item.status === "ok" && item.models.length > 0);
  const hasAnyModels = ggufModels.length > 0 || managedModels.some((item) => item.status === "ok" && item.models.length > 0);

  const piInstalled = await hasPi();
  const needsLlama = ggufModels.length > 0 || profiles.some((profile) => backendFor(profile.backend).type === "local-server");
  const missingDeps = [];
  if (needsLlama && !llamaBinary) missingDeps.push("llama-server");
  if (!piInstalled) missingDeps.push("Pi");
  if (missingDeps.length > 0) {
    if (!process.stdin.isTTY) throw new Error(`Missing dependencies: ${missingDeps.join(", ")}. Run offgrid-ai interactively to install.`);
    console.log(pc.yellow(`Missing: ${missingDeps.join(", ")}`));
    console.log(pc.dim("offgrid-ai needs these to run. Let's finish setup.\n"));
    return await onboardFlow();
  }

  if (!hasAnyBackend && !hasAnyModels && profiles.length === 0) {
    if (!process.stdin.isTTY) throw new Error("No local LLM backends found. Run offgrid-ai interactively to set up.");
    return await onboardFlow();
  }

  if (!hasAnyModels && profiles.length === 0) {
    if (!process.stdin.isTTY) throw new Error("No models found. Download a model, then run offgrid-ai.");
    await printNoModelsHelp(llamaBinary);
    return;
  }

  if (!process.stdin.isTTY) return await statusCommand();

  startInteractive("offgrid-ai");
  return await modelCommandCenter({ profiles, ggufModels, managedModels, drafters });
}

async function printNoModelsHelp(llamaBinary) {
  console.log(pc.yellow("No models found."));
  console.log(pc.dim("You need to download a model to use offgrid-ai.\n"));

  const omlxInstalled = await hasOmlxInstalled();
  const lmStudioInstalled = hasLmStudioInstalled();
  const hasBackends = llamaBinary || omlxInstalled || lmStudioInstalled;
  if (!hasBackends) {
    console.log(pc.dim("Run offgrid-ai to install a backend and download a model."));
    return;
  }

  console.log(pc.bold("Backend status:"));
  console.log(`  ${lmStudioInstalled ? pc.green("✓") : pc.red("✗")} LM Studio ${lmStudioInstalled ? "— installed" : "— not installed"}`);
  console.log(`  ${omlxInstalled ? pc.green("✓") : pc.red("✗")} oMLX ${omlxInstalled ? "— installed" : "— not installed"}`);
  console.log(`  ${llamaBinary ? pc.green("✓") : pc.red("✗")} llama-server ${llamaBinary ? "— installed" : "— not installed"}`);
  console.log();

  const model = recommendedModel();
  console.log(pc.bold("Next step — download a model:"));
  if (lmStudioInstalled) {
    console.log("  Open LM Studio → browse models → download");
    console.log(pc.dim(`  Recommended: ${model.label}`));
  }
  if (omlxInstalled) console.log(pc.bold("  omlx start"));
}

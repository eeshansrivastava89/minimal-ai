import { ensureDirs, findLlamaServer } from "../config.mjs";
import { hasPi, setupPiConfig } from "../harness-pi.mjs";
import { offerManagedLlamaRuntimeUpdate } from "../runtime.mjs";
import { installHfCli } from "../download.mjs";
import { hasHfCli } from "../huggingface.mjs";
import { runCommand } from "../exec.mjs";
import { pc, startInteractive, createPrompt } from "../ui.mjs";

export async function onboardFlow() {
  await ensureDirs();
  startInteractive("offgrid-ai setup");
  const prompt = createPrompt();

  try {
    console.log(pc.bold("Welcome to offgrid-ai!"));
    console.log(pc.dim("Let's set up everything you need to run local models.\n"));

    // Check what's already installed
    const llamaBinary = await findLlamaServer();
    const piInstalled = await hasPi();
    const hfInstalled = await hasHfCli();

    // Build the install summary — only list what's missing
    const toInstall = [];
    if (!llamaBinary) toInstall.push("llama.cpp runtime — runs GGUF models");
    if (!piInstalled) toInstall.push("Pi coding agent — chat interface");
    if (!hfInstalled) toInstall.push("HuggingFace CLI — downloads models");

    if (toInstall.length === 0) {
      // Everything already installed — shouldn't normally reach onboarding
      console.log(pc.green("Everything is already set up!"));
      console.log(pc.dim("Run offgrid-ai to pick and run a model."));
      return;
    }

    // Show what will be installed and ask once
    console.log(pc.bold("I'll install:"));
    for (const item of toInstall) {
      console.log(`  ${pc.cyan("•")} ${item}`);
    }
    console.log();

    const proceed = await prompt.yesNo("Proceed?", true);
    if (!proceed) {
      console.log(pc.dim("You can install these manually later. Run offgrid-ai to get started."));
      return;
    }

    // Install everything without further individual prompts
    if (!llamaBinary) {
      console.log();
      await offerManagedLlamaRuntimeUpdate(prompt);
    }

    if (!piInstalled) {
      console.log();
      console.log(pc.cyan("Installing Pi..."));
      try {
        await runCommand("npm", ["install", "-g", "--ignore-scripts", "@earendil-works/pi-coding-agent"], { label: "Pi", verbose: true });
        if (await hasPi()) {
          console.log(pc.green("✓ Pi installed"));
          await setupPiConfig();
        } else {
          console.log(pc.yellow("Pi was installed but not found on PATH. Restart your terminal and run offgrid-ai again."));
        }
      } catch {
        console.log(pc.red("✗ Failed to install Pi."));
        console.log(pc.dim("Install it manually: npm install -g --ignore-scripts @earendil-works/pi-coding-agent"));
      }
    }

    if (!hfInstalled) {
      console.log();
      await installHfCli();
    }

    // Done — tell user to run offgrid-ai to download a model
    console.log();
    console.log(pc.green("✓ Setup complete!"));
    console.log(pc.dim("Run offgrid-ai to download a model and start chatting."));
  } finally {
    prompt.close();
  }
}
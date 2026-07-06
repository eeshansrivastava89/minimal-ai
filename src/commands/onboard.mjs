import { ensureDirs, findLlamaServer } from "../config.mjs";
import { hasPi, setupPiConfig } from "../harness-pi.mjs";
import { latestLlamaRelease, installLlamaRelease } from "../runtime.mjs";
import { installHfCli } from "../download.mjs";
import { hasHfCli } from "../huggingface.mjs";
import { runCommand } from "../exec.mjs";
import { pc, startInteractive, createPrompt } from "../ui.mjs";

/**
 * Onboarding flow — installs missing deps (llama.cpp, Pi, HuggingFace CLI).
 * @returns {Promise<"success"|"declined"|"failed">}
 *   "success"  — everything installed (or already present), continue to picker
 *   "declined" — user said No to Proceed, exit
 *   "failed"   — one or more installs failed, exit with message
 */
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
    if (!piInstalled) toInstall.push("Pi coding agent — chat interface (with recommended skills & extensions)");
    if (!hfInstalled) toInstall.push("HuggingFace CLI — downloads models");

    if (toInstall.length === 0) {
      console.log(pc.green("Everything is already set up!"));
      return "success";
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
      return "declined";
    }

    // ── Install everything without further individual prompts ──
    const failures = [];

    // 1. llama.cpp — direct install, no prompt (user already said Proceed)
    if (!llamaBinary) {
      console.log();
      try {
        const latest = await latestLlamaRelease();
        if (latest) {
          console.log(pc.dim(`Installing llama.cpp ${latest.tag}...`));
          await installLlamaRelease(latest);
        } else {
          console.log(pc.red("Could not fetch llama.cpp release info. Try again later."));
          failures.push("llama.cpp");
        }
      } catch (err) {
        console.log(pc.red(`llama.cpp install failed: ${err.message}`));
        failures.push("llama.cpp");
      }
    }

    // 2. Pi — direct npm install, no prompt
    if (!piInstalled) {
      console.log();
      console.log(pc.cyan("Installing Pi..."));
      try {
        await runCommand("npm", ["install", "-g", "--ignore-scripts", "@earendil-works/pi-coding-agent"], { label: "Pi", verbose: true });
        if (await hasPi()) {
          console.log(pc.green("✓ Pi installed"));
          await setupPiConfig();
        } else {
          console.log(pc.yellow("Pi was installed but not found on PATH."));
          failures.push("Pi");
        }
      } catch {
        console.log(pc.red("✗ Failed to install Pi."));
        console.log(pc.dim("Install it manually: npm install -g --ignore-scripts @earendil-works/pi-coding-agent"));
        failures.push("Pi");
      }
    }

    // 3. HuggingFace CLI — direct install, no prompt
    if (!hfInstalled) {
      console.log();
      const hfOk = await installHfCli();
      if (!hfOk) failures.push("HuggingFace CLI");
    }

    // Result
    console.log();
    if (failures.length > 0) {
      console.log(pc.red(`Setup incomplete — failed: ${failures.join(", ")}.`));
      console.log(pc.dim("Run offgrid-ai again to retry."));
      return "failed";
    }
    console.log(pc.green("✓ Setup complete!"));
    return "success";
  } finally {
    prompt.close();
  }
}
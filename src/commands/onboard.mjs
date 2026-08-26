import { ensureDirs, findLlamaServer } from "../config.mjs";
import { configuredHarness } from "../harnesses.mjs";
import { latestLlamaRelease, installLlamaRelease } from "../runtime.mjs";
import { hasHfCli, installHfCli } from "../huggingface.mjs";
import { execCommand } from "../exec.mjs";
import { startInteractive, promptConfirm, status, theme, screenHeader, withSpinner } from "../ui.mjs";

export async function onboardFlow() {
  await ensureDirs();
  startInteractive();

  console.log(screenHeader({ title: "Welcome to minimal-ai!", subtitle: "Let's set up everything you need to run local models." }));

  const llamaBinary = await findLlamaServer();
  const harness = await configuredHarness();
  const harnessInstalled = await harness.detect();
  const hfInstalled = await hasHfCli();

  const toInstall = [];
  if (!llamaBinary) toInstall.push("llama.cpp runtime — runs GGUF models");
  if (!harnessInstalled) toInstall.push(`${harness.label} — chat interface`);
  if (!hfInstalled) toInstall.push("HuggingFace CLI — downloads models");

  if (toInstall.length === 0) {
    console.log(status({ kind: "success", message: "Everything is already set up!" }));
    return "success";
  }

  console.log(theme.bold("Missing dependencies"));
  console.log(toInstall.map((item) => `  ${theme.brand("•")} ${item}`).join("\n"));
  console.log("");

  const proceed = await promptConfirm({ message: "Proceed?", initialValue: true });
  if (!proceed) {
    console.log(theme.subtle("You can install these manually later. Run minimal-ai to get started."));
    return "declined";
  }

  const failures = [];

  if (!llamaBinary) {
    console.log();
    try {
      const latest = await latestLlamaRelease();
      if (latest) {
        await withSpinner(`Installing llama.cpp ${latest.tag}`, () => installLlamaRelease(latest));
      } else {
        console.log(status({ kind: "error", message: "Could not fetch llama.cpp release info. Try again later." }));
        failures.push("llama.cpp");
      }
    } catch (err) {
      console.log(status({ kind: "error", message: `llama.cpp install failed: ${err.message}` }));
      failures.push("llama.cpp");
    }
  }

  if (!harnessInstalled) {
    console.log();
    console.log(status({ kind: "info", message: `Installing ${harness.label}...` }));
    try {
      await execCommand("npm", ["install", "-g", "--ignore-scripts", harness.npm], { label: harness.label, verbose: true });
      if (await harness.detect()) {
        console.log(status({ kind: "success", message: `${harness.label} installed` }));
        if (harness.setup) await harness.setup();
      } else {
        console.log(status({ kind: "warning", message: `${harness.label} was installed but not found on PATH.` }));
        failures.push(harness.label);
      }
    } catch (err) {
      console.log(status({ kind: "error", message: `Failed to install ${harness.label}: ${err.message}` }));
      console.log(theme.subtle(`Install it manually: npm install -g --ignore-scripts ${harness.npm}`));
      failures.push(harness.label);
    }
  }

  if (!hfInstalled) {
    console.log();
    const hfOk = await installHfCli();
    if (!hfOk) failures.push("HuggingFace CLI");
  }

  console.log();
  if (failures.length > 0) {
    console.log(status({ kind: "error", message: `Setup incomplete — failed: ${failures.join(", ")}.` }));
    console.log(theme.subtle("Run minimal-ai again to retry."));
    return "failed";
  }
  console.log(status({ kind: "success", message: "Setup complete!" }));
  return "success";
}

import { ensureDirs, findLlamaServer } from "../config.mjs";
import { hasPi, setupPiConfig } from "../harness-pi.mjs";
import { latestLlamaRelease, installLlamaRelease } from "../runtime.mjs";
import { hasHfCli, installHfCli } from "../huggingface.mjs";
import { execCommand } from "../exec.mjs";
import { startInteractive, promptConfirm, status, theme, screenHeader, card, withSpinner } from "../ui.mjs";

export async function onboardFlow() {
  await ensureDirs();
  startInteractive("offgrid-ai setup");

  console.log(screenHeader({ title: "Welcome to offgrid-ai!", subtitle: "Let's set up everything you need to run local models." }));

  const llamaBinary = await findLlamaServer();
  const piInstalled = await hasPi();
  const hfInstalled = await hasHfCli();

  const toInstall = [];
  if (!llamaBinary) toInstall.push("llama.cpp runtime — runs GGUF models");
  if (!piInstalled) toInstall.push("Pi coding agent — chat interface (with recommended skills & extensions)");
  if (!hfInstalled) toInstall.push("HuggingFace CLI — downloads models");

  if (toInstall.length === 0) {
    console.log(status({ kind: "success", message: "Everything is already set up!" }));
    return "success";
  }

  console.log(card({ title: "Missing dependencies", body: toInstall.map((item) => `${theme.brand("•")} ${item}`).join("\n") }));

  const proceed = await promptConfirm({ message: "Proceed?", initialValue: true });
  if (!proceed) {
    console.log(theme.subtle("You can install these manually later. Run offgrid-ai to get started."));
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

  if (!piInstalled) {
    console.log();
    console.log(status({ kind: "info", message: "Installing Pi..." }));
    try {
      await execCommand("npm", ["install", "-g", "--ignore-scripts", "@earendil-works/pi-coding-agent"], { label: "Pi", verbose: true });
      if (await hasPi()) {
        console.log(status({ kind: "success", message: "Pi installed" }));
        await setupPiConfig();
      } else {
        console.log(status({ kind: "warning", message: "Pi was installed but not found on PATH." }));
        failures.push("Pi");
      }
    } catch (err) {
      console.log(status({ kind: "error", message: `Failed to install Pi: ${err.message}` }));
      console.log(theme.subtle("Install it manually: npm install -g --ignore-scripts @earendil-works/pi-coding-agent"));
      failures.push("Pi");
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
    console.log(theme.subtle("Run offgrid-ai again to retry."));
    return "failed";
  }
  console.log(status({ kind: "success", message: "Setup complete!" }));
  return "success";
}

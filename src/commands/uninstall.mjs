import { existsSync, rmSync } from "node:fs";
import { DATA_DIR } from "../config.mjs";
import { removeInstallerPathEntries } from "../shell-path.mjs";
import { stopProfile } from "../process.mjs";
import { runCommand } from "../exec.mjs";
import { pc, startInteractive, createPrompt, parseOptions } from "../ui.mjs";
import { runningProfiles } from "./stop.mjs";

export async function uninstallCommand(argv) {
  const { options } = parseOptions(argv);
  const force = options.force || options.f;

  if (!process.stdin.isTTY && !force) throw new Error("Non-interactive uninstall requires --force to avoid accidental data loss.");

  if (force) {
    await stopTrackedServers();
    await removeDataDir();
    await removeShellPath();
    await removeSelf();
    return;
  }

  startInteractive("offgrid-ai uninstall");
  const prompt = createPrompt();
  try {
    console.log(pc.bold("offgrid-ai uninstall\n"));
    const running = await runningProfiles();
    if (running.length > 0) {
      console.log(pc.yellow(`${running.length} server(s) still running. Stopping...`));
      for (const { profile } of running) await stopProfile(profile);
      console.log(pc.green("All servers stopped."));
    }

    const mode = await prompt.choice("Choose uninstall type", [
      { value: "keep-data", label: "Uninstall app only", hint: `keep profiles and settings in ${DATA_DIR}` },
      { value: "delete-data", label: "Full uninstall", hint: "delete profiles/settings, then uninstall app" },
      { value: "cancel", label: "Cancel" },
    ], "keep-data");

    if (mode === "cancel") {
      console.log(pc.dim("Cancelled."));
      return;
    }

    if (mode === "delete-data") await removeDataDir();
    else console.log(pc.dim(`Keeping ${DATA_DIR} for when you reinstall.`));

    await removeShellPath();
    await removeSelf();
  } finally {
    prompt.close();
  }
}

async function stopTrackedServers() {
  const running = await runningProfiles();
  for (const { profile } of running) {
    const result = await stopProfile(profile);
    console.log(result.stopped ? pc.green(`✓ ${result.message}`) : pc.dim(result.message));
  }
}

async function removeDataDir() {
  if (existsSync(DATA_DIR)) {
    try {
      rmSync(DATA_DIR, { recursive: true, force: true });
      console.log(pc.green(`✓ Removed ${DATA_DIR}`));
    } catch (err) {
      console.log(pc.red(`Failed to remove ${DATA_DIR}: ${err.message}`));
      console.log(pc.dim(`Remove it manually: rm -rf ${DATA_DIR}`));
    }
  } else {
    console.log(pc.dim(`${DATA_DIR} doesn't exist — already clean.`));
  }
}

async function removeShellPath() {
  const cleaned = await removeInstallerPathEntries();
  if (cleaned.length === 0) {
    console.log(pc.dim("No offgrid-ai PATH entries found in shell configs."));
    return;
  }
  for (const rcFile of cleaned) console.log(pc.green(`✓ Cleaned PATH from ${rcFile}`));
}

async function removeSelf() {
  console.log(pc.cyan("\nUninstalling offgrid-ai..."));
  try {
    await runCommand("npm", ["uninstall", "-g", "offgrid-ai"], { label: "npm uninstall", verbose: process.argv.includes("--verbose") });
    console.log(pc.green("\n✓ offgrid-ai has been uninstalled."));
    console.log(pc.dim("Reinstall anytime with: npm install -g offgrid-ai@latest --prefer-online"));
  } catch {
    console.log(pc.red("\n✗ Could not auto-uninstall. Run this manually:"));
    console.log(pc.bold("  npm uninstall -g offgrid-ai"));
  }
}

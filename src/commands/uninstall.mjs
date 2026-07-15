import { existsSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { DATA_DIR, DATA_DIR_MARKER, DATA_DIR_MARKER_CONTENT, isSafeDataDirPath, resolvedDataDirPath } from "../config.mjs";
import { removeInstallerPathEntries } from "../shell-path.mjs";
import { stopProfile } from "../process.mjs";
import { execCommand } from "../exec.mjs";
import { pc, startInteractive, createPrompt, parseOptions } from "../ui.mjs";
import { runningProfiles } from "./stop.mjs";

export async function uninstallCommand(argv) {
  const { options } = parseOptions(argv);
  const force = options.force || options.f;

  if (!process.stdin.isTTY && !force) throw new Error("Non-interactive uninstall requires --force to avoid accidental data loss.");

  if (force) {
    if (!await stopTrackedServers()) return;
    if (!await removeDataDir()) return;
    await removeShellPath();
    await removeSelf();
    return;
  }

  startInteractive("offgrid-ai uninstall");
  const prompt = createPrompt();
  console.log(pc.bold("offgrid-ai uninstall\n"));
  const running = await runningProfiles();
  if (running.length > 0) {
    console.log(pc.yellow(`${running.length} server(s) still running. Stopping...`));
    for (const { profile } of running) {
      const result = await stopProfile(profile);
      if (result.unsafe) {
        console.log(pc.red(result.message));
        return;
      }
    }
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

  if (mode === "delete-data" && !await removeDataDir()) return;
  if (mode !== "delete-data") console.log(pc.dim(`Keeping ${DATA_DIR} for when you reinstall.`));

  await removeShellPath();
  await removeSelf();
}

async function stopTrackedServers() {
  const running = await runningProfiles();
  for (const { profile } of running) {
    const result = await stopProfile(profile);
    console.log(result.stopped ? pc.green(`✓ ${result.message}`) : pc.dim(result.message));
    if (result.unsafe) return false;
  }
  return true;
}

export { isSafeDataDirPath } from "../config.mjs";

function isRecognizableDataDir(dir) {
  try {
    if (readFileSync(dir === DATA_DIR ? DATA_DIR_MARKER : join(dir, ".offgrid-ai-data"), "utf8") === DATA_DIR_MARKER_CONTENT) return true;
  } catch { /* marker absent or unreadable */ }
  return existsSync(join(dir, "config.json"))
    && ["profiles", "logs", "run"].every((name) => existsSync(join(dir, name)));
}

async function removeDataDir() {
  const resolved = resolvedDataDirPath(DATA_DIR);
  if (!isSafeDataDirPath(DATA_DIR) || !isSafeDataDirPath(resolved)) {
    console.log(pc.red(`Refusing to remove unsafe OFFGRID_DIR: ${DATA_DIR}`));
    console.log(pc.dim("Choose a dedicated absolute data directory (for example ~/.offgrid-ai or /tmp/offgrid-ai)."));
    return false;
  }
  if (existsSync(DATA_DIR) && !isRecognizableDataDir(DATA_DIR)) {
    console.log(pc.red(`Refusing to remove unrecognized data directory: ${DATA_DIR}`));
    console.log(pc.dim("Run offgrid-ai once first, or remove this directory manually after checking its contents."));
    return false;
  }
  if (existsSync(DATA_DIR)) {
    try {
      rmSync(DATA_DIR, { recursive: true, force: true });
      console.log(pc.green(`✓ Removed ${DATA_DIR}`));
    } catch (err) {
      console.log(pc.red(`Failed to remove ${DATA_DIR}: ${err.message}`));
      console.log(pc.dim(`Remove it manually: rm -rf ${DATA_DIR}`));
      return false;
    }
  } else {
    console.log(pc.dim(`${DATA_DIR} doesn't exist — already clean.`));
  }
  return true;
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
    await execCommand("npm", ["uninstall", "-g", "offgrid-ai"], { label: "npm uninstall", verbose: process.argv.includes("--verbose") });
    console.log(pc.green("\n✓ offgrid-ai has been uninstalled."));
    console.log(pc.dim("Reinstall anytime with: npm install -g offgrid-ai@latest --prefer-online"));
  } catch (err) {
    console.log(pc.red(`\n✗ Could not auto-uninstall: ${err.message}`));
    console.log(pc.bold("  npm uninstall -g offgrid-ai"));
  }
}

import { existsSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { DATA_DIR, DATA_DIR_MARKER, DATA_DIR_MARKER_CONTENT, isSafeDataDirPath, resolvedDataDirPath } from "../config.mjs";
import { removeInstallerPathEntries } from "../shell-path.mjs";
import { stopProfile } from "../process.mjs";
import { execCommand } from "../exec.mjs";
import { startInteractive, promptChoice, parseOptions, status, theme, screenHeader } from "../ui.mjs";
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

  startInteractive("minimal-ai uninstall");
  console.log(screenHeader({ title: "minimal-ai uninstall" }));
  const running = await runningProfiles();
  if (running.length > 0) {
    console.log(status({ kind: "warning", message: `${running.length} server(s) still running. Stopping...` }));
    for (const { profile } of running) {
      const result = await stopProfile(profile);
      if (result.unsafe) {
        console.log(status({ kind: "error", message: result.message }));
        return;
      }
    }
    console.log(status({ kind: "success", message: "All servers stopped." }));
  }

  const mode = await promptChoice({
    message: "Choose uninstall type",
    choices: [
      { value: "keep-data", label: "Uninstall app only", hint: `keep profiles and settings in ${DATA_DIR}` },
      { value: "delete-data", label: "Full uninstall", hint: "delete profiles/settings, then uninstall app" },
      { value: "cancel", label: "Cancel" },
    ],
    defaultValue: "keep-data",
  });

  if (!mode || mode === "cancel") {
    console.log(theme.subtle("Cancelled."));
    return;
  }

  if (mode === "delete-data" && !await removeDataDir()) return;
  if (mode !== "delete-data") console.log(theme.subtle(`Keeping ${DATA_DIR} for when you reinstall.`));

  await removeShellPath();
  await removeSelf();
}

async function stopTrackedServers() {
  const running = await runningProfiles();
  for (const { profile } of running) {
    const result = await stopProfile(profile);
    console.log(result.stopped ? status({ kind: "success", message: result.message }) : theme.subtle(result.message));
    if (result.unsafe) return false;
  }
  return true;
}

export { isSafeDataDirPath } from "../config.mjs";

function isRecognizableDataDir(dir) {
  try {
    if (readFileSync(dir === DATA_DIR ? DATA_DIR_MARKER : join(dir, ".minimal-ai-data"), "utf8") === DATA_DIR_MARKER_CONTENT) return true;
  } catch { /* marker absent or unreadable */ }
  return existsSync(join(dir, "config.json"))
    && ["profiles", "logs", "run"].every((name) => existsSync(join(dir, name)));
}

async function removeDataDir() {
  const resolved = resolvedDataDirPath(DATA_DIR);
  if (!isSafeDataDirPath(DATA_DIR) || !isSafeDataDirPath(resolved)) {
    console.log(status({ kind: "error", message: `Refusing to remove unsafe MINIMAL_DIR: ${DATA_DIR}` }));
    console.log(theme.subtle("Choose a dedicated absolute data directory (for example ~/.minimal-ai or /tmp/minimal-ai)."));
    return false;
  }
  if (existsSync(DATA_DIR) && !isRecognizableDataDir(DATA_DIR)) {
    console.log(status({ kind: "error", message: `Refusing to remove unrecognized data directory: ${DATA_DIR}` }));
    console.log(theme.subtle("Run minimal-ai once first, or remove this directory manually after checking its contents."));
    return false;
  }
  if (existsSync(DATA_DIR)) {
    try {
      rmSync(DATA_DIR, { recursive: true, force: true });
      console.log(status({ kind: "success", message: `Removed ${DATA_DIR}` }));
    } catch (err) {
      console.log(status({ kind: "error", message: `Failed to remove ${DATA_DIR}: ${err.message}` }));
      console.log(theme.subtle(`Remove it manually: rm -rf ${DATA_DIR}`));
      return false;
    }
  } else {
    console.log(theme.subtle(`${DATA_DIR} doesn't exist — already clean.`));
  }
  return true;
}

async function removeShellPath() {
  const cleaned = await removeInstallerPathEntries();
  if (cleaned.length === 0) {
    console.log(theme.subtle("No minimal-ai PATH entries found in shell configs."));
    return;
  }
  for (const rcFile of cleaned) console.log(status({ kind: "success", message: `Cleaned PATH from ${rcFile}` }));
}

async function removeSelf() {
  console.log(status({ kind: "info", message: "Uninstalling minimal-ai..." }));
  try {
    await execCommand("npm", ["uninstall", "-g", "minimal-ai"], { label: "npm uninstall", verbose: process.argv.includes("--verbose") });
    console.log(status({ kind: "success", message: "minimal-ai has been uninstalled." }));
    console.log(theme.subtle("Reinstall anytime with: npm install -g minimal-ai@latest --prefer-online"));
  } catch (err) {
    console.log(status({ kind: "error", message: `Could not auto-uninstall: ${err.message}` }));
    console.log(theme.bold("  npm uninstall -g minimal-ai"));
  }
}

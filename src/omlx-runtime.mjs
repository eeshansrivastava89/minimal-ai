// oMLX runtime management — discovery, version checking, update prompts,
// and installation. Mirrors the llama.cpp runtime pattern in runtime.mjs.
//
// oMLX is installed either via the macOS app (DMG from GitHub Releases, which
// installs a ~/.omlx/bin/omlx CLI shim with in-app auto-update) or via Homebrew
// (brew tap jundot/omlx && brew install omlx). offgrid-ai does NOT download
// binaries directly — it uses brew for automated installs, and prompts for the
// DMG when brew is unavailable.

import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { compareVersions } from "./updates.mjs";
import { hasHomebrew, ensureHomebrewFor } from "./config.mjs";
import { commandExists, runCommand } from "./exec.mjs";
import { pc, renderCard, renderRows } from "./ui.mjs";

const execFileAsync = promisify(execFile);

const OMLX_CLI_SHIM = join(homedir(), ".omlx", "bin", "omlx");
const RELEASE_API = "https://api.github.com/repos/jundot/omlx/releases/latest";

// ── Discovery ──────────────────────────────────────────────────────────────

/**
 * Find the oMLX CLI binary. Checks the app-installed shim first (it shadows
 * brew on PATH), then falls back to PATH. Returns the path or null.
 */
export async function findOmlx() {
  // 1. macOS app CLI shim (shadows brew on PATH)
  if (existsSync(OMLX_CLI_SHIM)) return OMLX_CLI_SHIM;

  // 2. PATH (brew install)
  try {
    const { stdout } = await execFileAsync("which", ["omlx"]);
    const path = stdout.trim();
    if (path && existsSync(path)) return path;
  } catch { /* not on PATH */ }

  return null;
}

/**
 * Check if oMLX is installed (app shim or on PATH).
 */
export async function hasOmlx() {
  return (await findOmlx()) !== null;
}

/**
 * Detect how oMLX was installed: "app" (macOS app CLI shim) or "brew" (on PATH
 * but not the shim) or null (not installed).
 */
export async function omlxInstallMethod() {
  if (existsSync(OMLX_CLI_SHIM)) return "app";
  if (await commandExists("omlx")) return "brew";
  return null;
}

// ── Version checking ───────────────────────────────────────────────────────

/**
 * Get the installed oMLX version by running `omlx --version`.
 * Returns null if oMLX is not installed or the version can't be parsed.
 */
export async function installedOmlxVersion() {
  const bin = await findOmlx();
  if (!bin) return null;
  try {
    const { stdout } = await execFileAsync(bin, ["--version"], { timeout: 5000 });
    const match = stdout.trim().match(/(\d+\.\d+\.\d+)/u);
    return match ? match[1] : null;
  } catch {
    return null;
  }
}

/**
 * Check for the latest oMLX release on GitHub.
 * Returns { tag, version } or null if the check fails.
 * Callers must treat null as "check failed, skip prompt".
 */
export async function latestOmlxRelease(fetchImpl = globalThis.fetch) {
  try {
    const response = await fetchImpl(RELEASE_API, { signal: AbortSignal.timeout(5000) });
    if (!response.ok) return null;
    const body = await response.json();
    const tag = typeof body?.tag_name === "string" ? body.tag_name : null;
    if (!tag) return null;
    const version = tag.replace(/^v/u, "");
    return { tag, version };
  } catch {
    return null;
  }
}

// ── Update prompt ──────────────────────────────────────────────────────────

/**
 * Check if an oMLX update is available and offer to install it.
 * Returns true if an update was installed, false otherwise.
 *
 * For brew installs: runs `brew upgrade omlx`.
 * For app installs: the app has in-app auto-update, so we just inform the user.
 */
export async function offerManagedOmlxUpdate(prompt, { fetchImpl = globalThis.fetch } = {}) {
  const latest = await latestOmlxRelease(fetchImpl);
  if (!latest) return false;

  const installed = await installedOmlxVersion();
  if (installed && compareVersions(installed, latest.version) >= 0) return false;

  const method = await omlxInstallMethod();

  console.log("\n" + renderCard("oMLX runtime", renderRows([
    ["Installed", installed ?? pc.yellow("not installed")],
    ["Latest", pc.green(latest.version)],
    ["Source", method === "app" ? "macOS app (in-app auto-update)" : "Homebrew"],
  ]), { formatBorder: pc.cyan }));

  // App installs have their own auto-update — just inform the user
  if (method === "app" && installed) {
    console.log(pc.dim("  Update oMLX via the app's in-app updater, then restart offgrid-ai."));
    return false;
  }

  // Not installed, or brew install — offer to install/upgrade
  if (!installed) {
    const shouldInstall = await prompt.yesNo("Install oMLX runtime?", false);
    if (!shouldInstall) return false;
    return await installOmlx(prompt);
  }

  // Brew install with an update available
  const shouldUpdate = await prompt.yesNo("Update oMLX runtime?", false);
  if (!shouldUpdate) return false;

  try {
    console.log(pc.dim("Updating oMLX via Homebrew..."));
    await runCommand("brew", ["update"], { label: "brew update" });
    await runCommand("brew", ["upgrade", "omlx"], { label: "brew upgrade omlx" });
    console.log(pc.green(`✓ Updated oMLX to latest`));
    return true;
  } catch (err) {
    console.log(pc.red(`✗ Update failed: ${err.message}`));
    console.log(pc.dim("Update manually: brew update && brew upgrade omlx"));
    return false;
  }
}

// ── Installation ───────────────────────────────────────────────────────────

/**
 * Offer to restart oMLX so it picks up new or deleted models.
 * @param {object} prompt - UI prompt interface (yesNo)
 * @param {string} [reason] - why we're restarting (e.g. "to load the new model")
 * @returns {Promise<boolean>} true if oMLX was restarted
 */
export async function offerOmlxRestart(prompt, reason = "to update its model list") {
  const bin = await findOmlx();
  if (!bin) {
    console.log(pc.dim("Restart oMLX manually: omlx restart"));
    return false;
  }
  const shouldRestart = await prompt.yesNo(`Restart oMLX ${reason}?`, true);
  if (!shouldRestart) {
    console.log(pc.dim("Restart manually later: omlx restart"));
    return false;
  }
  try {
    await execFileAsync(bin, ["restart"], { timeout: 15000 });
    console.log(pc.green("✓ oMLX restarted"));
    return true;
  } catch (err) {
    console.log(pc.red(`✗ Restart failed: ${err.message}`));
    console.log(pc.dim("Restart manually: omlx restart"));
    return false;
  }
}

/**
 * Install oMLX. Uses Homebrew if available (automating tap + install).
 * If Homebrew is not available, prompts to download the DMG from GitHub
 * Releases or install Homebrew first.
 *
 * @param {object} prompt - UI prompt interface (yesNo, choice)
 * @param {function} [run] - runCommand function for verbose command execution
 * @returns {Promise<boolean>} true if installation succeeded
 */
export async function installOmlx(prompt, run) {
  const hasBrew = await hasHomebrew();

  if (!hasBrew) {
    if (!(await ensureHomebrewFor(prompt, run || (async (cmd, args, label) => {
      return runCommand(cmd, args, { label });
    }), "oMLX"))) {
      console.log(pc.dim("Install oMLX manually:"));
      console.log(pc.dim("  brew tap jundot/omlx && brew install omlx"));
      console.log(pc.dim("  — or download the macOS app from https://github.com/jundot/omlx/releases"));
      return false;
    }
  }

  // Install oMLX via Homebrew
  const runner = run || (async (cmd, args, label) => {
    return runCommand(cmd, args, { label });
  });

  console.log(pc.cyan("Installing oMLX via Homebrew..."));
  try {
    await runner("brew", ["tap", "jundot/omlx", "https://github.com/jundot/omlx"], "oMLX tap");
    await runner("brew", ["install", "omlx"], "oMLX");
    console.log(pc.green("✓ oMLX installed"));
    return true;
  } catch (err) {
    console.log(pc.red(`✗ oMLX installation failed: ${err.message}`));
    console.log(pc.dim("Install manually: brew tap jundot/omlx && brew install omlx"));
    console.log(pc.dim("  — or download the macOS app from https://github.com/jundot/omlx/releases"));
    return false;
  }
}

/**
 * Ensure oMLX runtime is available. For onboarding: if not installed, offer
 * to install it. This is the oMLX equivalent of ensureLlamaRuntime().
 *
 * @param {object} prompt - UI prompt interface
 * @param {function} [run] - runCommand function for verbose output
 * @returns {Promise<boolean>} true if oMLX is available (installed or pre-existing)
 */
export async function ensureOmlxRuntime(prompt, run) {
  let omlxBin = await findOmlx();
  if (!omlxBin) {
    console.log(renderCard("oMLX runtime", renderRows([
      ["Status", pc.yellow("not installed")],
      ["Used for", "local MLX models (Apple Silicon optimized)"],
      ["Install", "managed by offgrid-ai via Homebrew"],
    ]), { formatBorder: pc.cyan }));

    const shouldInstall = await prompt.yesNo("Install oMLX runtime?", true);
    if (shouldInstall) {
      await installOmlx(prompt, run);
      omlxBin = await findOmlx();
    }

    if (!omlxBin) {
      console.log(pc.yellow("Skipping oMLX for now. You can still use llama.cpp, or run offgrid-ai again to install."));
      return false;
    }
  }

  const version = await installedOmlxVersion();
  console.log(pc.green(`✓ oMLX: ${omlxBin}${version ? ` (v${version})` : ""}`));
  return true;
}
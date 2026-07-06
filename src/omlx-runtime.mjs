// oMLX runtime management — discovery, version checking, and installation.
//
// oMLX is installed via Homebrew (CLI only — no desktop app, no GUI).
// `omlx start` delegates to `brew services` which runs the server as a
// background launchd daemon on port 8000. Models live in ~/.omlx/models.
//
// Users who want the menubar app with web dashboard can download the DMG
// from https://github.com/jundot/omlx/releases — offgrid-ai installs the
// CLI only.

import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { commandExists, runCommand } from "./exec.mjs";
import { hasHomebrew } from "./config.mjs";
import { pc } from "./ui.mjs";

const execFileAsync = promisify(execFile);

// Legacy shim path from the old DMG-based install. Kept for backward
// compatibility — findOmlx() checks this first, then PATH.
const OMLX_CLI_SHIM = join(homedir(), ".omlx", "bin", "omlx");
const RELEASE_API = "https://api.github.com/repos/jundot/omlx/releases/latest";

// ── Discovery ──────────────────────────────────────────────────────────────

/** Find the oMLX CLI binary — checks the legacy app shim first, then PATH. */
export async function findOmlx() {
  if (existsSync(OMLX_CLI_SHIM)) return OMLX_CLI_SHIM;
  try {
    const { stdout } = await execFileAsync("which", ["omlx"]);
    const path = stdout.trim();
    if (path && existsSync(path)) return path;
  } catch { /* not on PATH */ }
  return null;
}

/** Check if oMLX is installed. */
export async function hasOmlx() {
  return (await findOmlx()) !== null;
}

/** Detect install method: "app" (legacy shim) or "cli" (PATH/Homebrew) or null. */
export async function omlxInstallMethod() {
  if (existsSync(OMLX_CLI_SHIM)) return "app";
  if (await commandExists("omlx")) return "cli";
  return null;
}

// ── Version checking ───────────────────────────────────────────────────────

/** Get installed oMLX version via `omlx --version`. */
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

/** Check for the latest oMLX release on GitHub. Returns { tag, version } or null. */
export async function latestOmlxRelease(fetchImpl = globalThis.fetch) {
  try {
    const response = await fetchImpl(RELEASE_API, { signal: AbortSignal.timeout(5000) });
    if (!response.ok) return null;
    const body = await response.json();
    const tag = typeof body?.tag_name === "string" ? body.tag_name : null;
    if (!tag) return null;
    return { tag, version: tag.replace(/^v/u, "") };
  } catch {
    return null;
  }
}

// ── Server lifecycle ───────────────────────────────────────────────────────

/**
 * Start the oMLX server via `omlx start`.
 * With a Homebrew install, this delegates to `brew services` — the server
 * runs as a background launchd daemon (no GUI, no menubar app).
 * @throws if oMLX is not installed or the start fails.
 */
export async function startOmlxServer() {
  const bin = await findOmlx();
  if (!bin) throw new Error("oMLX is not installed");
  await execFileAsync(bin, ["start"], { timeout: 30000 });
}

/** Offer to restart oMLX so it picks up new or deleted models. */
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

// ── Installation (Homebrew — CLI only, no desktop app) ─────────────────────

/**
 * Install oMLX via Homebrew. CLI only — no desktop app, no GUI, no menubar
 * icon. The server runs as a `brew services` background daemon.
 * @returns {Promise<boolean>} true if installation succeeded
 */
export async function installOmlx() {
  if (!(await hasHomebrew())) {
    console.log(pc.red("Homebrew is required to install oMLX."));
    console.log(pc.dim("Install Homebrew first: https://brew.sh"));
    return false;
  }

  console.log(pc.cyan("Installing oMLX via Homebrew (CLI only — no desktop app)..."));
  try {
    await runCommand("brew", ["tap", "jundot/omlx", "https://github.com/jundot/omlx"], { label: "brew tap", verbose: true });
    await runCommand("brew", ["install", "omlx"], { label: "brew install omlx", verbose: true });
  } catch (err) {
    console.log(pc.red(`Installation failed: ${err.message}`));
    console.log(pc.dim("Install manually: brew tap jundot/omlx https://github.com/jundot/omlx && brew install omlx"));
    return false;
  }

  // Verify the CLI is available
  if (!(await hasOmlx())) {
    console.log(pc.yellow("oMLX was installed but the `omlx` command was not found on PATH."));
    console.log(pc.dim("Restart your terminal and run offgrid-ai again."));
    return false;
  }

  // Start the server (brew services background daemon — no GUI)
  console.log(pc.dim("Starting oMLX server..."));
  try {
    await startOmlxServer();
    console.log(pc.green("✓ oMLX server started"));
  } catch {
    console.log(pc.dim("Start oMLX manually: omlx start"));
  }

  const version = await installedOmlxVersion();
  console.log(pc.green(`\n✓ oMLX ${version ? `v${version} ` : ""}installed (CLI only)`));
  console.log(pc.dim("  This installed the command-line server — no desktop app."));
  console.log(pc.dim("  Server status: omlx status  ·  Stop: omlx stop  ·  Restart: omlx restart"));
  console.log(pc.dim("  Want the menubar app with web dashboard?"));
  console.log(pc.dim("  Download the Mac app from https://github.com/jundot/omlx/releases"));

  return true;
}
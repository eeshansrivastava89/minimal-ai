// oMLX runtime management — discovery, version checking, and installation.
//
// oMLX is installed as a macOS app (DMG from GitHub Releases). The app
// includes in-app auto-update and installs a ~/.omlx/bin/omlx CLI shim
// that offgrid-ai uses for model discovery, server control, etc.

import { execFile } from "node:child_process";
import { existsSync, readdirSync } from "node:fs";
import { unlink, mkdir, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { commandExists, runCommand } from "./exec.mjs";
import { pc, formatBytes } from "./ui.mjs";

const execFileAsync = promisify(execFile);

const OMLX_CLI_SHIM = join(homedir(), ".omlx", "bin", "omlx");
const RELEASE_API = "https://api.github.com/repos/jundot/omlx/releases/latest";

// ── Discovery ──────────────────────────────────────────────────────────────

/** Find the oMLX CLI binary — checks the app shim first, then PATH. */
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

/** Detect install method: "app" (shim) or "cli" (PATH only) or null. */
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

// ── Restart ────────────────────────────────────────────────────────────────

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

// ── Installation (macOS app via DMG) ────────────────────────────────────────

/** Get macOS major version (e.g. 15, 26, 27). */
async function getMacosMajorVersion() {
  try {
    const { stdout } = await execFileAsync("sw_vers", ["-productVersion"]);
    return parseInt(stdout.trim().split(".")[0], 10);
  } catch {
    return null;
  }
}

/** Find the DMG asset that matches the macOS version. */
function pickDmgForMacos(assets, majorVersion) {
  for (const asset of assets) {
    if (!asset.name?.endsWith(".dmg")) continue;
    // Parse "macos15-sequoia" or "macos26-27" from the filename
    const match = asset.name.match(/macos(\d+)(?:-(\d+))?/i);
    if (!match) continue;
    const start = parseInt(match[1], 10);
    const end = match[2] ? parseInt(match[2], 10) : start;
    if (majorVersion >= start && majorVersion <= end) {
      return { name: asset.name, url: asset.browser_download_url, size: asset.size };
    }
  }
  return null;
}

/** Parse hdiutil output to find the mount point. */
function parseMountPoint(stdout) {
  const match = stdout.match(/\/Volumes\/\S+/);
  return match ? match[0] : null;
}

/** Find the .app inside a mounted DMG volume. */
function findAppInVolume(mountPoint) {
  try {
    const entries = readdirSync(mountPoint);
    const app = entries.find((e) => e.endsWith(".app"));
    return app ? join(mountPoint, app) : null;
  } catch {
    return null;
  }
}

/**
 * Install oMLX by downloading the macOS app DMG from GitHub Releases,
 * mounting it, copying the app to /Applications, and launching it
 * to create the ~/.omlx/bin/omlx CLI shim.
 * @returns {Promise<boolean>} true if installation succeeded
 */
export async function installOmlx() {
  // 1. Fetch the latest release (with assets)
  let release;
  try {
    const response = await fetch(RELEASE_API, { signal: AbortSignal.timeout(10000) });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    release = await response.json();
  } catch {
    console.log(pc.red("Could not fetch oMLX release info. Try again later."));
    return false;
  }

  // 2. Detect macOS version and pick the right DMG
  const macosMajor = await getMacosMajorVersion();
  if (!macosMajor) {
    console.log(pc.red("Could not detect macOS version."));
    return false;
  }

  const dmg = pickDmgForMacos(release.assets ?? [], macosMajor);
  if (!dmg) {
    console.log(pc.red(`No oMLX release found for macOS ${macosMajor}.`));
    console.log(pc.dim("Download manually from https://github.com/jundot/omlx/releases"));
    return false;
  }

  // 3. Download the DMG
  const tmpDmg = join(tmpdir(), dmg.name);
  console.log(pc.cyan(`Downloading oMLX ${release.tag_name} (${formatBytes(dmg.size)})...`));
  console.log(pc.dim("  This is a large download — it may take a few minutes.\n"));
  try {
    await runCommand("curl", ["-L", "--progress-bar", "-o", tmpDmg, dmg.url], { label: "oMLX DMG", verbose: true });
  } catch (err) {
    console.log(pc.red(`Download failed: ${err.message}`));
    return false;
  }

  // 4. Mount the DMG
  let mountPoint;
  try {
    console.log(pc.dim("\nMounting DMG..."));
    const { stdout } = await execFileAsync("hdiutil", ["attach", "-nobrowse", tmpDmg]);
    mountPoint = parseMountPoint(stdout);
    if (!mountPoint) throw new Error("could not find mount point");
  } catch (err) {
    console.log(pc.red(`Mount failed: ${err.message}`));
    await unlink(tmpDmg).catch(() => {});
    return false;
  }

  // 5. Find and copy the .app to /Applications
  try {
    const appPath = findAppInVolume(mountPoint);
    if (!appPath) throw new Error("could not find .app in DMG");
    console.log(pc.dim("Installing oMLX.app to /Applications..."));
    await execFileAsync("cp", ["-R", appPath, "/Applications/"]);
  } catch (err) {
    console.log(pc.red(`Install failed: ${err.message}`));
    await execFileAsync("hdiutil", ["detach", mountPoint]).catch(() => {});
    await unlink(tmpDmg).catch(() => {});
    return false;
  }

  // 6. Unmount and clean up
  await execFileAsync("hdiutil", ["detach", mountPoint]).catch(() => {});
  await unlink(tmpDmg).catch(() => {});

  // 7. Create a CLI shim at ~/.omlx/bin/omlx that execs the app's bundled
  //    omlx-cli — without launching the GUI app (which has its own onboarding).
  //    omlx-cli is a shell script that resolves its own location via realpath
  //    to find the bundled Python framework relative to itself, so it must be
  //    exec'd in place inside the app bundle — copying it out would break
  //    those relative paths. This mirrors the shim the app itself creates.
  await mkdir(join(homedir(), ".omlx", "bin"), { recursive: true });
  const appCli = "/Applications/oMLX.app/Contents/MacOS/omlx-cli";
  if (!existsSync(appCli)) {
    console.log(pc.yellow("oMLX app installed to /Applications."));
    console.log(pc.dim("Open oMLX from Applications once to set up the CLI, then run offgrid-ai again."));
    return false;
  }

  await writeFile(OMLX_CLI_SHIM, `#!/bin/sh\nexec '${appCli}' "$@"\n`);
  await execFileAsync("chmod", ["+x", OMLX_CLI_SHIM]);

  // 8. Pre-create oMLX settings to skip the API key onboarding prompt.
  //    The app checks skip_api_key_verification on launch — if true, it
  //    skips the onboarding window entirely. Only create if settings.json
  //    doesn't already exist (never overwrite existing config).
  const settingsPath = join(homedir(), ".omlx", "settings.json");
  if (!existsSync(settingsPath)) {
    await writeFile(settingsPath, JSON.stringify({
      version: "1.0",
      auth: { skip_api_key_verification: true },
    }, null, 2) + "\n");
  }

  // 9. Launch the app hidden (menubar icon only — no onboarding window)
  //    and start the managed server. The sleep gives the app time to
  //    finish starting hidden before omlx start talks to it — otherwise
  //    omlx start may re-launch it in the foreground.
  console.log(pc.dim("Starting oMLX server..."));
  try {
    await execFileAsync("open", ["-gj", "/Applications/oMLX.app"]);
    await new Promise((resolve) => setTimeout(resolve, 3000));
    await execFileAsync(OMLX_CLI_SHIM, ["start"], { timeout: 30000 });
    console.log(pc.green("✓ oMLX server started"));
  } catch {
    console.log(pc.dim("Start oMLX manually: omlx start"));
  }

  console.log(pc.green(`✓ oMLX ${release.tag_name} installed`));
  return true;
}
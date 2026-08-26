import { existsSync, readdirSync } from "node:fs";
import { mkdir, writeFile, mkdtemp, rm } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { execCommand, execFileAsync } from "./exec.mjs";
import { isNewerVersion } from "./updates.mjs";
import { readOmlxModelSettings } from "./mlx-discovery.mjs";
import { formatBytes, status, theme, promptConfirm, screenHeader } from "./ui.mjs";

const OMLX_CLI_SHIM = join(homedir(), ".omlx", "bin", "omlx");
const RELEASES_API = "https://api.github.com/repos/jundot/omlx/releases";

async function findOmlx() {
  if (existsSync(OMLX_CLI_SHIM)) return OMLX_CLI_SHIM;
  try {
    const { stdout } = await execFileAsync("which", ["omlx"]);
    const path = stdout.trim();
    if (path && existsSync(path)) return path;
  } catch { /* not on PATH */ }
  return null;
}

export async function hasOmlx() {
  return (await findOmlx()) !== null;
}

async function installedOmlxVersion() {
  const bin = await findOmlx();
  if (!bin) return null;
  try {
    const { stdout } = await execFileAsync(bin, ["--version"], { timeout: 5000 });
    const match = stdout.trim().match(/(\d+\.\d+\.\d+(?:\.\w+)*)/u);
    return match ? match[1] : null;
  } catch {
    return null;
  }
}

/**
 * Newest stable oMLX release. oMLX publishes rc/dev builds as full GitHub
 * releases, so /releases/latest points at the dev channel — filter to strict
 * semver tags instead. The oMLX app updates itself on its own channel;
 * minimal-ai only ever notifies.
 */
async function latestStableOmlxRelease() {
  const response = await fetch(`${RELEASES_API}?per_page=20`, { signal: AbortSignal.timeout(10000) });
  if (!response.ok) return null;
  const releases = await response.json();
  if (!Array.isArray(releases)) return null;
  return releases.find((r) => !r.prerelease && !r.draft && /^v?\d+\.\d+\.\d+$/u.test(r.tag_name ?? "")) ?? null;
}

export async function checkOmlxUpdate() {
  const installed = await installedOmlxVersion();
  if (!installed) return null;
  try {
    const release = await latestStableOmlxRelease();
    const latest = release?.tag_name?.replace(/^v/u, "");
    if (!latest || !isNewerVersion(latest, installed)) return null;
    return { installed, latest };
  } catch {
    return null;
  }
}

export async function startOmlxServer() {
  const bin = await findOmlx();
  if (!bin) throw new Error("oMLX is not installed");
  await execFileAsync(bin, ["start"], { timeout: 60000 });
}

/**
 * Restart the oMLX server (non-interactive). Used by autotune to reclaim the
 * process memory a sweep leaves behind: oMLX frees model memory per
 * load/unload, but the server process's cold pages get pushed to swap by macOS
 * and aren't returned — only a restart drops the footprint back to baseline.
 * Settings persist to ~/.omlx/model_settings.json on every PUT, so an applied
 * autotune recommendation survives the restart. Returns { ok, reason? }.
 */
export async function restartOmlxServer() {
  const bin = await findOmlx();
  if (!bin) return { ok: false, reason: "not-installed" };
  try {
    await execFileAsync(bin, ["restart"], { timeout: 30000 });
    return { ok: true };
  } catch (err) {
    return { ok: false, reason: "restart-failed", detail: err.message };
  }
}

/**
 * PUT partial per-model settings to the oMLX admin API, then verify they
 * persisted. oMLX has no GET settings endpoint (405 since at least
 * 0.6.3rc2 — a GET-based verify would report a successful PUT as failed),
 * so verification reads the PUT response's own `settings` echo, falling
 * back to ~/.omlx/model_settings.json (which oMLX rewrites on every PUT).
 * Never throws — returns { ok, verified, reason?, detail? } so callers can
 * word a context-appropriate message. reason: "auth" | "not-found" |
 * "http" | "not-persisted" | "unreachable".
 */
export async function putOmlxModelSettings(baseUrl, modelId, settings) {
  const url = `${baseUrl}/admin/api/models/${encodeURIComponent(modelId)}/settings`;
  try {
    const response = await fetch(url, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(settings),
      signal: AbortSignal.timeout(5000),
    });
    if (!response.ok) {
      if (response.status === 401 || response.status === 403) return { ok: false, reason: "auth" };
      if (response.status === 404) return { ok: false, reason: "not-found" };
      const detail = await response.text().catch(() => "");
      return { ok: false, reason: "http", detail: `HTTP ${response.status} ${detail}`.trim() };
    }
    const echo = await response.json().catch(() => null);
    const persisted = echo?.settings && typeof echo.settings === "object"
      ? echo.settings
      : await readOmlxModelSettings(modelId);
    if (!persisted) return { ok: true, verified: false };
    const failed = Object.entries(settings).filter(([key, value]) => persisted[key] !== value).map(([key]) => key);
    if (failed.length > 0) return { ok: false, reason: "not-persisted", detail: failed.join(", ") };
    return { ok: true, verified: true };
  } catch (err) {
    return { ok: false, reason: "unreachable", detail: err.message };
  }
}

/** Human-readable advice for a failed putOmlxModelSettings call. */
export function omlxSettingsFailureHint(result) {
  if (result.reason === "auth") return "oMLX admin authentication required. Enable skip_api_key_verification in oMLX settings, or change it manually from the admin panel.";
  if (result.reason === "not-found") return "Model not found on the oMLX server. Setting not applied.";
  return `Check the oMLX admin panel (${result.detail ?? result.reason}).`;
}

export async function offerOmlxRestart(reason = "to update its model list") {
  const bin = await findOmlx();
  if (!bin) {
    console.log(theme.subtle("Restart oMLX manually: omlx restart"));
    return false;
  }
  const shouldRestart = await promptConfirm({ message: `Restart oMLX ${reason}?`, initialValue: true });
  if (!shouldRestart) {
    console.log(theme.subtle("Restart manually later: omlx restart"));
    return false;
  }
  try {
    await execFileAsync(bin, ["restart"], { timeout: 15000 });
    console.log(status({ kind: "success", message: "oMLX restarted" }));
    return true;
  } catch (err) {
    console.log(status({ kind: "error", message: `Restart failed: ${err.message}` }));
    console.log(theme.subtle("Restart manually: omlx restart"));
    return false;
  }
}

async function getMacosMajorVersion() {
  try {
    const { stdout } = await execFileAsync("sw_vers", ["-productVersion"]);
    return parseInt(stdout.trim().split(".")[0], 10);
  } catch {
    return null;
  }
}

function pickDmgForMacos(assets, majorVersion) {
  for (const asset of assets) {
    if (!asset.name?.endsWith(".dmg")) continue;
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

function parseMountPoint(stdout) {
  const match = stdout.match(/\/Volumes\/\S+/);
  return match ? match[0] : null;
}

function findAppInVolume(mountPoint) {
  try {
    const entries = readdirSync(mountPoint);
    const app = entries.find((e) => e.endsWith(".app"));
    return app ? join(mountPoint, app) : null;
  } catch {
    return null;
  }
}

export async function installOmlx() {
  console.log(screenHeader({ title: "oMLX", subtitle: "local LLM server for Apple Silicon" }));
  console.log(theme.subtle("Source: https://github.com/jundot/omlx (by jundot)"));
  console.log("Runs MLX models with continuous batching and tiered KV caching.");
  console.log("After installation, the oMLX app will open — you can manage the server from its");
  console.log("menubar icon. Once the server is running, close the app window and come back");
  console.log(`to minimal-ai to use your model.\n`);

  const release = await latestStableOmlxRelease();
  if (!release) {
    console.log(status({ kind: "error", message: "Could not fetch oMLX release info. Try again later." }));
    return false;
  }

  const macosMajor = await getMacosMajorVersion();
  if (!macosMajor) {
    console.log(status({ kind: "error", message: "Could not detect macOS version." }));
    return false;
  }

  const dmg = pickDmgForMacos(release.assets ?? [], macosMajor);
  if (!dmg) {
    console.log(status({ kind: "error", message: `No oMLX release found for macOS ${macosMajor}.` }));
    console.log(theme.subtle("Download manually from https://github.com/jundot/omlx/releases"));
    return false;
  }

  const tmpDir = await mkdtemp(join(tmpdir(), "minimal-omlx-"));
  const tmpDmg = join(tmpDir, dmg.name);
  console.log(status({ kind: "info", message: `Downloading oMLX ${release.tag_name} (${formatBytes(dmg.size)})...` }));
  console.log(theme.subtle("  This is a large download — it may take a few minutes.\n"));
  try {
    await execCommand("curl", ["-L", "--progress-bar", "-o", tmpDmg, dmg.url], { label: "oMLX DMG", verbose: true, timeout: 1200000 });
  } catch (err) {
    console.log(status({ kind: "error", message: `Download failed: ${err.message}` }));
    return false;
  }

  try {
    console.log(theme.subtle("Verifying DMG integrity..."));
    await execFileAsync("hdiutil", ["verify", tmpDmg], { timeout: 60000 });
  } catch (err) {
    console.log(status({ kind: "error", message: `DMG integrity verification failed: ${err.message}` }));
    console.log(theme.subtle("The download may be corrupted or tampered with. Try again."));
    await rm(tmpDir, { recursive: true, force: true }).catch(() => {});
    return false;
  }

  let mountPoint;
  try {
    console.log(theme.subtle("\nMounting DMG..."));
    const { stdout } = await execFileAsync("hdiutil", ["attach", "-nobrowse", tmpDmg]);
    mountPoint = parseMountPoint(stdout);
    if (!mountPoint) throw new Error("could not find mount point");
  } catch (err) {
    console.log(status({ kind: "error", message: `Mount failed: ${err.message}` }));
    await rm(tmpDir, { recursive: true, force: true }).catch(() => {});
    return false;
  }

  try {
    const appPath = findAppInVolume(mountPoint);
    if (!appPath) throw new Error("could not find .app in DMG");
    try {
      await execFileAsync("codesign", ["--verify", "--deep", "--strict", appPath], { timeout: 30000 });
    } catch (err) {
      console.log(status({ kind: "error", message: `Code signature verification failed: ${err.message}` }));
      console.log(theme.subtle("The app may be tampered with. Refusing to install."));
      await execFileAsync("hdiutil", ["detach", mountPoint]).catch(() => {});
      await rm(tmpDir, { recursive: true, force: true }).catch(() => {});
      return false;
    }
    console.log(theme.subtle("Installing oMLX.app to /Applications..."));
    await execFileAsync("cp", ["-R", appPath, "/Applications/"]);
  } catch (err) {
    console.log(status({ kind: "error", message: `Install failed: ${err.message}` }));
    await execFileAsync("hdiutil", ["detach", mountPoint]).catch(() => {});
    await rm(tmpDir, { recursive: true, force: true }).catch(() => {});
    return false;
  }

  await execFileAsync("hdiutil", ["detach", mountPoint]).catch(() => {});
  await rm(tmpDir, { recursive: true, force: true }).catch(() => {});

  await mkdir(join(homedir(), ".omlx", "bin"), { recursive: true });
  const appCli = "/Applications/oMLX.app/Contents/MacOS/omlx-cli";
  if (!existsSync(appCli)) {
    console.log(status({ kind: "warning", message: "oMLX app installed to /Applications." }));
    console.log(theme.subtle("Open oMLX from Applications once to set up the CLI, then run minimal-ai again."));
    return false;
  }

  await writeFile(OMLX_CLI_SHIM, `#!/bin/sh\nexec '${appCli}' "$@"\n`);
  await execFileAsync("chmod", ["+x", OMLX_CLI_SHIM]);

  const settingsPath = join(homedir(), ".omlx", "settings.json");
  if (!existsSync(settingsPath)) {
    await writeFile(settingsPath, JSON.stringify({
      version: "1.0",
      auth: { skip_api_key_verification: true },
    }, null, 2) + "\n");
  }

  console.log(theme.subtle("\nStarting oMLX server..."));
  try {
    await startOmlxServer();
    console.log(status({ kind: "success", message: "oMLX server started" }));
  } catch {
    console.log(theme.subtle("Start oMLX manually: omlx start"));
  }

  const version = await installedOmlxVersion();
  console.log(status({ kind: "success", message: `oMLX ${version ? `v${version} ` : ""}installed` }));
  console.log(theme.subtle("  The oMLX app is running in your menubar — you can close the app window."));
  console.log(theme.subtle("  Come back to minimal-ai to download and run MLX models."));

  return true;
}

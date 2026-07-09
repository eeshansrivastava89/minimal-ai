import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { chmod, mkdir, mkdtemp, rm, symlink, unlink, writeFile, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MANAGED_LLAMA_SERVER, RUNTIME_DIR } from "./config.mjs";
import { execFileAsync } from "./exec.mjs";
import { pc } from "./ui.mjs";
const RELEASE_API = "https://api.github.com/repos/ggml-org/llama.cpp/releases/latest";
const VERSION_PATH = join(RUNTIME_DIR, "llama.cpp", "VERSION.json");

/**
 * Check for the latest llama.cpp release on GitHub.
 * Returns null if the check fails (network error, timeout, etc.).
 * Callers must treat null as "check failed, skip prompt" — do not
 * treat null as "no update available."
 */
export async function latestLlamaRelease(fetchImpl = globalThis.fetch) {
  try {
    const response = await fetchImpl(RELEASE_API, { signal: AbortSignal.timeout(5000) });
    if (!response.ok) return null;
    const body = await response.json();
    const tag = typeof body?.tag_name === "string" ? body.tag_name : null;
    const asset = selectAsset(body?.assets ?? [], process.platform, process.arch);
    if (!tag || !asset) return null;
    return { tag, asset };
  } catch {
    return null;
  }
}

export async function installLlamaRelease(release, { fetchImpl = globalThis.fetch } = {}) {
  const tmp = await mkdtemp(join(tmpdir(), "offgrid-llama-"));
  const archive = join(tmp, release.asset.name);
  const releaseDir = join(RUNTIME_DIR, "llama.cpp", "releases", release.tag);
  const binDir = join(RUNTIME_DIR, "bin");

  try {
    console.log(pc.dim(`Downloading ${release.asset.name}...`));
    const response = await fetchImpl(release.asset.url);
    if (!response.ok) throw new Error(`Download failed: HTTP ${response.status}`);
    const bytes = Buffer.from(await response.arrayBuffer());
    verifyDigest(bytes, release.asset.digest);
    await writeFile(archive, bytes);

    await rm(releaseDir, { recursive: true, force: true });
    await mkdir(releaseDir, { recursive: true });
    await execFileAsync("tar", ["-xzf", archive, "--strip-components", "1", "-C", releaseDir]);

    const llamaServer = join(releaseDir, "llama-server");
    if (!existsSync(llamaServer)) throw new Error("Release archive did not contain llama-server");
    await chmod(llamaServer, 0o755);

    await mkdir(binDir, { recursive: true });
    await unlink(MANAGED_LLAMA_SERVER).catch(() => {});
    await symlink(llamaServer, MANAGED_LLAMA_SERVER);

    await mkdir(join(RUNTIME_DIR, "llama.cpp"), { recursive: true });
    await writeFile(VERSION_PATH, JSON.stringify({
      runtime: "llama.cpp",
      tag: release.tag,
      asset: release.asset.name,
      url: release.asset.url,
      installedAt: new Date().toISOString(),
      llamaServer,
    }, null, 2) + "\n", "utf8");

    console.log(pc.green(`✓ Installed llama.cpp ${release.tag}`));
  } finally {
    await rm(tmp, { recursive: true, force: true }).catch(() => {});
  }
}

function selectAsset(assets, platform, arch) {
  const suffix = assetSuffix(platform, arch);
  if (!suffix) return null;
  const asset = assets.find((item) => item?.name?.endsWith(suffix));
  if (!asset?.browser_download_url) return null;
  return {
    name: asset.name,
    url: asset.browser_download_url,
    digest: asset.digest,
    size: asset.size,
  };
}

function assetSuffix(platform, arch) {
  const cpu = arch === "arm64" ? "arm64" : arch === "x64" ? "x64" : null;
  if (!cpu) return null;
  if (platform === "darwin") return `bin-macos-${cpu}.tar.gz`;
  if (platform === "linux") return `bin-ubuntu-${cpu}.tar.gz`;
  return null;
}

function verifyDigest(bytes, digest) {
  if (!digest?.startsWith("sha256:")) return;
  const expected = digest.slice("sha256:".length);
  const actual = createHash("sha256").update(bytes).digest("hex");
  if (actual !== expected) throw new Error("llama.cpp: checksum mismatch");
}

/** Read the installed llama.cpp release tag from VERSION.json. */
async function readInstalledLlamaTag() {
  if (!existsSync(VERSION_PATH)) return null;
  try {
    const data = JSON.parse(await readFile(VERSION_PATH, "utf8"));
    return data.tag ?? null;
  } catch {
    return null;
  }
}

/** Check if a newer llama.cpp release is available. Returns { installed, latest, release } or null. */
export async function checkLlamaUpdate() {
  const installedTag = await readInstalledLlamaTag();
  if (!installedTag) return null;
  const latest = await latestLlamaRelease();
  if (!latest) return null;
  if (installedTag === latest.tag) return null;
  return { installed: installedTag, latest: latest.tag, release: latest };
}

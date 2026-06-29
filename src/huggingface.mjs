// HuggingFace model download helpers.
// Uses the Python huggingface_hub package (the standard, maintained downloader)
// to download models into the standard HF cache directory.
// Downloads go to ~/.cache/huggingface/hub, NOT a custom offgrid-ai folder.

import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { homedir } from "node:os";
import { join, dirname } from "node:path";
import { mkdir } from "node:fs/promises";
import { fileURLToPath } from "node:url";

const execFileAsync = promisify(execFile);

export const HF_CACHE_DIR = process.env.HF_HOME
  ? process.env.HF_HOME
  : join(homedir(), ".cache", "huggingface");

const HF_DOWNLOAD_SCRIPT = join(dirname(fileURLToPath(import.meta.url)), "..", "resources", "hf-download.py");

/** Check whether python3 + huggingface_hub is available. */
export async function hasHuggingfaceHub() {
  try {
    const { stdout } = await execFileAsync("python3", ["-c", "import huggingface_hub; print(huggingface_hub.__version__)"]);
    return Boolean(stdout.trim());
  } catch {
    return false;
  }
}

/** Parse a HuggingFace reference (URL, repo/filename, or repo ID). */
export function parseHfRef(input) {
  const trimmed = input.trim();

  if (trimmed.startsWith("https://huggingface.co/")) {
    const url = new URL(trimmed);
    const pathParts = url.pathname.split("/").filter(Boolean);
    const resolveIdx = pathParts.indexOf("resolve");
    if (resolveIdx > 0 && pathParts[resolveIdx + 1] === "main") {
      return {
        repo: pathParts.slice(0, resolveIdx).join("/"),
        filename: pathParts.slice(resolveIdx + 2).join("/"),
      };
    }
    if (pathParts.length >= 2) {
      return {
        repo: pathParts.slice(0, 2).join("/"),
        filename: pathParts.length > 2 ? pathParts.slice(2).join("/") : undefined,
      };
    }
    throw new Error(`Invalid HuggingFace URL: ${input}`);
  }

  const parts = trimmed.split("/").filter(Boolean);
  if (parts.length < 2) {
    throw new Error(`Invalid HuggingFace reference: "${input}". Expected at least org/name.`);
  }
  return {
    repo: parts.slice(0, 2).join("/"),
    filename: parts.length > 2 ? parts.slice(2).join("/") : undefined,
  };
}

/** Resolve file metadata for a GGUF file from the HF tree API. */
export async function resolveGgufFile(ref, { fetchImpl = globalThis.fetch } = {}) {
  const { repo, filename } = parseHfRef(ref);
  const tree = await getHfTree(repo, { fetchImpl });
  const entry = tree.find((f) => f.path === filename && f.type === "file");
  if (!entry) throw new Error(`File '${filename}' not found in HuggingFace repo '${repo}'.`);
  return {
    repo,
    filename,
    url: `https://huggingface.co/${repo}/resolve/main/${filename}`,
    sizeBytes: entry.lfs?.size ?? entry.size ?? 0,
    sha256: entry.lfs?.oid ?? "",
    relativePath: filename,
  };
}

/** Resolve all model files in an MLX repo from the HF tree API. */
export async function resolveMlxRepo(repo, { fetchImpl = globalThis.fetch } = {}) {
  const tree = await getHfTree(repo, { fetchImpl });
  const modelFiles = tree.filter(
    (f) => f.type === "file" && !f.path.startsWith(".") && f.path !== ".gitattributes" && f.path !== "README.md",
  );
  return modelFiles.map((f) => ({
    repo,
    filename: f.path,
    url: `https://huggingface.co/${repo}/resolve/main/${f.path}`,
    sizeBytes: f.lfs?.size ?? f.size ?? 0,
    sha256: f.lfs?.oid ?? "",
    relativePath: f.path,
  }));
}

async function getHfTree(repo, { branch = "main", fetchImpl = globalThis.fetch } = {}) {
  const url = `https://huggingface.co/api/models/${repo}/tree/${branch}?recursive=true`;
  const response = await fetchImpl(url, { signal: AbortSignal.timeout(10000) });
  if (!response.ok) throw new Error(`HuggingFace API error: HTTP ${response.status} for ${repo}`);
  return await response.json();
}

/** Resolve a user-provided HF reference into a download plan. */
export async function resolveHfDownload(input, { fetchImpl = globalThis.fetch } = {}) {
  const { repo, filename } = parseHfRef(input);

  if (filename && filename.endsWith(".gguf")) {
    const file = await resolveGgufFile(`${repo}/${filename}`, { fetchImpl });
    return {
      id: repo.split("/").pop() ?? repo,
      repo,
      format: "gguf",
      files: [file],
      totalSizeBytes: file.sizeBytes,
    };
  }

  const tree = await getHfTree(repo, { fetchImpl });
  const ggufFiles = tree.filter((f) => f.type === "file" && f.path.endsWith(".gguf"));
  if (ggufFiles.length > 0) {
    const file = ggufFiles[0];
    const resolved = await resolveGgufFile(`${repo}/${file.path}`, { fetchImpl });
    return {
      id: repo.split("/").pop() ?? repo,
      repo,
      format: "gguf",
      files: [resolved],
      totalSizeBytes: resolved.sizeBytes,
    };
  }

  const files = await resolveMlxRepo(repo, { fetchImpl });
  return {
    id: repo.split("/").pop() ?? repo,
    repo,
    format: "mlx",
    files,
    totalSizeBytes: files.reduce((sum, f) => sum + f.sizeBytes, 0),
  };
}

/**
 * Download a resolved model into the HF cache.
 * @param {object} model - from resolveHfDownload
 * @param {object} options
 * @param {function} options.onProgress - ({ downloadedBytes, totalBytes, percentage, file }) => void
 * @returns {Promise<{ localDir: string, format: string }>}
 */
export async function downloadToHfCache(model, options = {}) {
  await mkdir(HF_CACHE_DIR, { recursive: true });

  const script = HF_DOWNLOAD_SCRIPT;
  const args = ["--repo", model.repo];
  if (model.format === "gguf") {
    args.push("--file", model.files[0].filename);
  }

  const onProgress = options.onProgress ?? (() => {});

  return new Promise((resolve, reject) => {
    const child = execFile("python3", [script, ...args], { env: { ...process.env, HF_HOME: HF_CACHE_DIR } });

    let downloadedBytes = 0;
    let currentFile = null;

    child.stdout?.on("data", (chunk) => {
      const lines = String(chunk).split("\n").filter(Boolean);
      for (const line of lines) {
        try {
          const event = JSON.parse(line);
          if (event.type === "progress") {
            downloadedBytes = event.downloadedBytes ?? downloadedBytes;
            currentFile = event.file ?? currentFile;
            onProgress({
              downloadedBytes,
              totalBytes: model.totalSizeBytes,
              percentage: Math.min(100, Math.round((downloadedBytes / model.totalSizeBytes) * 100)),
              file: currentFile,
            });
          } else if (event.type === "complete") {
            resolve({ localDir: event.localDir, format: model.format });
          } else if (event.type === "error") {
            reject(new Error(event.message));
          }
        } catch {
          // Ignore non-JSON output (progress bars, etc.)
        }
      }
    });

    child.stderr?.on("data", () => {
      // huggingface_hub prints progress bars to stderr; ignore for now.
      // We could parse tqdm output here later.
    });

    child.on("error", reject);
    child.on("exit", (code) => {
      if (code !== 0) reject(new Error(`Download failed with exit code ${code}`));
    });
  });
}

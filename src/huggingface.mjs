// HuggingFace model download helpers.
// Uses the Python huggingface_hub package (the standard, maintained downloader)
// to download models into the standard HF cache directory.
// Downloads go to ~/.cache/huggingface/hub, NOT a custom offgrid-ai folder.

import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { join, dirname } from "node:path";
import { mkdir } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { HF_HUB_DIR } from "./config.mjs";

const execFileAsync = promisify(execFile);

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
 * Download a resolved model into the HF hub cache.
 * @param {object} model - from resolveHfDownload
 * @param {object} options
 * @param {function} options.onProgress - ({ downloadedBytes, totalBytes, percentage, file }) => void
 * @returns {Promise<{ localDir: string, format: string }>}
 */
export async function downloadToHfCache(model, options = {}) {
  await mkdir(HF_HUB_DIR, { recursive: true });

  const script = HF_DOWNLOAD_SCRIPT;
  const args = ["--repo", model.repo, "--cache-dir", HF_HUB_DIR];
  if (model.format === "gguf") {
    args.push("--file", model.files[0].filename);
  }

  const onProgress = options.onProgress ?? (() => {});

  return new Promise((resolve, reject) => {
    const child = execFile("python3", [script, ...args], { env: process.env });

    let stdoutBuf = "";
    let downloadedBytes = 0;
    let currentFile = null;

    // huggingface_hub streams NDJSON progress events to stdout, one per line.
    // Buffer and split on complete newlines so an event split across chunk
    // boundaries isn't silently dropped.
    const handleLine = (line) => {
      if (!line) return;
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
    };

    child.stdout?.on("data", (chunk) => {
      stdoutBuf += String(chunk);
      let nl;
      while ((nl = stdoutBuf.indexOf("\n")) !== -1) {
        handleLine(stdoutBuf.slice(0, nl));
        stdoutBuf = stdoutBuf.slice(nl + 1);
      }
    });

    child.stderr?.on("data", () => {
      // huggingface_hub prints progress bars to stderr; ignore.
    });

    child.on("error", reject);
    child.on("exit", (code) => {
      // Flush any final line that lacked a trailing newline.
      if (stdoutBuf.trim()) handleLine(stdoutBuf.trim());
      if (code !== 0) reject(new Error(`Download failed with exit code ${code}`));
    });
  });
}

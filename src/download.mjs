// Model download flow — HuggingFace + Ollama downloads with quant picker.
// Used by onboarding (no models found) and the model picker (↓ Download a model).

import { hasHfCli, parseHfRef, resolveHfDownload, downloadModel, listGgufFiles, listMmprojFiles, getHfModelInfo, isMlxRepo } from "./huggingface.mjs";
import { detectHardware, installedRamGB, getFreeDiskBytes } from "./hardware.mjs";
import { allFittingModels } from "./recommendations.mjs";
import { parseModelName } from "./model-name.mjs";
import { HF_HUB_DIR, hasHomebrew, omlxEnabled, ollamaEnabled } from "./config.mjs";
import { pullOllamaModel, hasOllama, installOllama, ensureOllamaServer, serverReady as ollamaServerReady } from "./ollama-runtime.mjs";
import { runCommand, commandExists } from "./exec.mjs";
import { homedir } from "node:os";
import { join } from "node:path";
import { existsSync } from "node:fs";
import { pc, formatBytes, renderCard, renderRows } from "./ui.mjs";

const GB = 1024 ** 3;

/**
 * Interactive model download flow.
 * @param {object} prompt - createPrompt() instance
 * @returns {Promise<boolean>} true if a model was downloaded
 */
export async function downloadFlow(prompt) {
  console.log("");
  const ollamaOn = await ollamaEnabled();
  const omlxOn = await omlxEnabled();

  const methodChoices = [
    { value: "hf", label: "Download a model from Hugging Face" },
    { value: "recommended", label: "Recommended for your machine" },
  ];
  if (ollamaOn) {
    methodChoices.push({ value: "ollama", label: "Download an Ollama model" });
  }
  if (omlxOn) {
    methodChoices.push({ value: "omlx", label: "Download an oMLX model" });
  }
  const method = await prompt.choice("Download a model", methodChoices, "hf");

  if (!method) return false;

  // ── oMLX: stub — oMLX manages its own downloads ──────────────────────────
  if (method === "omlx") {
    console.log(pc.dim("oMLX manages its own model downloads."));
    console.log(pc.dim("  Open the oMLX app to browse and download models, or visit huggingface.co/mlx-community"));
    return false;
  }

  // ── Ollama: two sub-options ──────────────────────────────────────────────
  if (method === "ollama") {
    return await ollamaDownloadFlow(prompt);
  }

  // ── HuggingFace: manual repo entry or recommended ────────────────────────
  let repo, filename, format = null;

  if (method === "recommended") {
    const hardware = detectHardware();
    const models = allFittingModels(hardware);
    if (models.length === 0) {
      console.log(pc.yellow("No recommended models fit your hardware."));
      console.log(pc.dim("You can still enter a repo ID manually."));
      return false;
    }
    const choices = models.map((m) => ({
      value: m,
      label: `${pc.bold(m.label)}  ${pc.dim(`(${m.minRamGb} GB RAM min)`)}`,
    }));
    const selected = await prompt.choice("Select a model", choices, choices[0].value);
    if (!selected) return false;

    // Determine available formats (ignore empty strings)
    const hasGguf = Boolean(selected.gguf);
    const hasMlx = Boolean(selected.mlx && selected.mlx.trim());

    if (hasGguf && hasMlx) {
      const formatChoices = [
        { value: "gguf", label: `GGUF (llama.cpp) — ${selected.gguf.split("/").pop()}` },
        { value: "mlx", label: `MLX — ${selected.mlx}` },
      ];
      format = await prompt.choice("Download format", formatChoices, "gguf");
      if (!format) return false;
    } else if (hasGguf) {
      format = "gguf";
    } else if (hasMlx) {
      format = "mlx";
    } else {
      console.log(pc.yellow("No download path available for this model."));
      return false;
    }

    if (format === "gguf") {
      const ref = parseHfRef(selected.gguf);
      repo = ref.repo;
      filename = ref.filename;
    } else {
      repo = selected.mlx;
      filename = undefined;
    }
  } else {
    // Manual HuggingFace repo entry
    console.log(pc.dim("  Browse models at huggingface.co/models"));
    const input = await prompt.text("HuggingFace repo ID (e.g. unsloth/Qwen3.5-4B-GGUF)", "");
    if (!input || !input.trim()) return false;
    const ref = parseHfRef(input.trim());
    repo = ref.repo;
    filename = ref.filename;
  }

  // For GGUF repos without a specific file, show quant picker.
  // Skip when the user already chose MLX from the recommended list —
  // format is known, no detection needed.
  if (!filename && format !== "mlx") {
    let ggufFiles;
    try {
      ggufFiles = await listGgufFiles(repo);
    } catch (err) {
      console.log(pc.red(`Could not fetch repo info: ${err.message}`));
      return false;
    }
    if (ggufFiles.length > 0) {
      filename = await pickGgufQuant(prompt, repo, ggufFiles);
      if (!filename) return false;
    } else {
      // No GGUF files — check if it's an MLX repo
      let modelInfo;
      try {
        modelInfo = await getHfModelInfo(repo);
      } catch {
        console.log(pc.red(`Could not fetch repo info for ${repo}. Check the repo ID and try again.`));
        return false;
      }
      if (isMlxRepo(modelInfo)) {
        // It's MLX — download everything to HF cache
      } else {
        console.log(pc.yellow(`This repo is not a GGUF or MLX model (library: ${modelInfo.library_name ?? "unknown"}).`));
        console.log(pc.dim("For GGUF: look for a repo ending in -GGUF (e.g. org/model-name-GGUF)"));
        console.log(pc.dim("For MLX: look for a repo in mlx-community/ (e.g. mlx-community/model-name-4bit)"));
        return false;
      }
    }
  }

  // Ensure HuggingFace CLI is available — offer to install if missing
  if (!(await hasHfCli())) {
    const shouldInstall = await prompt.yesNo(
      "HuggingFace CLI is required to download models. Install it now?", true,
    );
    if (!shouldInstall) {
      console.log(pc.dim("Install it manually: pip3 install huggingface_hub"));
      return false;
    }
    const installed = await installHfCli();
    if (!installed) return false;
  }

  // Resolve download plan
  const ref = filename ? `${repo}/${filename}` : repo;
  let plan;
  try {
    plan = await resolveHfDownload(ref);
  } catch (err) {
    console.log(pc.red(`Could not resolve download: ${err.message}`));
    return false;
  }

  // For GGUF, check if the repo has a vision projector (mmproj) to download alongside
  let extraFiles = [];
  if (plan.format === "gguf") {
    try {
      const mmprojFiles = await listMmprojFiles(repo);
      if (mmprojFiles.length > 0) {
        const mmproj = mmprojFiles[0];
        extraFiles = [mmproj.path];
        plan.totalSizeBytes += mmproj.sizeBytes;
        console.log(pc.dim(`Includes vision projector: ${mmproj.path} (${formatBytes(mmproj.sizeBytes)})`));
      }
    } catch {
      // If we can't check for mmproj, proceed without it
    }
  }

  // Check disk space — all downloads go to HF cache
  const freeBytes = getFreeDiskBytes(HF_HUB_DIR);
  if (plan.totalSizeBytes > 0 && freeBytes < plan.totalSizeBytes * 1.1) {
    console.log(pc.red(`Not enough disk space: need ~${formatBytes(plan.totalSizeBytes)}, only ${formatBytes(freeBytes)} free.`));
    return false;
  }

  console.log(pc.dim(`\nDownloading ${repo}${filename ? `/${filename}` : ""} (${formatBytes(plan.totalSizeBytes)})`));
  console.log(pc.dim(`Location: HF cache (${HF_HUB_DIR})\n`));

  try {
    await downloadModel(plan, { extraFiles });
    console.log(pc.green("\n✓ Download complete. Run offgrid-ai again to see the model in the picker."));
    return true;
  } catch (err) {
    console.log(pc.red("\nDownload failed: " + err.message));
    return false;
  }
}

// ── Ollama download flow ─────────────────────────────────────────────────────

/**
 * Ollama download flow — two paths:
 * 1. Pull from Ollama library (text input, e.g. qwen3:8b)
 * 2. Pull GGUF from HuggingFace (quant picker with RAM fit, then ollama pull)
 */
async function ollamaDownloadFlow(prompt) {
  const subChoice = await prompt.choice("Download an Ollama model", [
    { value: "library", label: "Pull from Ollama library (e.g. qwen3:8b)" },
    { value: "hf_gguf", label: "Pull GGUF from HuggingFace (with quant picker)" },
  ], "library");

  if (!subChoice) return false;

  if (subChoice === "library") {
    console.log(pc.dim("  Browse models at ollama.com/library"));
    const input = await prompt.text("Ollama model name (e.g. qwen3:8b, llama3.2:3b)", "");
    if (!input || !input.trim()) return false;
    return await downloadViaOllama(prompt, input.trim());
  }

  // HF GGUF via Ollama — quant picker then ollama pull
  console.log(pc.dim("  Browse GGUF models at huggingface.co/models"));
  const input = await prompt.text("HuggingFace repo ID (e.g. unsloth/Qwen3.5-4B-GGUF)", "");
  if (!input || !input.trim()) return false;
  const ref = parseHfRef(input.trim());

  let ggufFiles;
  try {
    ggufFiles = await listGgufFiles(ref.repo);
  } catch (err) {
    console.log(pc.red(`Could not fetch repo info: ${err.message}`));
    return false;
  }
  if (ggufFiles.length === 0) {
    console.log(pc.yellow("No GGUF files found in this repo. Look for a repo ending in -GGUF."));
    return false;
  }

  const filename = await pickGgufQuant(prompt, ref.repo, ggufFiles);
  if (!filename) return false;

  const modelRef = `hf.co/${ref.repo}:${filename}`;
  return await downloadViaOllama(prompt, modelRef);
}

/**
 * Download a model through Ollama's pull API.
 * Ollama manages model storage, loading, and unloading automatically.
 * @param {object} prompt - createPrompt() instance
 * @param {string} modelRef - Ollama model reference (e.g. "hf.co/org/repo:file.gguf" or "qwen3:8b")
 * @returns {Promise<boolean>} true if pull succeeded
 */
async function downloadViaOllama(prompt, modelRef) {
  // Ensure Ollama is installed
  if (!(await hasOllama())) {
    console.log(pc.yellow("Ollama is enabled but not installed."));
    const shouldInstall = await prompt.yesNo("Install Ollama now?", true);
    if (!shouldInstall) {
      console.log(pc.dim("Install manually: brew install ollama  —  or  curl -fsSL https://ollama.com/install.sh | sh"));
      return false;
    }
    const installed = await installOllama();
    if (!installed) return false;
  }

  // Ensure server is running
  await ensureOllamaServer();
  if (!(await ollamaServerReady())) {
    process.stdout.write(pc.dim("Waiting for Ollama server"));
    for (let i = 0; i < 30; i++) {
      await new Promise((resolve) => setTimeout(resolve, 1000));
      if (await ollamaServerReady()) break;
      process.stdout.write(".");
    }
    console.log("");
    if (!(await ollamaServerReady())) {
      console.log(pc.yellow("Ollama server is starting up — try again in a moment."));
      console.log(pc.dim("  Run: ollama serve"));
      return false;
    }
  }

  console.log(pc.dim(`\nOllama will pull ${modelRef}`));
  console.log(pc.dim("Ollama manages model storage and loading automatically.\n"));

  const ok = await pullOllamaModel(modelRef);
  if (ok) {
    console.log(pc.green("\n✓ Run offgrid-ai again to see the model in the picker."));
  }
  return ok;
}

// ── Quant picker with RAM fit indicators ───────────────────────────────────

async function pickGgufQuant(prompt, repo, ggufFiles) {
  const hardware = detectHardware();
  const totalRam = hardware.totalRamBytes;
  const availableRam = totalRam - 4 * GB; // leave 4GB for OS

  // Sort by size ascending (smallest first, largest last)
  const sorted = [...ggufFiles].sort((a, b) => a.sizeBytes - b.sizeBytes);

  // Find recommended: largest file that fits comfortably (last one that fits)
  const fitting = sorted.filter((f) => f.sizeBytes + 2 * GB <= availableRam);
  const recommended = fitting[fitting.length - 1];

  console.log("");
  console.log(renderCard("Select quantization", renderRows([
    ["Your RAM", `${installedRamGB()} GB`],
    ["Available", `~${formatBytes(availableRam)} (after OS)`],
    ["Rule", "Lower quant = smaller/faster · Higher = better quality"],
  ]), { formatBorder: pc.cyan }));
  console.log("");

  const choices = sorted.map((file) => {
    const sizeBytes = file.sizeBytes;
    const parsed = parseModelName(file.path, "huggingface");
    const quant = parsed.quant ?? file.path.replace(/\.gguf$/i, "");

    let indicator, fitLabel;
    if (sizeBytes > availableRam) {
      indicator = pc.red("✗");
      fitLabel = pc.red("won't fit");
    } else if (sizeBytes + 2 * GB > availableRam) {
      indicator = pc.yellow("⚠");
      fitLabel = pc.yellow("tight");
    } else {
      indicator = pc.green("✓");
      fitLabel = pc.green("fits");
    }

    const isRecommended = recommended && file.path === recommended.path;
    const hint = isRecommended ? "recommended" : undefined;

    return {
      value: file.path,
      label: `${indicator}  ${quant.padEnd(12)} ${formatBytes(sizeBytes).padEnd(10)} ${fitLabel}`,
      ...(hint ? { hint } : {}),
    };
  });

  const defaultValue = recommended?.path;
  return await prompt.choice("Quantization", choices, defaultValue);
}

// ── HuggingFace CLI installation ─────────────────────────────────────────────

/**
 * Install the HuggingFace CLI. Tries, in order:
 *   1. Standalone installer (`curl -LsSf https://hf.co/cli/install.sh | bash`)
 *      HF's recommended method, no Python or Homebrew needed
 *   2. Homebrew (`brew install hf`) — handles Python dependency automatically
 *   3. pip3 / python3 -m pip — traditional fallback if Python is available
 * @returns {Promise<boolean>} true if hf CLI is available after install
 */
export async function installHfCli() {
  console.log(pc.cyan("Installing HuggingFace CLI..."));

  // 1. Standalone installer (HF recommended — zero dependencies)
  try {
    await runCommand("/bin/bash", ["-c", "curl -LsSf https://hf.co/cli/install.sh | bash"], { label: "hf standalone", verbose: true });
    // The installer puts hf in ~/.local/bin — add to PATH for this process
    const localBin = join(homedir(), ".local", "bin");
    if (existsSync(localBin) && !process.env.PATH.includes(localBin)) {
      process.env.PATH = `${localBin}:${process.env.PATH}`;
    }
    if (await hasHfCli()) {
      console.log(pc.green("HuggingFace CLI installed via standalone installer."));
      return true;
    }
  } catch { /* fall through to Homebrew */ }

  // 2. Homebrew (macOS / Linuxbrew)
  if (await hasHomebrew()) {
    try {
      await runCommand("brew", ["install", "hf"], { label: "hf", verbose: true });
      if (await hasHfCli()) {
        console.log(pc.green("HuggingFace CLI installed via Homebrew."));
        return true;
      }
    } catch { /* fall through to pip */ }
  }

  // 3. pip3 / python3 -m pip (requires Python)
  try {
    if (await commandExists("pip3")) {
      await runCommand("pip3", ["install", "huggingface_hub"], { label: "huggingface_hub", verbose: true });
    } else if (await commandExists("python3")) {
      await runCommand("python3", ["-m", "pip", "install", "huggingface_hub"], { label: "huggingface_hub", verbose: true });
    } else {
      console.log(pc.red("Could not install HuggingFace CLI — no Homebrew, standalone installer, or Python found."));
      console.log(pc.dim("Install manually: brew install hf  — or  curl -LsSf https://hf.co/cli/install.sh | bash"));
      return false;
    }
  } catch (err) {
    console.log(pc.red(`Installation failed: ${err.message}`));
    console.log(pc.dim("Install manually: brew install hf  — or  curl -LsSf https://hf.co/cli/install.sh | bash"));
    return false;
  }

  // Verify it's now available
  if (!(await hasHfCli())) {
    console.log(pc.yellow("HuggingFace CLI was installed but not found on PATH."));
    console.log(pc.dim("Restart your terminal and run offgrid-ai again."));
    return false;
  }
  console.log(pc.green("HuggingFace CLI installed."));
  return true;
}
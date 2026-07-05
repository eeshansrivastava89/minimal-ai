// Model download flow — HuggingFace downloads with quant picker and RAM fit.
// Used by onboarding (no models found) and the model picker (↓ Download a model).

import { hasHfCli, parseHfRef, resolveHfDownload, downloadModel, listGgufFiles, listMmprojFiles, getHfModelInfo, isMlxRepo } from "./huggingface.mjs";
import { detectHardware, installedRamGB, getFreeDiskBytes } from "./hardware.mjs";
import { allFittingModels } from "./recommendations.mjs";
import { parseModelName } from "./model-name.mjs";
import { HF_HUB_DIR } from "./config.mjs";
import { offerOmlxRestart } from "./omlx-runtime.mjs";
import { runCommand, commandExists } from "./exec.mjs";
import { homedir } from "node:os";
import { join } from "node:path";
import { pc, formatBytes, renderCard, renderRows } from "./ui.mjs";

const GB = 1024 ** 3;

/**
 * Interactive model download flow.
 * @param {object} prompt - createPrompt() instance
 * @returns {Promise<boolean>} true if a model was downloaded
 */
export async function downloadFlow(prompt) {
  console.log("");
  const method = await prompt.choice("Download a model", [
    { value: "manual", label: "Enter a HuggingFace repo ID" },
    { value: "recommended", label: "Recommended for your machine" },
  ], "manual");

  if (!method) return false;

  let repo, filename;

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

    let format;
    if (hasGguf && hasMlx) {
      // Both available — let the user choose
      const formatChoices = [
        { value: "gguf", label: `GGUF (llama.cpp) — ${selected.gguf.split("/").pop()}` },
        { value: "mlx", label: `MLX (oMLX) — ${selected.mlx}` },
      ];
      // Default to MLX on Apple Silicon, GGUF elsewhere
      const defaultFormat = (hardware.platform === "darwin" && hardware.arch === "arm64") ? "mlx" : "gguf";
      format = await prompt.choice("Download format", formatChoices, defaultFormat);
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
    console.log(pc.dim("  Browse models at huggingface.co/models"));
    const input = await prompt.text("HuggingFace repo ID (e.g. unsloth/gemma-4-E2B-it-GGUF)", "");
    if (!input || !input.trim()) return false;
    const ref = parseHfRef(input.trim());
    repo = ref.repo;
    filename = ref.filename;
  }

  // For GGUF repos without a specific file, show quant picker
  if (!filename) {
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
      // No GGUF files — check if it's an MLX repo via HF metadata
      let modelInfo;
      try {
        modelInfo = await getHfModelInfo(repo);
      } catch {
        console.log(pc.red(`Could not fetch repo info for ${repo}. Check the repo ID and try again.`));
        return false;
      }
      if (!isMlxRepo(modelInfo)) {
        console.log(pc.yellow(`This repo is not a GGUF or MLX model (library: ${modelInfo.library_name ?? "unknown"}).`));
        console.log(pc.dim("For llama.cpp: look for a repo ending in -GGUF (e.g. org/model-name-GGUF)"));
        console.log(pc.dim("For oMLX: look for a repo in mlx-community/ (e.g. mlx-community/model-name-4bit)"));
        return false;
      }
      // It's MLX — download everything
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

  // Check disk space at the actual download target (HF cache for GGUF,
  // ~/.omlx/models/ for MLX) — they may be on different volumes.
  const diskCheckDir = plan.format === "mlx"
    ? join(homedir(), ".omlx", "models")
    : HF_HUB_DIR;
  const freeBytes = getFreeDiskBytes(diskCheckDir);
  if (plan.totalSizeBytes > 0 && freeBytes < plan.totalSizeBytes * 1.1) {
    console.log(pc.red(`Not enough disk space: need ~${formatBytes(plan.totalSizeBytes)}, only ${formatBytes(freeBytes)} free.`));
    return false;
  }

  console.log(pc.dim(`\nDownloading ${repo}${filename ? `/${filename}` : ""} (${formatBytes(plan.totalSizeBytes)})`));
  if (plan.format === "mlx") {
    const modelParts = repo.split("/").filter(Boolean);
    const localDir = join(homedir(), ".omlx", "models", ...modelParts);
    console.log(pc.dim(`Location: ${localDir}\n`));
  } else {
    console.log(pc.dim(`Location: HF cache (${HF_HUB_DIR})\n`));
  }

  try {
    if (plan.format === "mlx") {
      // Download directly to ~/.omlx/models/<org>/<model> — oMLX scans this dir
      const modelParts = repo.split("/").filter(Boolean);
      const localDir = join(homedir(), ".omlx", "models", ...modelParts);
      await downloadModel(plan, { localDir });
      console.log(pc.green("\n✓ Download complete."));
      await offerOmlxRestart(prompt, "to load the new model");
    } else {
      await downloadModel(plan, { extraFiles });
      console.log(pc.green("\n✓ Download complete. Run offgrid-ai again to see the model in the picker."));
    }
    return true;
  } catch (err) {
    console.log(pc.red("\nDownload failed: " + err.message));
    return false;
  }
}

// ── Quant picker with RAM fit indicators ───────────────────────────────────

async function pickGgufQuant(prompt, repo, ggufFiles) {
  const hardware = detectHardware();
  const totalRam = hardware.totalRamBytes;
  const availableRam = totalRam - 4 * GB; // leave 4GB for OS

  // Sort by size descending (highest quality first)
  const sorted = [...ggufFiles].sort((a, b) => b.sizeBytes - a.sizeBytes);

  // Find recommended: largest file that fits comfortably
  const recommended = sorted.find((f) => f.sizeBytes + 2 * GB <= availableRam);

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
 * Install the HuggingFace CLI (huggingface_hub) via pip3.
 * Tries pip3, then python3 -m pip as a fallback.
 * @returns {Promise<boolean>} true if hf CLI is available after install
 */
async function installHfCli() {
  console.log(pc.cyan("Installing HuggingFace CLI..."));
  try {
    if (await commandExists("pip3")) {
      await runCommand("pip3", ["install", "huggingface_hub"], { label: "huggingface_hub", verbose: true });
    } else if (await commandExists("python3")) {
      await runCommand("python3", ["-m", "pip", "install", "huggingface_hub"], { label: "huggingface_hub", verbose: true });
    } else {
      console.log(pc.red("Python 3 / pip not found. Install Python 3 first, then: pip3 install huggingface_hub"));
      return false;
    }
  } catch (err) {
    console.log(pc.red(`Installation failed: ${err.message}`));
    console.log(pc.dim("Install it manually: pip3 install huggingface_hub"));
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

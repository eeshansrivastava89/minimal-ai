// Model download flow — HuggingFace downloads with quant picker and RAM fit.
// Used by onboarding (no models found) and the model picker (↓ Download a model).

import { hasHuggingfaceHub, parseHfRef, resolveHfDownload, downloadToHfCache, listGgufFiles } from "./huggingface.mjs";
import { detectHardware, installedRamGB, getFreeDiskBytes } from "./hardware.mjs";
import { allFittingModels } from "./recommendations.mjs";
import { parseModelName } from "./model-name.mjs";
import { HF_HUB_DIR } from "./config.mjs";
import { pc, formatBytes, renderCard, renderRows } from "./ui.mjs";

const GB = 1024 ** 3;

/**
 * Interactive model download flow.
 * @param {object} prompt - createPrompt() instance
 * @returns {Promise<boolean>} true if a model was downloaded
 */
export async function downloadFlow(prompt) {
  const method = await prompt.choice("Download a model", [
    { value: "recommended", label: "Recommended for your machine" },
    { value: "manual", label: "Enter a HuggingFace repo ID" },
    { value: "back", label: "Back" },
  ], "recommended");

  if (!method || method === "back") return false;

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
    }
    // If no GGUF files, it's an MLX repo — download everything
  }

  // Check for huggingface_hub
  if (!(await hasHuggingfaceHub())) {
    console.log(pc.yellow("HuggingFace CLI is required to download models."));
    console.log(pc.dim("Install it: pip3 install huggingface_hub"));
    return false;
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

  // Check disk space
  const freeBytes = getFreeDiskBytes(HF_HUB_DIR);
  if (plan.totalSizeBytes > 0 && freeBytes < plan.totalSizeBytes * 1.1) {
    console.log(pc.red(`Not enough disk space: need ~${formatBytes(plan.totalSizeBytes)}, only ${formatBytes(freeBytes)} free.`));
    return false;
  }

  console.log(pc.dim(`\nDownloading ${repo}${filename ? `/${filename}` : ""} (${formatBytes(plan.totalSizeBytes)})...`));

  try {
    await downloadToHfCache(plan, {
      onProgress({ percentage }) {
        process.stdout.write(pc.cyan(`\r  ${percentage}% downloaded`));
      },
    });
    process.stdout.write("\n");
    console.log(pc.green("✓ Download complete. The model will appear in the picker."));
    return true;
  } catch (err) {
    process.stdout.write("\n");
    console.log(pc.red("Download failed: " + err.message));
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
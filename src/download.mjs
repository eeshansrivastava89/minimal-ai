import { hasHfCli, parseHfRef, resolveHfDownload, downloadModel, listGgufFiles, listMmprojFiles, getHfTree, getHfModelInfo, isMlxRepo, installHfCli } from "./huggingface.mjs";
import { installedRamGB, availableRamBytes, getFreeDiskBytes, fitCheck } from "./hardware.mjs";
import { parseModelName } from "./model-name.mjs";
import { HF_HUB_DIR } from "./config.mjs";
import { promptText, promptConfirm, promptSelect, formatBytes, status, theme, card, renderList } from "./ui.mjs";

export async function downloadHfGguf() {
  console.log(theme.subtle("  Browse models at huggingface.co/models"));
  const input = await promptText({ message: "HuggingFace repo ID (e.g. unsloth/Qwen3.5-4B-GGUF)", defaultValue: "" });
  if (!input || !input.trim()) return false;
  const ref = parseHfRef(input.trim());
  return await _downloadHfGguf(ref.repo, ref.filename);
}

async function _downloadHfGguf(repo, filename) {
  // One tree fetch serves quant picking, mmproj lookup, and the download plan.
  let tree;
  try {
    tree = await getHfTree(repo);
  } catch (err) {
    console.log(status({ kind: "error", message: `Could not fetch repo info: ${err.message}` }));
    return false;
  }

  if (!filename) {
    const ggufFiles = await listGgufFiles(repo, { tree });
    if (ggufFiles.length > 0) {
      filename = await pickGgufQuant(repo, ggufFiles);
      if (!filename) return false;
    } else {
      let modelInfo;
      try {
        modelInfo = await getHfModelInfo(repo);
      } catch {
        console.log(status({ kind: "error", message: `Could not fetch repo info for ${repo}. Check the repo ID and try again.` }));
        return false;
      }
      if (isMlxRepo(modelInfo)) {
        console.log(status({ kind: "warning", message: "This is an MLX repo, not GGUF. llama.cpp cannot run MLX models." }));
        console.log(theme.subtle("  To use MLX: enable the oMLX backend and download via the oMLX app."));
        console.log(theme.subtle("  To find GGUF: look for a repo ending in -GGUF (e.g. org/model-name-GGUF)"));
        return false;
      } else {
        console.log(status({ kind: "warning", message: `This repo is not a GGUF or MLX model (library: ${modelInfo.library_name ?? "unknown"}).` }));
        console.log(theme.subtle("For GGUF: look for a repo ending in -GGUF (e.g. org/model-name-GGUF)"));
        console.log(theme.subtle("For MLX: look for a repo in mlx-community/ (e.g. mlx-community/model-name-4bit)"));
        return false;
      }
    }
  }

  if (!(await hasHfCli())) {
    const shouldInstall = await promptConfirm({
      message: "HuggingFace CLI is required to download models. Install it now?",
      initialValue: true,
    });
    if (!shouldInstall) {
      console.log(theme.subtle("Install it manually: pip3 install huggingface_hub"));
      return false;
    }
    const installed = await installHfCli();
    if (!installed) return false;
  }

  const downloadRef = filename ? `${repo}/${filename}` : repo;
  let plan;
  try {
    plan = await resolveHfDownload(downloadRef, { tree });
  } catch (err) {
    console.log(status({ kind: "error", message: `Could not resolve download: ${err.message}` }));
    return false;
  }

  let extraFiles = [];
  if (plan.format === "gguf") {
    try {
      const mmprojFiles = await listMmprojFiles(repo, { tree });
      if (mmprojFiles.length > 0) {
        const mmproj = mmprojFiles[0];
        extraFiles = [mmproj.path];
        plan.totalSizeBytes += mmproj.sizeBytes;
        console.log(theme.subtle(`Includes vision projector: ${mmproj.path} (${formatBytes(mmproj.sizeBytes)})`));
      }
    } catch {
      // proceed without mmproj
    }
  }

  const freeBytes = getFreeDiskBytes(HF_HUB_DIR);
  if (plan.totalSizeBytes > 0 && freeBytes < plan.totalSizeBytes * 1.1) {
    console.log(status({ kind: "error", message: `Not enough disk space: need ~${formatBytes(plan.totalSizeBytes)}, only ${formatBytes(freeBytes)} free.` }));
    return false;
  }

  console.log(theme.subtle(`\nDownloading ${repo}${filename ? `/${filename}` : ""} (${formatBytes(plan.totalSizeBytes)})`));
  console.log(theme.subtle(`Location: HF cache (${HF_HUB_DIR})\n`));

  try {
    await downloadModel(plan, { extraFiles });
    console.log(status({ kind: "success", message: "Download complete. Run minimal-ai again to see the model in the picker." }));
    return true;
  } catch (err) {
    console.log(status({ kind: "error", message: "Download failed: " + err.message }));
    return false;
  }
}

async function pickGgufQuant(repo, ggufFiles) {
  const availableRam = availableRamBytes();
  const sorted = [...ggufFiles].sort((a, b) => a.sizeBytes - b.sizeBytes);
  const fitting = sorted.filter((f) => fitCheck(f.sizeBytes + Math.round(f.sizeBytes * 0.1), availableRam).status === "fits");
  const recommended = fitting[fitting.length - 1];

  console.log();
  console.log(card({
    title: "Select quantization",
    body: renderList([
      ["Your RAM", `${installedRamGB()} GB`],
      ["Available", `~${formatBytes(availableRam)} (free + reclaimable)`],
      ["Rule", "Lower quant = smaller/faster · Higher = better quality"],
    ]),
  }));
  console.log();

  const choices = sorted.map((file) => {
    const sizeBytes = file.sizeBytes;
    const parsed = parseModelName(file.path, "huggingface");
    const quant = parsed.quant ?? file.path.replace(/\.gguf$/i, "");
    const { status: fitStatus } = fitCheck(sizeBytes + Math.round(sizeBytes * 0.1), availableRam);

    let fitLabel;
    if (fitStatus === "won't fit") fitLabel = status({ kind: "error", message: "won't fit" });
    else if (fitStatus === "tight") fitLabel = status({ kind: "warning", message: "tight" });
    else fitLabel = status({ kind: "success", message: "fits" });

    const isRecommended = recommended && file.path === recommended.path;
    return {
      value: file.path,
      label: `${quant.padEnd(12)} ${formatBytes(sizeBytes).padEnd(10)}`,
      hint: isRecommended ? "recommended" : fitLabel,
    };
  });

  return await promptSelect({ message: "Quantization", choices, defaultValue: recommended?.path });
}

import { existsSync, statSync } from "node:fs";
import { basename, dirname } from "node:path";
import { backendFor } from "./backends.mjs";
import { readCommandArgv } from "./profiles.mjs";
import { isProfileRunning } from "./process.mjs";
import { buildPrettyCommand } from "./command.mjs";
import { pc, formatBytes, renderRows, renderSection } from "./ui.mjs";
import { capabilitySummary, ggufDetailParts, isProfileFileMissing, profileDetailParts } from "./model-summary.mjs";
import { itemKey } from "./model-catalog.mjs";
import { DATA_DIR } from "./config.mjs";
import { findBenchmarkRepo } from "./benchmark.mjs";

const OPTION_SEPARATOR = pc.dim("  │  ");
const OPTION_STATUS_WIDTH = 10;
const OPTION_BACKEND_WIDTH = 14;
const OPTION_SOURCE_WIDTH = 14;
const OPTION_CTX_WIDTH = 5;

const { stripVTControlCharacters } = await import("node:util");

function optionPad(text, color, width) {
  const visible = stripVTControlCharacters(String(text)).length;
  const padding = Math.max(1, width - visible);
  return (color ? color(String(text)) : String(text)) + " ".repeat(padding);
}

function optionStatusTag(kind) {
  const statuses = {
    running: ["RUNNING", pc.green],
    serverup: ["READY", pc.blue],
    ready: ["READY", pc.blue],
    missing: ["MISSING", pc.red],
    setup: ["SETUP", pc.yellow],
  };
  const [text, color] = statuses[kind] ?? [kind, pc.dim];
  return optionPad(text, color, OPTION_STATUS_WIDTH);
}

function optionSourceTag(sourceId) {
  const label = formatSourceLabel(sourceId);
  const colors = {
    huggingface: pc.cyan,
    lmstudio: pc.blue,
    omlx: pc.magenta,
    "llama.cpp": pc.cyan,
    gguf: pc.cyan,
    mlx: pc.yellow,
    "mlx-vlm": pc.yellow,
  };
  return optionPad(label, colors[sourceId] ?? pc.dim, OPTION_SOURCE_WIDTH);
}

function optionBackendTag(backendId) {
  const backend = backendId ? backendFor(backendId) : null;
  const label = backend?.label ?? backendId ?? "unknown";
  const colors = {
    "llama-cpp": pc.cyan,
    "llama-cpp-mtp": pc.blue,
    omlx: pc.magenta,
    "mlx-vlm": pc.yellow,
  };
  return optionPad(label, colors[backendId] ?? pc.dim, OPTION_BACKEND_WIDTH);
}

function formatSourceLabel(sourceId) {
  if (!sourceId) return "unknown";
  const map = {
    huggingface: "HuggingFace",
    lmstudio: "LM Studio",
    omlx: "oMLX",
    "llama.cpp": "llama.cpp",
    gguf: "GGUF file",
    mlx: "MLX",
    "mlx-vlm": "MLX",
  };
  return map[sourceId] ?? String(sourceId);
}

function inferSourceFromPath(modelPath) {
  if (!modelPath) return null;
  const normalized = modelPath.toLowerCase().replace(/\\/g, "/");
  if (normalized.includes("/.omlx/models")) return "omlx";
  if (normalized.includes("/.lmstudio/models")) return "lmstudio";
  if (normalized.includes("/.cache/huggingface")) return "huggingface";
  if (normalized.includes("/.cache/llama.cpp")) return "llama.cpp";
  const parent = basename(dirname(modelPath));
  if (parent && parent !== ".") return parent.replace(/^\./, "");
  return null;
}

function discoverySourceForProfile(profile) {
  const backend = backendFor(profile.backend);
  if (backend.type === "managed-server") return backend.id;
  if (profile.source && profile.source !== "local-gguf") return profile.source;
  return inferSourceFromPath(profile.modelPath);
}

function discoverySourceForItem(item) {
  if (item.type === "profile") return discoverySourceForProfile(item.profile);
  return item.model?.source ?? null;
}

function optionCtxLabel(item) {
  if (item.type === "profile" && item.profile.flags?.ctxSize) {
    return optionPad(`${(item.profile.flags.ctxSize / 1000).toFixed(0)}k`, null, OPTION_CTX_WIDTH);
  }
  return optionPad("—", null, OPTION_CTX_WIDTH);
}

function optionSizeLabel(item, managedModels) {
  if (item.type === "profile") {
    if (item.fileMissing) return "—";
    if (item.profile.modelSizeBytes) return formatBytes(item.profile.modelSizeBytes);
    if (item.profile.modelPath && existsSync(item.profile.modelPath)) {
      const s = statSync(item.profile.modelPath);
      // Only stat regular files — a modelPath that is a directory (MLX)
      // reports the dir entry size, not the model size.
      if (s.isFile()) return formatBytes(s.size);
    }
    const managedSize = managedProfileSizeBytes(item.profile, managedModels);
    if (managedSize) return formatBytes(managedSize);
    return "—";
  }
  if (item.type === "new") {
    return formatBytes(item.model.sizeBytes);
  }
  // managed
  if (item.model.sizeBytes) return formatBytes(item.model.sizeBytes);
  if (item.model.quant) return item.model.quant;
  return "—";
}

export function modelNameWidth(items) {
  const maxName = Math.max(...items.map((item) =>
    stripVTControlCharacters(item.label ?? item.model?.label ?? item.profile?.label ?? "").length,
  ));
  return Math.max(20, maxName + 2);
}

function optionLabel({ status, backend, source, name, ctx, size, nameWidth }) {
  return [status, backend, source, pc.bold(optionPad(name, null, nameWidth)), ctx, pc.dim(size)].join(OPTION_SEPARATOR);
}

export function modelSelectOption(item, { runningProfilesNow, modelMissingIds, nameWidth, managedModels }) {
  const sourceId = discoverySourceForItem(item) ?? "unknown";
  const backendId = inferBackendId(item);
  if (item.type === "profile") {
    const backend = backendFor(item.profile.backend);
    const running = runningProfilesNow.some((profile) => profile.id === item.profile.id);
    const modelMissing = !item.fileMissing && modelMissingIds?.has(item.profile.id);
    const status = item.fileMissing || modelMissing ? "missing" : running ? "running" : "ready";
    const drafterMissing = Boolean(item.profile.drafterPath) && !existsSync(item.profile.drafterPath);
    const hint = drafterMissing ? "MTP drafter missing — reconfigure"
      : modelMissing ? `${backend.label} model no longer available`
      : undefined;
    return {
      value: itemKey(item),
      label: optionLabel({
        status: optionStatusTag(status),
        backend: optionBackendTag(backendId),
        source: optionSourceTag(sourceId),
        name: item.profile.label,
        nameWidth,
        ctx: optionCtxLabel(item),
        size: optionSizeLabel(item, managedModels),
      }),
      ...(hint ? { hint: pc.red(hint) } : {}),
    };
  }
  if (item.type === "new") {
    return {
      value: itemKey(item),
      label: optionLabel({
        status: optionStatusTag("setup"),
        backend: optionBackendTag(backendId),
        source: optionSourceTag(sourceId),
        name: item.model.label,
        nameWidth,
        ctx: optionCtxLabel(item),
        size: optionSizeLabel(item, managedModels),
      }),
    };
  }
  return {
    value: itemKey(item),
    label: optionLabel({
      status: optionStatusTag("setup"),
      backend: optionBackendTag(backendId),
      source: optionSourceTag(sourceId),
      name: item.model.label,
      nameWidth,
      ctx: optionCtxLabel(item),
      size: optionSizeLabel(item, managedModels),
    }),
  };
}

function managedProfileSizeBytes(profile, managedModels) {
  if (!managedModels || !Array.isArray(managedModels)) return null;
  const backend = backendFor(profile.backend);
  if (backend.type !== "managed-server") return null;
  const backendModels = managedModels.find((m) => m.backendId === profile.backend)?.models ?? [];
  const modelId = profile.omlxModel ?? null;
  if (!modelId) return null;
  const model = backendModels.find((m) => m.id === modelId);
  return model?.sizeBytes || null;
}

function inferBackendId(item) {
  if (item.type === "profile") return item.profile.backend;
  if (item.type === "managed") return item.backendId;
  // new model: derive from format
  if (item.model?.format === "mlx") return "mlx-vlm";
  if (item.model?.backend) return item.model.backend;
  return "llama-cpp";
}

export function printWorkspaceHeader(normalized, runningProfilesNow, modelMissingIds = new Set()) {
  const profiles = normalized.profiles;
  const isRunning = (p) => runningProfilesNow.some((r) => r.id === p.id);
  const isMissing = (p) => isProfileFileMissing(p) || modelMissingIds.has(p.id);
  const readyCount = profiles.filter((p) => !isMissing(p) && !isRunning(p)).length;
  const runningCount = runningProfilesNow.length;
  const missingCount = profiles.filter(isMissing).length;
  const setupCount = normalized.newModels.length + normalized.managedItems.length;

  const countParts = [];
  if (runningCount > 0) countParts.push(pc.green(`${runningCount} running`));
  if (readyCount > 0) countParts.push(pc.blue(`${readyCount} model${readyCount === 1 ? "" : "s"} ready`));
  if (missingCount > 0) countParts.push(pc.red(`${missingCount} model${missingCount === 1 ? "" : "s"} missing`));
  if (setupCount > 0) countParts.push(pc.yellow(`${setupCount} model${setupCount === 1 ? "" : "s"} need${setupCount === 1 ? "s" : ""} setup`));

  console.log(`   ${countParts.join(pc.dim(" · "))}`);
  console.log(pc.dim(`   Profiles: ${DATA_DIR}`));
  console.log(pc.dim("   ─────────────────────────────────────────────────────────"));
}

export async function printBenchmarkLine() {
  const repoPath = await findBenchmarkRepo();
  if (repoPath) {
    console.log(pc.green("   ✓") + " local-llm-visual-benchmark linked");
  } else {
    console.log(pc.yellow("   ○") + " to run benchmarks, pair with " + pc.cyan("local-llm-visual-benchmark"));
  }
}

export async function printProfileDetails(profile) {
  const backend = backendFor(profile.backend);
  const isManaged = backend.type === "managed-server";
  const running = await isProfileRunning(profile);
  const fileMissing = !isManaged && isProfileFileMissing(profile);
  console.log("\n" + renderSection("Model overview", renderRows([
    ["Name", pc.bold(profile.label)],
    ["Status", fileMissing ? pc.red("File missing") : running ? pc.green("Running now") : pc.blue("Ready")],
    ["Details", profileDetailParts(profile, { fileMissing }).join(pc.dim(" · "))],
    ["Server", fileMissing ? pc.red(profile.baseUrl) : profile.baseUrl],
  ])));

  const detailRows = [
    ["Setup ID", profile.id],
    ["Runs with", backend.label],
    ["Model alias", profile.modelAlias],
    ...(profile.capabilities ? [["Detected", capabilitySummary(profile.capabilities)]] : []),
  ];
  if (!isManaged) {
    detailRows.push(
      ["Local file", fileMissing ? pc.red(`${profile.modelPath} (not found)`) : profile.modelPath ?? "unknown"],
      ["Vision file", profile.mmprojPath ? (existsSync(profile.mmprojPath) ? profile.mmprojPath : pc.red(`${profile.mmprojPath} (not found)`)) : "none"],
      ["Model size", profile.modelPath && existsSync(profile.modelPath) ? formatBytes(statSync(profile.modelPath).size) : "unknown"],
    );
    if (profile.drafterPath) {
      detailRows.push(["Drafter", existsSync(profile.drafterPath) ? profile.drafterPath : pc.red(`${profile.drafterPath} (not found)`)]);
    }
  }
  console.log("\n" + renderSection("Model details", renderRows(detailRows), { columns: 110 }));

  if (fileMissing) console.log("\n" + pc.red("⚠ This model's file is no longer on disk. Remove this setup or move the file back."));

  if (!isManaged && profile.commandArgv) {
    const commandArgv = await readCommandArgv(profile);
    console.log("\n" + renderSection("llama-server command", pc.dim(buildPrettyCommand({ ...profile, commandArgv })), { columns: 120 }));
  }
}

export function printGgufModelDetails(model, drafter) {
  const { caps, parts } = ggufDetailParts(model, drafter);
  parts.push(formatBytes(model.model.sizeBytes));
  console.log("\n" + renderSection("Downloaded model", renderRows([
    ["Name", pc.bold(model.label)],
    ["Status", pc.yellow("Needs one-time setup")],
    ["Details", parts.join(pc.dim(" · "))],
  ])));
  const detailRows = [
    ["Local file", model.path],
    ["Vision file", model.mmprojPath ?? "none"],
    ["Detected", capabilitySummary(caps)],
    ["Quant", model.quant ?? "unknown"],
  ];
  if (drafter) detailRows.push(["Drafter", drafter.path], ["Drafter size", formatBytes(drafter.sizeBytes)]);
  console.log("\n" + renderSection("Model details", renderRows(detailRows), { columns: 110 }));
}

export async function printMlxModelDetails(model) {
  const { detectMlxCapabilities } = await import("./mlx-discovery.mjs");
  const caps = await detectMlxCapabilities(model.filePath ?? model.path);
  const parts = [];
  if (caps.architecture) parts.push(caps.architecture);
  if (caps.thinking) parts.push("thinking");
  if (caps.vision) parts.push("vision");
  const summary = parts.length > 0 ? parts.join(pc.dim(" · ")) : "standard MLX";
  console.log("\n" + renderSection("Downloaded model", renderRows([
    ["Name", pc.bold(model.label)],
    ["Status", pc.yellow("Needs one-time setup")],
    ["Details", summary],
  ])));
  console.log("\n" + renderSection("Model details", renderRows([
    ["Model dir", model.path],
    ["Backend", "mlx-vlm"],
    ["Source", formatSourceLabel(model.source)],
    ["Detected", summary],
    ["Size", formatBytes(model.sizeBytes)],
    ["Context", caps.contextLength ? `${caps.contextLength.toLocaleString()} trained` : "unknown"],
  ]), { columns: 110 }));
}

export function printManagedModelDetails(model, backend) {
  console.log("\n" + renderSection(`${backend.label} model`, renderRows([
    ["Name", pc.bold(model.label)],
    ["Status", pc.green(`Local model via ${backend.label}`)],
    ["Model ID", pc.cyan(model.id)],
    ["Quant", model.quant ?? "unknown"],
    ["Family", model.family ?? "unknown"],
  ])));
}
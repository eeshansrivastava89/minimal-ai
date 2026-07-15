import { existsSync, statSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { stripVTControlCharacters } from "node:util";
import { backendFor } from "./backends.mjs";
import { computeServerCommand, buildStartScript, isProfileRunning } from "./process.mjs";
import { profileDir } from "./profiles.mjs";
import { pc, formatBytes, formatCtxLabel, renderSectionRows, padCol } from "./ui.mjs";
import { capabilitySummary, ggufDetailParts, isProfileFileMissing, profileDetailParts } from "./model-summary.mjs";
import { itemKey } from "./model-catalog.mjs";

const OPTION_SEPARATOR = "  ";
const OPTION_STATUS_WIDTH = 12;
const OPTION_BACKEND_WIDTH = 14;
const OPTION_SOURCE_WIDTH = 14;
const OPTION_QUANT_WIDTH = 10;
const OPTION_CTX_WIDTH = 5;

function optionStatusTag(kind) {
  const statuses = {
    running: ["RUNNING", pc.green],
    serverup: ["READY", pc.blue],
    ready: ["READY", pc.blue],
    missing: ["MISSING", pc.red],
    setup: ["NEEDS SETUP", pc.yellow],
  };
  const [text, color] = statuses[kind] ?? [kind, pc.dim];
  return padCol(text, OPTION_STATUS_WIDTH, color);
}

function optionSourceTag(sourceId) {
  const label = formatSourceLabel(sourceId);
  const colors = {
    huggingface: pc.cyan,
    lmstudio: pc.blue,
    omlx: pc.magenta,
    ollama: pc.blue,
    "llama.cpp": pc.cyan,
    gguf: pc.cyan,
  };
  return padCol(label, OPTION_SOURCE_WIDTH, colors[sourceId] ?? pc.dim);
}

function optionBackendTag(backendId) {
  const backend = backendId ? backendFor(backendId) : null;
  const label = backend?.label ?? backendId ?? "unknown";
  const colors = {
    "llama-cpp": pc.cyan,
    omlx: pc.magenta,
    ollama: pc.blue,
  };
  return padCol(label, OPTION_BACKEND_WIDTH, colors[backendId] ?? pc.dim);
}

export function formatSourceLabel(sourceId) {
  if (!sourceId) return "unknown";
  const map = {
    huggingface: "HuggingFace",
    lmstudio: "LM Studio",
    omlx: "oMLX",
    ollama: "Ollama",
    "llama.cpp": "llama.cpp",
    gguf: "GGUF file",
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

export function discoverySourceForItem(item) {
  if (item.type === "profile") return discoverySourceForProfile(item.profile);
  return item.model?.source ?? null;
}

function optionQuantLabel(item) {
  if (item.quant) return padCol(item.quant, OPTION_QUANT_WIDTH);
  return padCol("—", OPTION_QUANT_WIDTH);
}

function optionCtxLabel(item) {
  // Context window is a configured value — only profiles (READY/RUNNING)
  // have one. SETUP items (new/managed) show "—".
  if (item.type !== "profile") return padCol("—", OPTION_CTX_WIDTH);
  if (item.contextLength) {
    return padCol(formatCtxLabel(item.contextLength), OPTION_CTX_WIDTH);
  }
  return padCol("—", OPTION_CTX_WIDTH);
}

function optionSizeLabel(item) {
  if (item.type === "profile" && item.fileMissing) return "—";
  if (item.sizeBytes) return formatBytes(item.sizeBytes);
  return "—";
}

export function modelNameWidth(items) {
  const maxName = Math.max(...items.map((item) => {
    const base = stripVTControlCharacters(item.label ?? item.model?.label ?? item.profile?.label ?? "");
    // Setup items (new/managed) render "label · backendLabel" in the name
    // slot in compact mode — account for the suffix so columns align.
    if (item.type !== "profile") {
      const backendLabel = backendFor(inferBackendId(item))?.label ?? "";
      return base.length + 3 + backendLabel.length; // " · " = 3 chars
    }
    return base.length;
  }));
  return Math.max(20, maxName + 2);
}

function optionLabel({ status, backend, source, name, quant, ctx, size, nameWidth }) {
  return [status, backend, source, pc.bold(padCol(name, nameWidth)), quant, ctx, pc.dim(size)].join(OPTION_SEPARATOR);
}

export function modelSelectOption(item, { runningProfilesNow, modelMissingIds, nameWidth, compact = false }) {
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

    if (compact) {
      const indicator = status === "running" ? pc.green("●") : status === "missing" ? pc.red("✗") : pc.dim("○");
      return {
        value: itemKey(item),
        label: [indicator, pc.bold(padCol(item.label, nameWidth)), optionQuantLabel(item), optionCtxLabel(item), pc.dim(optionSizeLabel(item))].join(OPTION_SEPARATOR),
        ...(hint ? { description: pc.red(hint) } : {}),
      };
    }

    return {
      value: itemKey(item),
      label: optionLabel({
        status: optionStatusTag(status),
        backend: optionBackendTag(backendId),
        source: optionSourceTag(sourceId),
        name: item.label,
        nameWidth,
        quant: optionQuantLabel(item),
        ctx: optionCtxLabel(item),
        size: optionSizeLabel(item),
      }),
      ...(hint ? { hint: pc.red(hint) } : {}),
    };
  }

  // Setup item (new model or managed without profile)
  if (compact) {
    const backendLabel = backendFor(backendId)?.label ?? backendId;
    const full = `${item.label} · ${backendLabel}`;
    return {
      value: itemKey(item),
      label: [pc.yellow("○"), pc.yellow(pc.bold(padCol(full, nameWidth))), optionQuantLabel(item), optionCtxLabel(item), pc.dim(optionSizeLabel(item))].join(OPTION_SEPARATOR),
    };
  }

  return {
    value: itemKey(item),
    label: optionLabel({
      status: optionStatusTag("setup"),
      backend: optionBackendTag(backendId),
      source: optionSourceTag(sourceId),
      name: item.label,
      nameWidth,
      quant: optionQuantLabel(item),
      ctx: optionCtxLabel(item),
      size: optionSizeLabel(item),
    }),
  };
}

export function inferBackendId(item) {
  if (item.type === "profile") return item.profile.backend;
  if (item.type === "managed") return item.backendId;
  // new model: derive from format
  if (item.model?.backend) return item.model.backend;
  return "llama-cpp";
}

export async function printProfileDetails(profile) {
  const backend = backendFor(profile.backend);
  const isManaged = backend.type === "managed-server";
  const running = await isProfileRunning(profile);
  const fileMissing = !isManaged && isProfileFileMissing(profile);
  console.log("\n" + renderSectionRows("Model overview", [
    ["Name", pc.bold(profile.label)],
    ["Status", fileMissing ? pc.red("File missing") : running ? pc.green("Running now") : pc.blue("Ready")],
    ["Details", profileDetailParts(profile, { fileMissing }).join(pc.dim(" · "))],
    ["Server", fileMissing ? pc.red(profile.baseUrl) : profile.baseUrl],
  ]));

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
      ["Model size", profile.modelSizeBytes ? formatBytes(profile.modelSizeBytes) : (profile.modelPath && existsSync(profile.modelPath) && statSync(profile.modelPath).isFile() ? formatBytes(statSync(profile.modelPath).size) : "unknown")],
    );
    if (profile.drafterPath) {
      detailRows.push(["Drafter", existsSync(profile.drafterPath) ? profile.drafterPath : pc.red(`${profile.drafterPath} (not found)`)]);
    }
  }
  console.log("\n" + renderSectionRows("Model details", detailRows, { columns: Math.min(process.stdout.columns ?? 110, 140) }));

  if (fileMissing) console.log("\n" + pc.red("⚠ This model's file is no longer on disk. Remove this setup or move the file back."));

  if (!isManaged) {
    const command = await computeServerCommand(profile);
    if (command) {
      const script = buildStartScript(profile, command);
      const scriptPath = join(profileDir(profile.id), "start.sh");
      console.log("\n" + renderSectionRows("Server command", [
        ["Run manually", pc.cyan(`bash ${scriptPath}`)],
      ]));
      console.log("");
      console.log(pc.dim(script));
    }
  }
}

export function printGgufModelDetails(model, drafter) {
  const { caps, parts } = ggufDetailParts(model, drafter);
  parts.push(formatBytes(model.sizeBytes));
  console.log("\n" + renderSectionRows("Downloaded model", [
    ["Name", pc.bold(model.label)],
    ["Status", pc.yellow("Needs one-time setup")],
    ["Details", parts.join(pc.dim(" · "))],
  ]));
  const detailRows = [
    ["Local file", model.path],
    ["Vision file", model.mmprojPath ?? "none"],
    ["Detected", capabilitySummary(caps)],
    ["Quant", model.quant ?? "unknown"],
  ];
  if (drafter) detailRows.push(["Drafter", drafter.path], ["Drafter size", formatBytes(drafter.sizeBytes)]);
  console.log("\n" + renderSectionRows("Model details", detailRows, { columns: Math.min(process.stdout.columns ?? 110, 140) }));
}

export function printManagedModelDetails(model, backend) {
  console.log("\n" + renderSectionRows(`${backend.label} model`, [
    ["Name", pc.bold(model.label)],
    ["Status", pc.green(`Local model via ${backend.label}`)],
    ["Model ID", pc.cyan(model.id)],
    ["Quant", model.quant ?? "unknown"],
    ["Family", model.family ?? "unknown"],
  ]));
}
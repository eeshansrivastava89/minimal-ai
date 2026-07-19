import { existsSync, statSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { stripVTControlCharacters } from "node:util";
import { backendFor } from "./backends.mjs";
import { computeServerCommand, buildStartScript, isProfileRunning } from "./process.mjs";
import { profileDir } from "./profiles.mjs";
import { formatBytes, formatCtxLabel, card, renderList, padEndVisible, theme, status, icons } from "./ui.mjs";
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
    running: ["RUNNING", theme.success],
    serverup: ["READY", theme.brand],
    ready: ["READY", theme.brand],
    missing: ["MISSING", theme.error],
    setup: ["NEEDS SETUP", theme.warning],
  };
  const [text, color] = statuses[kind] ?? [kind, theme.subtle];
  return padEndVisible(color(text), OPTION_STATUS_WIDTH);
}

function optionSourceTag(sourceId) {
  const label = formatSourceLabel(sourceId);
  const colors = {
    huggingface: theme.brand,
    lmstudio: theme.accent,
    omlx: theme.accent,
    ollama: theme.brand,
    "llama.cpp": theme.brand,
    gguf: theme.brand,
  };
  return padEndVisible((colors[sourceId] ?? theme.subtle)(label), OPTION_SOURCE_WIDTH);
}

function optionBackendTag(backendId) {
  const backend = backendId ? backendFor(backendId) : null;
  const label = backend?.label ?? backendId ?? "unknown";
  const colors = {
    "llama-cpp": theme.brand,
    omlx: theme.accent,
    ollama: theme.brand,
  };
  return padEndVisible((colors[backendId] ?? theme.subtle)(label), OPTION_BACKEND_WIDTH);
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
  if (item.quant) return padEndVisible(item.quant, OPTION_QUANT_WIDTH);
  return padEndVisible("—", OPTION_QUANT_WIDTH);
}

function optionCtxLabel(item) {
  if (item.type !== "profile") return padEndVisible("—", OPTION_CTX_WIDTH);
  if (item.contextLength) return padEndVisible(formatCtxLabel(item.contextLength), OPTION_CTX_WIDTH);
  return padEndVisible("—", OPTION_CTX_WIDTH);
}

function optionSizeLabel(item) {
  if (item.type === "profile" && item.fileMissing) return "—";
  if (item.sizeBytes) return formatBytes(item.sizeBytes);
  return "—";
}

export function modelNameWidth(items) {
  const maxName = Math.max(...items.map((item) => {
    const base = stripVTControlCharacters(item.label ?? item.model?.label ?? item.profile?.label ?? "");
    if (item.type !== "profile") {
      const backendLabel = backendFor(inferBackendId(item))?.label ?? "";
      return base.length + 3 + backendLabel.length;
    }
    return base.length;
  }));
  return Math.max(20, maxName + 2);
}

function optionLabel({ status, backend, source, name, quant, ctx, size, nameWidth }) {
  return [status, backend, source, theme.bold(padEndVisible(name, nameWidth)), quant, ctx, theme.subtle(size)].join(OPTION_SEPARATOR);
}

export function modelSelectOption(item, { runningProfilesNow, modelMissingIds, nameWidth, compact = false }) {
  const sourceId = discoverySourceForItem(item) ?? "unknown";
  const backendId = inferBackendId(item);

  if (item.type === "profile") {
    const backend = backendFor(item.profile.backend);
    const running = runningProfilesNow.some((profile) => profile.id === item.profile.id);
    const modelMissing = !item.fileMissing && modelMissingIds?.has(item.profile.id);
    const statusTag = item.fileMissing || modelMissing ? "missing" : running ? "running" : "ready";
    const drafterMissing = Boolean(item.profile.drafterPath) && !existsSync(item.profile.drafterPath);
    const hint = drafterMissing ? "MTP drafter missing — reconfigure"
      : modelMissing ? `${backend.label} model no longer available`
      : undefined;

    if (compact) {
      const indicator = theme.subtle(icons.radioOff);
      const stateTag = statusTag === "running" ? theme.success("running") : statusTag === "missing" ? theme.error("missing") : "";
      return {
        value: itemKey(item),
        label: [indicator, theme.bold(padEndVisible(item.label, nameWidth)), optionQuantLabel(item), optionCtxLabel(item), theme.subtle(optionSizeLabel(item)), stateTag].join(OPTION_SEPARATOR),
        ...(hint ? { description: theme.error(hint) } : {}),
      };
    }

    return {
      value: itemKey(item),
      label: optionLabel({
        status: optionStatusTag(statusTag),
        backend: optionBackendTag(backendId),
        source: optionSourceTag(sourceId),
        name: item.label,
        nameWidth,
        quant: optionQuantLabel(item),
        ctx: optionCtxLabel(item),
        size: optionSizeLabel(item),
      }),
      ...(hint ? { hint: theme.error(hint) } : {}),
    };
  }

  if (compact) {
    const backendLabel = backendFor(backendId)?.label ?? backendId;
    const full = `${item.label} · ${backendLabel}`;
    return {
      value: itemKey(item),
      label: [theme.warning(icons.radioOff), theme.warning(theme.bold(padEndVisible(full, nameWidth))), optionQuantLabel(item), optionCtxLabel(item), theme.subtle(optionSizeLabel(item))].join(OPTION_SEPARATOR),
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
  if (item.model?.backend) return item.model.backend;
  return "llama-cpp";
}

export async function printProfileDetails(profile) {
  const backend = backendFor(profile.backend);
  const isManaged = backend.type === "managed-server";
  const running = await isProfileRunning(profile);
  const fileMissing = !isManaged && isProfileFileMissing(profile);
  const stateLabel = fileMissing ? status({ kind: "error", message: "File missing" }) : running ? status({ kind: "success", message: "Running now" }) : status({ kind: "info", message: "Ready" });

  console.log("\n" + card({ title: "Model overview", body: renderList([
    ["Name", theme.bold(profile.label)],
    ["Status", stateLabel],
    ["Details", profileDetailParts(profile, { fileMissing }).join(theme.subtle(" · "))],
    ["Server", fileMissing ? status({ kind: "error", message: profile.baseUrl }) : profile.baseUrl],
  ]) }));

  const detailRows = [
    ["Setup ID", profile.id],
    ["Runs with", backend.label],
    ["Model alias", profile.modelAlias],
    ...(profile.capabilities ? [["Detected", capabilitySummary(profile.capabilities)]] : []),
  ];
  if (!isManaged) {
    detailRows.push(
      ["Local file", fileMissing ? status({ kind: "error", message: `${profile.modelPath} (not found)` }) : profile.modelPath ?? "unknown"],
      ["Vision file", profile.mmprojPath ? (existsSync(profile.mmprojPath) ? profile.mmprojPath : status({ kind: "error", message: `${profile.mmprojPath} (not found)` })) : "none"],
      ["Model size", profile.modelSizeBytes ? formatBytes(profile.modelSizeBytes) : (profile.modelPath && existsSync(profile.modelPath) && statSync(profile.modelPath).isFile() ? formatBytes(statSync(profile.modelPath).size) : "unknown")],
    );
    if (profile.drafterPath) {
      detailRows.push(["Drafter", existsSync(profile.drafterPath) ? profile.drafterPath : status({ kind: "error", message: `${profile.drafterPath} (not found)` })]);
    }
  }
  console.log("\n" + card({ title: "Model details", body: renderList(detailRows) }));

  if (fileMissing) console.log("\n" + status({ kind: "warning", message: "This model's file is no longer on disk. Remove this setup or move the file back." }));

  if (!isManaged) {
    const command = await computeServerCommand(profile);
    if (command) {
      const script = buildStartScript(profile, command);
      const scriptPath = join(profileDir(profile.id), "start.sh");
      console.log("\n" + card({ title: "Server command", body: renderList([
        ["Run manually", theme.brand(`bash ${scriptPath}`)],
      ]) }));
      console.log("");
      console.log(theme.subtle(script));
    }
  }
}

export function printGgufModelDetails(model, drafter) {
  const { caps, parts } = ggufDetailParts(model, drafter);
  parts.push(formatBytes(model.sizeBytes));
  console.log("\n" + card({ title: "Downloaded model", body: renderList([
    ["Name", theme.bold(model.label)],
    ["Status", status({ kind: "warning", message: "Needs one-time setup" })],
    ["Details", parts.join(theme.subtle(" · "))],
  ]) }));

  const detailRows = [
    ["Local file", model.path],
    ["Vision file", model.mmprojPath ?? "none"],
    ["Detected", capabilitySummary(caps)],
    ["Quant", model.quant ?? "unknown"],
  ];
  if (drafter) detailRows.push(["Drafter", drafter.path], ["Drafter size", formatBytes(drafter.sizeBytes)]);
  console.log("\n" + card({ title: "Model details", body: renderList(detailRows) }));
}

export function printManagedModelDetails(model, backend) {
  console.log("\n" + card({ title: `${backend.label} model`, body: renderList([
    ["Name", theme.bold(model.label)],
    ["Status", status({ kind: "success", message: `Local model via ${backend.label}` })],
    ["Model ID", theme.brand(model.id)],
    ["Quant", model.quant ?? "unknown"],
    ["Family", model.family ?? "unknown"],
  ]) }));
}

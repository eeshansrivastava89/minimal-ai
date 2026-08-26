import { existsSync, statSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { stripVTControlCharacters } from "node:util";
import { backendFor } from "./backends.mjs";
import { computeServerCommand, buildStartScript, isProfileRunning } from "./process.mjs";
import { profileDir } from "./profiles.mjs";
import { formatBytes, formatCtxLabel, renderList, padEndVisible, theme, status, maxWidth } from "./ui.mjs";
import { capabilitySummary, ggufDetailParts, isProfileFileMissing, profileDetailParts } from "./model-summary.mjs";
import { itemKey } from "./model-catalog.mjs";

const OPTION_SEPARATOR = "  ";
const OPTION_QUANT_WIDTH = 10;
const OPTION_CTX_WIDTH = 5;

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
  if (item.contextLength) return padEndVisible(formatCtxLabel(item.contextLength), OPTION_CTX_WIDTH);
  return padEndVisible("—", OPTION_CTX_WIDTH);
}

function optionSizeLabel(item) {
  if (item.type === "profile" && item.fileMissing) return "—";
  if (item.sizeBytes) return formatBytes(item.sizeBytes);
  return "—";
}

// A picker row is name + quant(10) + ctx(5) + size(~9) + state(7) +
// 4 separators(8) ≈ nameWidth + 39. Cap the name column at the terminal
// width, or long HF names overflow and Clack wraps mid-row.
const ROW_OVERHEAD = OPTION_QUANT_WIDTH + OPTION_CTX_WIDTH + 9 + 7 + 4 * OPTION_SEPARATOR.length;

export function modelNameWidth(items) {
  const maxName = Math.max(...items.map((item) => {
    const base = stripVTControlCharacters(item.label ?? item.model?.label ?? item.profile?.label ?? "");
    if (item.type !== "profile") {
      const backendLabel = backendFor(inferBackendId(item))?.label ?? "";
      return base.length + 3 + backendLabel.length;
    }
    return base.length;
  }));
  return Math.min(Math.max(20, maxName + 2), Math.max(20, maxWidth() - ROW_OVERHEAD));
}

/** Clip to a visible width, ending with an ellipsis when cut. */
function clip(str, width) {
  if (stripVTControlCharacters(str).length <= width) return str;
  return `${stripVTControlCharacters(str).slice(0, Math.max(1, width - 1))}…`;
}

export function modelSelectOption(item, { runningProfilesNow, modelMissingIds, nameWidth }) {
  if (item.type === "profile") {
    const running = runningProfilesNow.some((profile) => profile.id === item.profile.id);
    const modelMissing = !item.fileMissing && modelMissingIds?.has(item.profile.id);
    const statusTag = item.fileMissing || modelMissing ? "missing" : running ? "running" : "ready";
    const backend = backendFor(item.profile.backend);
    const drafterMissing = Boolean(item.profile.drafterPath) && !existsSync(item.profile.drafterPath);
    const hint = drafterMissing ? "MTP drafter missing — reconfigure"
      : modelMissing ? `${backend.label} model no longer available`
      : undefined;

    const stateTag = statusTag === "running" ? theme.success("running")
      : statusTag === "missing" ? theme.error("missing")
      : "";
    return {
      value: itemKey(item),
      label: [
        theme.bold(padEndVisible(clip(item.label, nameWidth), nameWidth)),
        optionQuantLabel(item),
        optionCtxLabel(item),
        theme.subtle(optionSizeLabel(item)),
        stateTag,
      ].filter((part) => part !== "").join(OPTION_SEPARATOR),
      ...(hint ? { description: theme.error(hint) } : {}),
    };
  }

  const backendLabel = backendFor(inferBackendId(item))?.label;
  const full = backendLabel ? `${item.label} · ${backendLabel}` : item.label;
  return {
    value: itemKey(item),
    label: [
      theme.warning(theme.bold(padEndVisible(clip(full, nameWidth), nameWidth))),
      optionQuantLabel(item),
      optionCtxLabel(item),
      theme.subtle(optionSizeLabel(item)),
    ].join(OPTION_SEPARATOR),
  };
}

export function inferBackendId(item) {
  if (item.type === "profile") return item.profile.backend;
  if (item.type === "managed") return item.backendId;
  if (item.model?.backend) return item.model.backend;
  return "llama-cpp";
}

// ── Details screens ─────────────────────────────────────────────────────────
//
// One layout for all three kinds: a bold name line carrying the status,
// then a single renderList. No boxes.

export async function printProfileDetails(profile) {
  const backend = backendFor(profile.backend);
  const isManaged = backend.type === "managed-server";
  const running = await isProfileRunning(profile);
  const fileMissing = !isManaged && isProfileFileMissing(profile);
  const stateLabel = fileMissing ? status({ kind: "error", message: "File missing" }) : running ? status({ kind: "success", message: "Running now" }) : status({ kind: "info", message: "Ready" });

  const rows = [
    ["Backend", backend.label],
    ["Details", profileDetailParts(profile, { fileMissing }).join(theme.subtle(" · "))],
    ["Server", fileMissing ? status({ kind: "error", message: profile.baseUrl }) : profile.baseUrl],
    ["Setup ID", profile.id],
    ["Model alias", profile.modelAlias],
    ...(profile.capabilities ? [["Detected", capabilitySummary(profile.capabilities)]] : []),
  ];
  if (!isManaged) {
    rows.push(
      ["Local file", fileMissing ? status({ kind: "error", message: `${profile.modelPath} (not found)` }) : profile.modelPath ?? "unknown"],
      ["Vision file", profile.mmprojPath ? (existsSync(profile.mmprojPath) ? profile.mmprojPath : status({ kind: "error", message: `${profile.mmprojPath} (not found)` })) : "none"],
      ["Model size", profile.modelSizeBytes ? formatBytes(profile.modelSizeBytes) : (profile.modelPath && existsSync(profile.modelPath) && statSync(profile.modelPath).isFile() ? formatBytes(statSync(profile.modelPath).size) : "unknown")],
    );
    if (profile.drafterPath) {
      rows.push(["Drafter", existsSync(profile.drafterPath) ? profile.drafterPath : status({ kind: "error", message: `${profile.drafterPath} (not found)` })]);
    }
  }

  console.log();
  console.log(`${theme.bold(profile.label)}  ${stateLabel}`);
  console.log(renderList(rows));

  if (fileMissing) console.log("\n" + status({ kind: "warning", message: "This model's file is no longer on disk. Remove this setup or move the file back." }));

  if (!isManaged) {
    const command = await computeServerCommand(profile);
    if (command) {
      const script = buildStartScript(profile, command);
      const scriptPath = join(profileDir(profile.id), "start.sh");
      console.log();
      console.log(renderList([["Run manually", theme.brand(`bash ${scriptPath}`)]]));
      console.log(theme.subtle(script));
    }
  }
}

export function printGgufModelDetails(model, drafter) {
  const { caps, parts } = ggufDetailParts(model, drafter);
  parts.push(formatBytes(model.sizeBytes));

  const rows = [
    ["Details", parts.join(theme.subtle(" · "))],
    ["Local file", model.path],
    ["Vision file", model.mmprojPath ?? "none"],
    ["Detected", capabilitySummary(caps)],
    ["Quant", model.quant ?? "unknown"],
  ];
  if (drafter) rows.push(["Drafter", drafter.path], ["Drafter size", formatBytes(drafter.sizeBytes)]);

  console.log();
  console.log(`${theme.bold(model.label)}  ${status({ kind: "warning", message: "Needs one-time setup" })}`);
  console.log(renderList(rows));
}

export function printManagedModelDetails(model, backend) {
  console.log();
  console.log(`${theme.bold(model.label)}  ${status({ kind: "success", message: `Local model via ${backend.label}` })}`);
  console.log(renderList([
    ["Model ID", theme.brand(model.id)],
    ["Quant", model.quant ?? "unknown"],
    ["Family", model.family ?? "unknown"],
  ]));
}

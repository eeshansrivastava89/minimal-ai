import { existsSync, statSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { backendFor } from "./backends.mjs";
import { computeServerCommand, buildStartScript, isProfileRunning } from "./process.mjs";
import { profileDir } from "./profiles.mjs";
import { formatBytes, formatCtxLabel, renderList, padEndVisible, theme, status, visibleLen, promptContentWidth } from "./ui.mjs";
import { capabilitySpecs, ggufDetailParts, isProfileFileMissing, profileDetailParts } from "./model-summary.mjs";
import { itemKey } from "./model-catalog.mjs";

// ── Picker rows ────────────────────────────────────────────────────────────
// Row = name + optional metadata columns + optional state tag. Rules:
// - The name is never truncated — it IS the model's identity. If a window is
//   narrower than the name, Clack wraps the row; we never cut it with "…".
// - When the full row doesn't fit, metadata columns shed in shedRank order
//   (the Details action always has the complete picture).
// - Every width below is measured from content; the only fixed geometry is
//   the separator and Clack's frame gutter (promptContentWidth from the kit).
const SEP = "  ";

const OPTIONAL_COLUMNS = [
  { id: "quant", shedRank: 2, cell: (row) => row.quant, render: (cell, width) => padEndVisible(cell, width) },
  { id: "ctx", shedRank: 0, cell: (row) => row.ctx, render: (cell, width) => padEndVisible(cell, width) },
  { id: "size", shedRank: 1, cell: (row) => row.size, render: (cell, width) => theme.subtle(padEndVisible(cell, width)) },
];

function pickerRowData(item, { runningProfilesNow, modelMissingIds }) {
  const row = {
    item,
    key: itemKey(item),
    name: item.label ?? item.model?.label ?? item.profile?.label ?? "",
    accent: item.type === "profile" ? "bold" : "warning",
    quant: item.quant ?? "—",
    ctx: item.contextLength != null ? formatCtxLabel(item.contextLength) : "—",
    size: item.type === "profile" && item.fileMissing ? "—" : (item.sizeBytes ? formatBytes(item.sizeBytes) : "—"),
    state: "",
    hint: undefined,
  };
  if (item.type !== "profile") return row;
  const profile = item.profile;
  const running = runningProfilesNow.some((p) => p.id === profile.id);
  const serverGone = !item.fileMissing && Boolean(modelMissingIds?.has(profile.id));
  const drafterGone = Boolean(profile.drafterPath) && !existsSync(profile.drafterPath);
  if (item.fileMissing || serverGone) row.state = "missing";
  else if (running) row.state = "running";
  if (drafterGone) row.hint = "MTP drafter missing — reconfigure";
  else if (serverGone) row.hint = `${backendFor(profile.backend).label} model no longer available`;
  return row;
}

/** Choose which metadata columns fit: shed lowest-priority columns until
 *  every row (name + columns + state + hint) fits the prompt frame. */
function fitRowLayout(rows, budget) {
  const nameW = Math.max(...rows.map((r) => visibleLen(r.name)));
  const stateW = Math.max(0, ...rows.map((r) => r.state.length));
  const widths = new Map(OPTIONAL_COLUMNS.map((c) => [c.id, Math.max(...rows.map((r) => visibleLen(c.cell(r))))]));
  const visible = new Set(OPTIONAL_COLUMNS.map((c) => c.id));
  const rowWidth = (r) =>
    nameW
    + [...visible].reduce((sum, id) => sum + SEP.length + widths.get(id), 0)
    + (stateW ? SEP.length + stateW : 0)
    + (r.hint ? SEP.length + visibleLen(r.hint) : 0);
  for (const col of [...OPTIONAL_COLUMNS].sort((a, b) => a.shedRank - b.shedRank)) {
    if (rows.every((r) => rowWidth(r) <= budget)) break;
    visible.delete(col.id);
  }
  return { nameW, stateW, widths, visible };
}

function renderPickerRow(row, layout) {
  const name = row.accent === "warning"
    ? theme.warning(theme.bold(padEndVisible(row.name, layout.nameW)))
    : theme.bold(padEndVisible(row.name, layout.nameW));
  const cells = [name];
  for (const col of OPTIONAL_COLUMNS) {
    if (!layout.visible.has(col.id)) continue;
    cells.push(col.render(col.cell(row), layout.widths.get(col.id)));
  }
  if (row.state === "running") cells.push(theme.success(padEndVisible(row.state, layout.stateW)));
  if (row.state === "missing") cells.push(theme.error(padEndVisible(row.state, layout.stateW)));
  return cells.join(SEP);
}

/** Build picker options for every item in one pass: the column layout is
 *  computed once from all items so rows share alignment (A7-style DRY —
 *  callers used to thread nameWidth through every call). Returns a Map of
 *  itemKey → { value, label, description? } ready for promptSelectModel. */
export function modelRowOptions(items, { runningProfilesNow = [], modelMissingIds } = {}) {
  const rows = items.map((item) => pickerRowData(item, { runningProfilesNow, modelMissingIds }));
  if (rows.length === 0) return new Map();
  const layout = fitRowLayout(rows, promptContentWidth());
  return new Map(rows.map((row) => [row.key, {
    value: row.key,
    label: renderPickerRow(row, layout),
    ...(row.hint ? { description: theme.error(row.hint) } : {}),
  }]));
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
    ...(profile.capabilities ? [["Detected", capabilitySpecs(profile.capabilities)]] : []),
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
    ["Detected", capabilitySpecs(caps)],
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

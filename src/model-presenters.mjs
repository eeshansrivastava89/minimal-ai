import { existsSync, statSync } from "node:fs";
import { BACKENDS, backendFor } from "./backends.mjs";
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
    ready: ["READY", pc.blue],
    missing: ["MISSING", pc.red],
    setup: ["SETUP", pc.yellow],
  };
  const [text, color] = statuses[kind] ?? [kind, pc.dim];
  return optionPad(text, color, OPTION_STATUS_WIDTH);
}

function optionSourceTag(sourceId, label) {
  const colors = {
    "llama-cpp": pc.cyan,
    "llama-cpp-mtp": pc.blue,
    ollama: pc.green,
    omlx: pc.magenta,
    gguf: pc.cyan,
  };
  return optionPad(label, colors[sourceId] ?? pc.dim, OPTION_SOURCE_WIDTH);
}

function optionCtxLabel(item) {
  if (item.type === "profile" && item.profile.flags?.ctxSize) {
    return optionPad(`${(item.profile.flags.ctxSize / 1000).toFixed(0)}k`, null, OPTION_CTX_WIDTH);
  }
  return optionPad("—", null, OPTION_CTX_WIDTH);
}

function optionSizeLabel(item) {
  if (item.type === "profile") {
    if (item.fileMissing) return "—";
    if (item.profile.modelPath && existsSync(item.profile.modelPath)) {
      return formatBytes(statSync(item.profile.modelPath).size);
    }
    return "—";
  }
  if (item.type === "new") {
    return formatBytes(item.model.sizeBytes);
  }
  // managed
  if (item.model.quant) return item.model.quant;
  if (item.model.sizeBytes) return formatBytes(item.model.sizeBytes);
  return "—";
}

export function modelNameWidth(items) {
  const maxName = Math.max(...items.map((item) =>
    stripVTControlCharacters(item.label ?? item.model?.label ?? item.profile?.label ?? "").length,
  ));
  return Math.max(20, maxName + 2);
}

function optionLabel({ status, source, name, ctx, size, nameWidth }) {
  return [status, source, pc.bold(optionPad(name, null, nameWidth)), ctx, pc.dim(size)].join(OPTION_SEPARATOR);
}

export function modelSelectOption(item, { runningProfilesNow, nameWidth }) {
  if (item.type === "profile") {
    const backend = backendFor(item.profile.backend);
    const running = runningProfilesNow.some((profile) => profile.id === item.profile.id);
    return {
      value: itemKey(item),
      label: optionLabel({
        status: optionStatusTag(item.fileMissing ? "missing" : running ? "running" : "ready"),
        source: optionSourceTag(item.profile.backend, backend.label),
        name: item.profile.label,
        nameWidth,
        ctx: optionCtxLabel(item),
        size: optionSizeLabel(item),
      }),
    };
  }
  if (item.type === "new") {
    return {
      value: itemKey(item),
      label: optionLabel({
        status: optionStatusTag("setup"),
        source: optionSourceTag("gguf", "GGUF file"),
        name: item.model.label,
        nameWidth,
        ctx: optionCtxLabel(item),
        size: optionSizeLabel(item),
      }),
    };
  }
  const backend = BACKENDS[item.backendId];
  return {
    value: itemKey(item),
    label: optionLabel({
      status: optionStatusTag("setup"),
      source: optionSourceTag(item.backendId, backend.label),
      name: item.model.label,
      nameWidth,
      ctx: optionCtxLabel(item),
      size: optionSizeLabel(item),
    }),
  };
}

export function printWorkspaceHeader(normalized, runningProfilesNow) {
  const profiles = normalized.profiles;
  const readyCount = profiles.filter((p) => !isProfileFileMissing(p) && !runningProfilesNow.some((r) => r.id === p.id)).length;
  const runningCount = runningProfilesNow.length;
  const missingCount = profiles.filter((p) => isProfileFileMissing(p)).length;
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

export function printManagedModelDetails(model, backend) {
  console.log("\n" + renderSection(`${backend.label} model`, renderRows([
    ["Name", pc.bold(model.label)],
    ["Status", pc.green(`Local model via ${backend.label}`)],
    ["Model ID", pc.cyan(model.id)],
    ["Quant", model.quant ?? "unknown"],
    ["Family", model.family ?? "unknown"],
  ])));
}
import { existsSync, statSync } from "node:fs";
import { BACKENDS, backendFor } from "./backends.mjs";
import { readCommandArgv } from "./profiles.mjs";
import { isProfileRunning } from "./process.mjs";
import { detectCapabilities } from "./autodetect.mjs";
import { buildPrettyCommand } from "./command.mjs";
import { pc, formatBytes, renderRows, renderSection, renderCard } from "./ui.mjs";
import { capabilitySummary, ggufDetailParts, ggufMtpLabel, isProfileFileMissing, profileDetailParts, profileMtpLabel } from "./model-summary.mjs";
import { itemKey } from "./model-catalog.mjs";

const OPTION_SEPARATOR = pc.dim("  │  ");
const OPTION_STATUS_WIDTH = 12;
const OPTION_SOURCE_WIDTH = 14;

function optionTag(text, color, width) {
  const padded = String(text).padEnd(width);
  return color ? color(padded) : padded;
}

function optionStatusTag(kind) {
  const statuses = {
    running: ["RUNNING", pc.green],
    ready: ["READY", pc.green],
    missing: ["FILE MISSING", pc.red],
    setup: ["NEEDS SETUP", pc.yellow],
  };
  const [text, color] = statuses[kind] ?? [kind, pc.dim];
  return optionTag(text, color, OPTION_STATUS_WIDTH);
}

function optionSourceTag(sourceId, label) {
  const colors = {
    "llama-cpp": pc.cyan,
    "llama-cpp-mtp": pc.blue,
    ollama: pc.green,
    omlx: pc.magenta,
    gguf: pc.cyan,
  };
  return optionTag(label, colors[sourceId] ?? pc.dim, OPTION_SOURCE_WIDTH);
}

function optionLabel({ status, source, name, details = [] }) {
  return [status, source, pc.bold(name), ...details].filter(Boolean).join(OPTION_SEPARATOR);
}

export function modelSelectOption(item, { runningProfilesNow }) {
  if (item.type === "profile") {
    const backend = backendFor(item.profile.backend);
    const running = runningProfilesNow.some((profile) => profile.id === item.profile.id);
    return {
      value: itemKey(item),
      label: optionLabel({
        status: optionStatusTag(item.fileMissing ? "missing" : running ? "running" : "ready"),
        source: optionSourceTag(item.profile.backend, backend.label),
        name: item.profile.label,
      }),
    };
  }
  if (item.type === "new") {
    return {
      value: itemKey(item),
      label: optionLabel({ status: optionStatusTag("setup"), source: optionSourceTag("gguf", "GGUF file"), name: item.model.label }),
    };
  }
  const backend = BACKENDS[item.backendId];
  return {
    value: itemKey(item),
    label: optionLabel({ status: optionStatusTag("setup"), source: optionSourceTag(item.backendId, backend.label), name: item.model.label }),
  };
}

export function printModelCards(items, { runningProfilesNow, drafters }) {
  const profiles = items.filter((item) => item.type === "profile");
  const newModels = items.filter((item) => item.type === "new");
  const managed = items.filter((item) => item.type === "managed");

  if (profiles.length > 0) {
    console.log("\n" + pc.bold("Ready to chat"));
    for (const item of profiles) {
      const { profile } = item;
      const backend = backendFor(profile.backend);
      const running = runningProfilesNow.some((runningProfile) => runningProfile.id === profile.id);
      const status = item.fileMissing ? pc.red("File missing") : running ? pc.green("Running now") : "Ready";
      const border = item.fileMissing ? pc.red : running ? pc.green : pc.dim;
      const detailParts = [item.fileMissing ? pc.red("File not found") : profileDetailParts(profile, { drafters }).filter(Boolean)[0]];
      const mtpLabel = profileMtpLabel(profile, drafters);
      if (mtpLabel) detailParts.push(mtpLabel);
      const ctxLabel = profile.flags?.ctxSize ? `${(profile.flags.ctxSize / 1000).toFixed(0)}k ctx` : null;
      if (ctxLabel) detailParts.push(ctxLabel);
      console.log(renderCard(profile.label, renderRows([
        ["Status", status],
        ["Details", detailParts.join(pc.dim(" · "))],
        ["Runs with", backend.label],
      ]), { formatBorder: border }));
    }
  }

  if (newModels.length > 0) {
    console.log("\n" + pc.bold("Needs setup"));
    for (const item of newModels) {
      const caps = detectCapabilities(item.model.path, item.model.mmprojPath);
      const detailParts = [capabilitySummary(caps)];
      const mtpLabel = ggufMtpLabel(item.model, item.drafter);
      if (mtpLabel) detailParts.push(mtpLabel);
      detailParts.push(formatBytes(item.model.sizeBytes));
      console.log(renderCard(item.model.label, renderRows([
        ["Status", pc.yellow("Needs setup")],
        ["Details", detailParts.join(pc.dim(" · "))],
      ]), { formatBorder: pc.yellow }));
    }
  }

  for (const backendId of ["ollama", "omlx"]) {
    const managedForBackend = managed.filter((item) => item.backendId === backendId);
    if (managedForBackend.length === 0) continue;
    const backend = BACKENDS[backendId];
    console.log("\n" + pc.bold(`Via ${backend.label}`));
    for (const item of managedForBackend) {
      console.log(renderCard(item.model.label, renderRows([
        ["Details", [item.model.id, item.model.quant].filter(Boolean).join(pc.dim(" · "))],
      ]), { formatBorder: pc.dim }));
    }
  }
}

export async function printProfileDetails(profile) {
  const backend = backendFor(profile.backend);
  const isManaged = backend.type === "managed-server";
  const running = await isProfileRunning(profile);
  const fileMissing = !isManaged && isProfileFileMissing(profile);
  console.log("\n" + renderSection("Model overview", renderRows([
    ["Name", pc.bold(profile.label)],
    ["Status", fileMissing ? pc.red("File missing") : running ? pc.green("Running now") : "Ready"],
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
  parts.push(formatBytes(model.sizeBytes));
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

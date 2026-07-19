import { ensureDirs, omlxEnabled } from "../config.mjs";
import { backendFor } from "../backends.mjs";
import { loadProfiles, effectiveModelId } from "../profiles.mjs";
import { profileRuntimeStatus } from "../process.mjs";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { execFileAsync } from "../exec.mjs";
import { card, renderList, status, theme } from "../ui.mjs";

export async function statusCommand() {
  await ensureDirs();
  const profiles = await loadProfiles();
  const statuses = [];
  for (const profile of profiles) {
    statuses.push({ profile, status: await profileRuntimeStatus(profile) });
  }

  const running = statuses.filter((item) => item.status.running);
  const managedUpMissing = statuses.filter((item) => {
    const backend = backendFor(item.profile.backend);
    return backend.type === "managed-server" && item.status.serverUp && !item.status.modelAvailable;
  });
  const managedUpNotLoaded = statuses.filter((item) => {
    const backend = backendFor(item.profile.backend);
    return backend.type === "managed-server" && item.status.serverUp && item.status.modelAvailable && !item.status.modelLoaded;
  });

  const summaryRows = [
    ["Running now", running.length > 0 ? status({ kind: "success", message: `${running.length} model${running.length === 1 ? "" : "s"}` }) : theme.subtle("none")],
    ["Ready setups", profiles.length > 0 ? String(profiles.length) : theme.subtle("none")],
  ];

  if (managedUpMissing.length > 0) {
    summaryRows.push(["Server up, model missing", status({ kind: "warning", message: String(managedUpMissing.length) })]);
  }
  if (managedUpNotLoaded.length > 0) {
    summaryRows.push(["Server up, model not loaded", status({ kind: "warning", message: String(managedUpNotLoaded.length) })]);
  }

  summaryRows.push(["Next step", profiles.length > 0 ? "Run offgrid-ai to start chatting" : status({ kind: "warning", message: "Run offgrid-ai to set up a model" })]);

  console.log(card({ title: "Status", body: renderList(summaryRows) }));

  if (await omlxEnabled()) {
    const omlxCacheDir = join(homedir(), ".omlx", "cache");
    if (existsSync(omlxCacheDir)) {
      try {
        const { stdout: duOutput } = await execFileAsync("du", ["-sh", omlxCacheDir], { encoding: "utf8" });
        const cacheSize = duOutput.split(/\s+/)[0];
        console.log("");
        console.log(card({ title: "oMLX cache", body: renderList([
          ["Location", theme.subtle(omlxCacheDir)],
          ["Disk usage", theme.bold(cacheSize)],
        ]) }));
      } catch (err) {
        console.log(theme.subtle(`  (disk usage unavailable: ${err.message})`));
      }
    }
  }

  if (managedUpMissing.length > 0 || managedUpNotLoaded.length > 0) {
    const detailRows = [];
    for (const { profile, status: s } of [...managedUpMissing, ...managedUpNotLoaded]) {
      const backend = backendFor(profile.backend);
      const modelId = effectiveModelId(profile);
      const state = s.modelAvailable
        ? status({ kind: "warning", message: "server up · model not loaded" })
        : status({ kind: "error", message: "server up · model missing" });
      detailRows.push([`${profile.label} (${modelId})`, state]);
      detailRows.push(["Server", `${backend.label} at ${profile.baseUrl}`]);
    }
    console.log("");
    console.log(card({ title: "Managed servers", body: renderList(detailRows) }));
  }

  if (running.length === 0) return;

  console.log("");
  console.log(card({ title: "Running", body: renderList([["Stop", "offgrid-ai stop"]]) }));
  for (const { profile, status: s } of running) {
    const backend = backendFor(profile.backend);
    console.log("");
    console.log(card({ title: profile.label, body: renderList([
      ["Status", s.ready ? status({ kind: "success", message: "Ready" }) : status({ kind: "warning", message: "Starting up" })],
      ["Runs with", backend.label],
      ["Process", `pid ${s.pid}`],
      ["Server", profile.baseUrl],
    ]) }));
  }
  console.log("");
}

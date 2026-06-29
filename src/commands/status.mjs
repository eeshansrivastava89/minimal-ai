import { ensureDirs } from "../config.mjs";
import { backendFor } from "../backends.mjs";
import { loadProfiles } from "../profiles.mjs";
import { profileRuntimeStatus } from "../process.mjs";
import { pc, renderRows, renderCard } from "../ui.mjs";

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
    ["Running now", running.length > 0 ? pc.green(`${running.length} model${running.length === 1 ? "" : "s"}`) : pc.dim("none")],
    ["Ready setups", profiles.length > 0 ? String(profiles.length) : pc.dim("none")],
  ];

  if (managedUpMissing.length > 0) {
    summaryRows.push(["Server up, model missing", pc.yellow(String(managedUpMissing.length))]);
  }
  if (managedUpNotLoaded.length > 0) {
    summaryRows.push(["Server up, model not loaded", pc.yellow(String(managedUpNotLoaded.length))]);
  }

  summaryRows.push(["Next step", profiles.length > 0 ? "Run offgrid-ai to start chatting" : pc.yellow("Run offgrid-ai to set up a model")]);

  console.log(renderCard("Status", renderRows(summaryRows), { formatBorder: running.length > 0 ? pc.green : pc.dim }));

  if (managedUpMissing.length > 0 || managedUpNotLoaded.length > 0) {
    const detailRows = [];
    for (const { profile, status } of [...managedUpMissing, ...managedUpNotLoaded]) {
      const backend = backendFor(profile.backend);
      const modelId = profile.omlxModel ?? profile.modelAlias ?? profile.id;
      const state = status.modelAvailable
        ? pc.yellow("server up · model not loaded")
        : pc.red("server up · model missing");
      detailRows.push([`${profile.label} (${modelId})`, state]);
      detailRows.push(["Server", `${backend.label} at ${profile.baseUrl}`]);
    }
    console.log("\n" + renderCard("Managed servers", renderRows(detailRows), { formatBorder: pc.yellow }));
  }

  if (running.length === 0) return;

  console.log("\n" + renderCard("Running", renderRows([
    ["Stop", "offgrid-ai stop"],
  ]), { formatBorder: pc.green }));
  for (const { profile, status } of running) {
    const backend = backendFor(profile.backend);
    console.log("\n" + renderCard(profile.label, renderRows([
      ["Status", status.ready ? pc.green("Ready") : pc.yellow("Starting up")],
      ["Runs with", backend.label],
      ["Process", `pid ${status.pid}`],
      ["Server", profile.baseUrl],
    ]), { formatBorder: status.ready ? pc.green : pc.yellow }));
  }
}

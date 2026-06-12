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
  if (running.length === 0) {
    console.log(renderCard("Status", renderRows([
      ["Running now", pc.dim("none")],
      ["Ready setups", profiles.length > 0 ? String(profiles.length) : pc.dim("none")],
      ["Next step", profiles.length > 0 ? "Run offgrid-ai to start chatting" : pc.yellow("Run offgrid-ai to set up a model")],
    ]), { formatBorder: pc.dim }));
    return;
  }

  console.log(renderCard("Status", renderRows([
    ["Running now", pc.green(`${running.length} model${running.length === 1 ? "" : "s"}`)],
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

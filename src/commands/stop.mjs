import { ensureDirs } from "../config.mjs";
import { readProfile, loadProfiles } from "../profiles.mjs";
import { stopProfile, profileRuntimeStatus } from "../process.mjs";
import { pc, startInteractive, createPrompt, parseOptions } from "../ui.mjs";

export async function stopCommand(argv) {
  await ensureDirs();
  const { positional, options } = parseOptions(argv);

  if (options.all) return stopAll();
  if (positional[0]) return stopOne(positional[0]);

  const running = await runningProfiles();
  if (running.length === 0) {
    console.log(pc.dim("No offgrid-ai servers are running."));
    return;
  }

  if (!process.stdin.isTTY) {
    for (const { profile, status } of running) console.log(`  ${pc.green("●")} ${pc.bold(profile.label)} · pid ${status.pid}`);
    console.log(pc.dim("Stop with: offgrid-ai stop <id>"));
    return;
  }

  startInteractive("offgrid-ai stop");
  const prompt = createPrompt();
  try {
    const choices = running.map(({ profile, status }) => ({ value: profile.id, label: profile.label, hint: `pid ${status.pid} · ${profile.baseUrl}` }));
    if (running.length > 1) choices.unshift({ value: "__all", label: "Stop all", hint: `${running.length} servers` });
    choices.push({ value: "__cancel", label: "Cancel" });

    const selected = await prompt.choice("Stop", choices, choices[0].value);
    if (selected === "__cancel") return;

    const targets = selected === "__all" ? running : running.filter((item) => item.profile.id === selected);
    for (const { profile } of targets) await printStopResult(profile);
  } finally {
    prompt.close();
  }
}

export async function stopOne(id) {
  await printStopResult(await readProfile(id));
}

export async function stopAll() {
  const running = await runningProfiles();
  if (running.length === 0) {
    console.log(pc.dim("No offgrid-ai servers are running."));
    return;
  }
  for (const { profile } of running) await printStopResult(profile);
}

export async function runningProfiles() {
  const profiles = await loadProfiles();
  const statuses = await Promise.all(profiles.map(async (profile) => ({ profile, status: await profileRuntimeStatus(profile) })));
  return statuses.filter((item) => item.status.running);
}

async function printStopResult(profile) {
  const result = await stopProfile(profile);
  console.log(result.stopped ? pc.green(result.message) : pc.yellow(result.message));
}

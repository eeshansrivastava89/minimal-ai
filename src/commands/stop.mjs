import { ensureDirs } from "../config.mjs";
import { readProfile, loadProfiles } from "../profiles.mjs";
import { stopProfile, profileRuntimeStatus } from "../process.mjs";
import { startInteractive, promptChoice, parseOptions, status, theme } from "../ui.mjs";

export async function stopCommand(argv) {
  await ensureDirs();
  const { positional, options } = parseOptions(argv);

  if (options.all) return stopAll();
  if (positional[0]) return stopOne(positional[0]);

  const running = await runningProfiles();
  if (running.length === 0) {
    console.log(theme.subtle("No offgrid-ai servers are running."));
    return;
  }

  if (!process.stdin.isTTY) {
    for (const { profile, status: s } of running) console.log(`  ${status({ kind: "success", message: "" })} ${theme.bold(profile.label)} · pid ${s.pid}`);
    console.log(theme.subtle("Stop with: offgrid-ai stop <id>"));
    return;
  }

  startInteractive("offgrid-ai stop");
  const choices = running.map(({ profile, status: s }) => ({ value: profile.id, label: profile.label, hint: `pid ${s.pid} · ${profile.baseUrl}` }));
  if (running.length > 1) choices.unshift({ value: "__all", label: "Stop all", hint: `${running.length} servers` });
  choices.push({ value: "__cancel", label: "Cancel" });

  const selected = await promptChoice({ message: "Stop", choices, defaultValue: choices[0].value });
  if (!selected || selected === "__cancel") return;

  const targets = selected === "__all" ? running : running.filter((item) => item.profile.id === selected);
  for (const { profile } of targets) await printStopResult(profile);
  console.log("");
}

async function stopOne(id) {
  await printStopResult(await readProfile(id));
}

async function stopAll() {
  const running = await runningProfiles();
  if (running.length === 0) {
    console.log(theme.subtle("No offgrid-ai servers are running."));
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
  console.log(result.stopped ? status({ kind: "success", message: result.message }) : status({ kind: "warning", message: result.message }));
}

// ── Benchmark repo linking ────────────────────────────────────────────────────

import { existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { homedir } from "node:os";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { loadConfig, saveConfig } from "../config.mjs";
import { pc } from "../ui.mjs";

const execFileAsync = promisify(execFile);

const BENCHMARK_REPO = "https://github.com/eeshansrivastava89/local-llm-visual-benchmark.git";

export async function findBenchmarkRepo() {
  const config = await loadConfig();
  if (config.benchmarkRepoPath && existsSync(join(config.benchmarkRepoPath, "benchmarks"))) {
    return config.benchmarkRepoPath;
  }
  return null;
}

export async function linkBenchmarkRepo(prompt) {
  const existing = await findBenchmarkRepo();
  if (existing) return existing;

  const candidates = [
    join(homedir(), "dev", "local-llm-visual-benchmark"),
    join(homedir(), "projects", "local-llm-visual-benchmark"),
    join(homedir(), "local-llm-visual-benchmark"),
  ];
  for (const candidate of candidates) {
    if (existsSync(join(candidate, "benchmarks"))) {
      const config = await loadConfig();
      config.benchmarkRepoPath = candidate;
      await saveConfig(config);
      return candidate;
    }
  }

  console.log(pc.dim("\nThe benchmark gallery needs to be linked to offgrid-ai."));
  console.log(pc.dim("This is the local-llm-visual-benchmark repo that stores prompts and run results.\n"));

  const choice = await prompt.choice("Link benchmark gallery", [
    { value: "clone", label: "Clone from GitHub", hint: "git clone into ~/dev" },
    { value: "manual", label: "Enter path manually", hint: "If you already have it cloned" },
  ], "clone");

  if (choice === "clone") {
    const targetDir = join(homedir(), "dev", "local-llm-visual-benchmark");
    console.log(pc.dim(`\nCloning ${BENCHMARK_REPO}...`));
    try {
      await execFileAsync("git", ["clone", BENCHMARK_REPO, targetDir], { stdio: "pipe" });
      const config = await loadConfig();
      config.benchmarkRepoPath = targetDir;
      await saveConfig(config);
      console.log(pc.green(`✓ Cloned to ${targetDir}`));
      return targetDir;
    } catch (err) {
      console.log(pc.red(`Clone failed: ${err.message}`));
      return null;
    }
  }

  const path = await prompt.text("Path to local-llm-visual-benchmark", "");
  if (!path) return null;
  const resolved = resolve(path.replace(/^~/, homedir()));
  if (!existsSync(join(resolved, "benchmarks"))) {
    console.log(pc.red(`No benchmarks/ directory found at ${resolved}`));
    return null;
  }
  const config = await loadConfig();
  config.benchmarkRepoPath = resolved;
  await saveConfig(config);
  console.log(pc.green(`✓ Linked to ${resolved}`));
  return resolved;
}
import { spawn } from "node:child_process";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

export const execFileAsync = promisify(execFile);

export function runCommand(cmd, args, { label = cmd, verbose = false } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { stdio: verbose ? "inherit" : ["ignore", "pipe", "pipe"] });
    let stderr = "";
    if (!verbose) child.stderr?.on("data", (data) => { stderr += data; });
    child.on("close", (code) => {
      if (code === 0) resolve();
      else reject(new Error(lastStderrLines(stderr) || `${label} exited with code ${code}`));
    });
    child.on("error", reject);
  });
}

export async function commandExists(name) {
  try {
    await execFileAsync("which", [name]);
    return true;
  } catch {
    return false;
  }
}

function lastStderrLines(stderr) {
  return String(stderr).split("\n").filter((line) => line.trim()).slice(-3).join("\n");
}

export function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

import { spawn } from "node:child_process";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { stat } from "node:fs/promises";
import { delimiter, join } from "node:path";

export const execFileAsync = promisify(execFile);

export function execCommand(cmd, args, { label = cmd, verbose = false, timeout = 0 } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { stdio: verbose ? "inherit" : ["ignore", "pipe", "pipe"] });
    let stderr = "";
    if (!verbose) child.stderr?.on("data", (data) => { stderr += data; });
    let timer = null;
    if (timeout > 0) {
      timer = setTimeout(() => {
        try { child.kill("SIGTERM"); } catch { /* already exited */ }
        reject(new Error(`${label} timed out after ${Math.round(timeout / 1000)}s`));
      }, timeout);
    }
    const clearTimer = () => { if (timer) clearTimeout(timer); };
    child.on("close", (code) => {
      clearTimer();
      if (code === 0) resolve();
      else reject(new Error(lastStderrLines(stderr) || `${label} exited with code ${code}`));
    });
    child.on("error", (err) => { clearTimer(); reject(err); });
  });
}

export async function commandExists(name) {
  // Portable PATH walk — `which` is not POSIX and absent on some minimal
  // Linux containers (L6). Resolves an executable file (not a directory)
  // with any execute bit set.
  const check = async (p) => {
    try {
      const s = await stat(p);
      return s.isFile() && (s.mode & 0o111) !== 0;
    } catch {
      return false;
    }
  };
  if (name.includes("/")) return check(name);
  const path = process.env.PATH ?? "";
  for (const dir of path.split(delimiter)) {
    if (!dir) continue;
    if (await check(join(dir, name))) return true;
  }
  return false;
}

function lastStderrLines(stderr) {
  return String(stderr).split("\n").filter((line) => line.trim()).slice(-3).join("\n");
}

export function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

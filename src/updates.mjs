import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const PACKAGE_NAME = "offgrid-ai";

export async function checkForUpdate({ fetchImpl = globalThis.fetch } = {}) {
  if (process.env.OFFGRID_NO_UPDATE_CHECK) return null;

  const currentVersion = currentPackageVersion();

  try {
    const response = await fetchImpl(`https://registry.npmjs.org/${PACKAGE_NAME}/latest`, {
      signal: AbortSignal.timeout(3000),
    });
    if (!response.ok) return null;
    const body = await response.json();
    const latestVersion = typeof body?.version === "string" ? body.version : null;
    if (!latestVersion) return null;

    return updateResult(currentVersion, latestVersion);
  } catch {
    return null;
  }
}

export function currentPackageVersion() {
  const pkgPath = fileURLToPath(new URL("../package.json", import.meta.url));
  const pkg = JSON.parse(readFileSync(pkgPath, "utf-8"));
  return pkg.version;
}

export function isNewerVersion(candidate, current) {
  return compareVersions(candidate, current) > 0;
}

export function compareVersions(a, b) {
  const left = versionParts(a);
  const right = versionParts(b);
  const len = Math.max(left.length, right.length);
  for (let i = 0; i < len; i++) {
    const diff = (left[i] ?? 0) - (right[i] ?? 0);
    if (diff !== 0) return diff;
  }
  return 0;
}

export function detectInvocation(env = process.env) {
  const execPath = env.npm_execpath ?? "";
  if (/(^|[\\/])npx-cli\.js$/u.test(execPath)) return "npx";
  if (env.npm_command === "exec") return "npx";
  return "global";
}

export function updateCommand(invocation = detectInvocation(), argv = []) {
  // `npx offgrid-ai update` would re-invoke `offgrid-ai update` under npx,
  // detect npx again, and recurse forever. Fall back to a global install
  // so the user gets the latest version installed globally instead.
  const isUpdate = argv[0] === "update";
  if (invocation === "npx" && !isUpdate) {
    const args = ["exec", "--yes", "--", `${PACKAGE_NAME}@latest`, ...argv];
    return {
      cmd: "npm",
      args,
      display: shellCommand("npm", args),
      mode: "run-latest",
    };
  }

  const args = ["install", "-g", `${PACKAGE_NAME}@latest`];
  return {
    cmd: "npm",
    args,
    display: shellCommand("npm", args),
    mode: "install-global",
  };
}

function updateResult(currentVersion, latestVersion) {
  return isNewerVersion(latestVersion, currentVersion)
    ? { current: currentVersion, latest: latestVersion }
    : null;
}

function versionParts(value) {
  return String(value)
    .replace(/^v/u, "")
    .split(/[.-]/u)
    .map((part) => Number.parseInt(part, 10))
    .filter((part) => Number.isFinite(part));
}

function shellCommand(cmd, args) {
  return [cmd, ...args.map(shellQuote)].join(" ");
}

function shellQuote(value) {
  const text = String(value);
  return /^[A-Za-z0-9_./:@=-]+$/u.test(text) ? text : JSON.stringify(text);
}

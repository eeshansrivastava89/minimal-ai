#!/usr/bin/env node
import { existsSync, readFileSync, appendFileSync } from "node:fs";
import { mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

if (process.env.CI || process.env.OFFGRID_SKIP_POSTINSTALL) process.exit(0);

// npm v9+ sets npm_config_global="true" for global installs. Some contexts (Hermes,
// older npm, or wrapped installs) may not set it, so also check the prefix.
const isGlobalInstall = process.env.npm_config_global === "true" || isLikelyGlobalPrefix(process.env.npm_config_prefix, process.env.HOME);
if (!isGlobalInstall) process.exit(0);

const prefix = process.env.npm_config_prefix;
if (!prefix) {
  console.log("offgrid-ai postinstall: npm global prefix not detected; skipping PATH update.");
  process.exit(0);
}

if (isHermesPrefix(prefix, process.env.HOME)) {
  console.log("offgrid-ai installed with a Hermes-managed npm prefix.");
  console.log("Not adding Hermes Node to PATH automatically. Use your normal Node/npm, or run the offgrid-ai install script.");
  process.exit(0);
}

const npmBin = join(prefix, "bin");
const marker = "# Added by offgrid-ai installer";
const pathLine = `export PATH="${npmBin}:$PATH"`;

const home = process.env.HOME;
if (!home) {
  console.log("offgrid-ai postinstall: HOME not set; cannot update shell PATH.");
  process.exit(0);
}

// Detect target shell config file. Prefer the file matching the user's shell.
const shell = process.env.SHELL ?? "";
const isZsh = /\bzsh$/u.test(shell);
const isBash = /\bbash$/u.test(shell);

let rcCandidates;
if (isZsh) {
  rcCandidates = [".zshrc", ".zprofile", ".profile"];
} else if (isBash) {
  rcCandidates = [".bashrc", ".bash_profile", ".profile"];
} else {
  // Fallback: try common files, prefer existing ones
  rcCandidates = [".bashrc", ".bash_profile", ".zshrc", ".zprofile", ".profile"];
}

const rcPaths = rcCandidates.map((name) => join(home, name));
let rcFile = rcPaths.find((file) => existsSync(file));
if (!rcFile) {
  // No existing rc file: create the one matching the user's shell.
  const defaultName = isZsh ? ".zshrc" : isBash ? ".bashrc" : ".bashrc";
  rcFile = join(home, defaultName);
}

let content = "";
try {
  content = existsSync(rcFile) ? readFileSync(rcFile, "utf8") : "";
} catch (err) {
  console.log(`offgrid-ai postinstall: could not read ${rcFile}: ${err.message}`);
  process.exit(0);
}

if (!content.includes(npmBin)) {
  try {
    mkdirSync(dirname(rcFile), { recursive: true });
    appendFileSync(rcFile, `${content.endsWith("\n") || content.length === 0 ? "" : "\n"}\n${marker}\n${pathLine}\n`, "utf8");
    const version = currentPackageVersion();
    console.log("");
    console.log(`offgrid-ai v${version} installed and added to PATH`);
    console.log(`  Config file: ${rcFile}`);
    console.log(`  Bin path:    ${npmBin}`);
    console.log("");
    console.log("To use it right now in this terminal, run:");
    console.log(`  source ${rcFile}`);
    console.log("");
    console.log("Or open a new terminal window/tab.");
  } catch (err) {
    console.log(`offgrid-ai postinstall: could not write to ${rcFile}: ${err.message}`);
  }
} else {
  console.log(`offgrid-ai is installed in ${npmBin}`);
  console.log(`Open a new terminal if the command is not found yet.`);
}

if (process.getuid?.() === 0) {
  console.log("Warning: offgrid-ai was installed as root. PATH was added to root's shell config, not the regular user's.");
  console.log("If you installed with sudo, run the installer as your normal user instead, or manually add the line above to your user's shell config.");
}

function currentPackageVersion() {
  try {
    const pkg = JSON.parse(readFileSync(join(dirname(fileURLToPath(import.meta.url)), "..", "package.json"), "utf8"));
    return pkg.version;
  } catch {
    return "";
  }
}

function isHermesPrefix(prefix, home) {
  const normalized = prefix.replace(/\\/gu, "/");
  if (normalized.includes("/.hermes/")) return true;
  return Boolean(home && normalized === `${home.replace(/\\/gu, "/")}/.hermes/node`);
}

function isLikelyGlobalPrefix(prefix, home) {
  if (!prefix || !home) return false;
  const normalized = prefix.replace(/\\/gu, "/");
  const homeNormalized = home.replace(/\\/gu, "/");
  // Common global prefixes: /usr/local, /opt/homebrew, nvm paths, ~/.npm-global, ~/.local
  return normalized.startsWith("/usr/") ||
    normalized.startsWith("/opt/") ||
    normalized.startsWith(homeNormalized) ||
    /\/versions\/node\/v?\d/u.test(normalized);
}

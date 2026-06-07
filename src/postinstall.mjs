#!/usr/bin/env node
import { existsSync, readFileSync, appendFileSync } from "node:fs";
import { join } from "node:path";

if (process.env.CI || process.env.OFFGRID_SKIP_POSTINSTALL) process.exit(0);
if (process.env.npm_config_global !== "true") process.exit(0);

const prefix = process.env.npm_config_prefix;
if (!prefix) process.exit(0);

const npmBin = join(prefix, "bin");
const marker = "# Added by offgrid-ai installer";
const pathLine = `export PATH="${npmBin}:$PATH"`;
const currentPath = process.env.PATH ?? "";

if (currentPath.split(":").includes(npmBin)) process.exit(0);

const home = process.env.HOME;
if (!home) process.exit(0);

const shell = process.env.SHELL ?? "";
const rcCandidates = shell.endsWith("zsh")
  ? [join(home, ".zshrc"), join(home, ".zprofile"), join(home, ".profile")]
  : [join(home, ".bashrc"), join(home, ".bash_profile"), join(home, ".profile"), join(home, ".zshrc")];

const rcFile = rcCandidates.find((file) => existsSync(file)) ?? rcCandidates[0];
let content = "";
try {
  content = existsSync(rcFile) ? readFileSync(rcFile, "utf8") : "";
} catch {
  process.exit(0);
}

if (!content.includes(npmBin)) {
  appendFileSync(rcFile, `${content.endsWith("\n") || content.length === 0 ? "" : "\n"}\n${marker}\n${pathLine}\n`, "utf8");
  console.log(`offgrid-ai added ${npmBin} to ${rcFile}`);
  console.log(`Open a new terminal, or run: source ${rcFile}`);
} else {
  console.log(`offgrid-ai is installed in ${npmBin}`);
  console.log(`Open a new terminal if the command is not found yet.`);
}

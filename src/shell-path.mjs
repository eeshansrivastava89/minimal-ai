import { existsSync } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";

export const INSTALLER_PATH_MARKER = "# Added by offgrid-ai installer";

export function defaultShellConfigFiles(home = homedir()) {
  return [`${home}/.zshrc`, `${home}/.bashrc`, `${home}/.bash_profile`];
}

export function removeInstallerPathBlock(content) {
  const lines = content.split("\n");
  const kept = [];
  let changed = false;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const next = lines[i + 1];

    if (line.trim() === "" && next?.trim() === INSTALLER_PATH_MARKER) {
      changed = true;
      continue;
    }

    if (line.trim() === INSTALLER_PATH_MARKER) {
      changed = true;
      const following = lines[i + 1]?.trim() ?? "";
      if (/^export\s+PATH=".+:\$PATH"$/u.test(following)) i += 1;
      continue;
    }

    kept.push(line);
  }

  return {
    changed,
    content: kept.join("\n").replace(/\n{3,}/gu, "\n\n").replace(/\s+$/u, "") + "\n",
  };
}

export async function removeInstallerPathEntries(rcFiles = defaultShellConfigFiles()) {
  const cleaned = [];
  for (const rcFile of rcFiles) {
    if (!existsSync(rcFile)) continue;
    let content;
    try {
      content = await readFile(rcFile, "utf8");
    } catch {
      continue;
    }

    const result = removeInstallerPathBlock(content);
    if (!result.changed) continue;
    await writeFile(rcFile, result.content, "utf8");
    cleaned.push(rcFile);
  }
  return cleaned;
}

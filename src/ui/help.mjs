import { Help } from "commander";
import { maxWidth, visibleLen, padEndVisible, wrapText, sectionLine } from "./layout.mjs";
import { theme } from "./theme.mjs";

function renderRows(rows, width) {
  const nameWidth = Math.max(...rows.map(([name]) => visibleLen(name))) + 2;
  const descWidth = Math.max(1, width - nameWidth - 2);
  return rows.map(([name, desc]) => {
    const nameCol = padEndVisible(`  ${name}`, nameWidth + 2);
    const descLines = wrapText(desc, descWidth);
    return [nameCol + descLines[0], ...descLines.slice(1).map((l) => " ".repeat(nameWidth + 2) + l)].join("\n");
  }).join("\n");
}

export class FangHelp extends Help {
  prepareContext(contextOptions) {
    super.prepareContext(contextOptions);
    if (this.helpWidth > maxWidth()) this.helpWidth = maxWidth();
  }

  formatHelp(cmd) {
    const width = this.helpWidth ?? maxWidth();
    const lines = [];

    lines.push("");
    lines.push(`  ${theme.bold(theme.brand(cmd.name()))}`);
    if (cmd.description()) {
      lines.push(`  ${theme.subtle(cmd.description())}`);
    }

    const usage = this.commandUsage(cmd);
    if (usage) {
      lines.push("");
      lines.push(`  ${theme.bold(theme.accent(sectionLine("USAGE", width)))}`);
      lines.push(usage.split("\n").map((line) => `    ${theme.brand(line)}`).join("\n"));
    }

    const commands = this.visibleCommands(cmd).filter((c) => c.name() !== "help");
    if (commands.length > 0) {
      lines.push("");
      lines.push(`  ${theme.bold(theme.accent(sectionLine("COMMANDS", width)))}`);
      const rows = commands.map((c) => [theme.bold(c.name()), this.commandDescription(c)]);
      lines.push(renderRows(rows, width));
    }

    const options = this.visibleOptions(cmd);
    if (options.length > 0) {
      lines.push("");
      lines.push(`  ${theme.bold(theme.accent(sectionLine("FLAGS", width)))}`);
      const rows = options.map((o) => [theme.brand(o.flags), this.optionDescription(o)]);
      lines.push(renderRows(rows, width));
    }

    const args = this.visibleArguments(cmd);
    if (args.length > 0) {
      lines.push("");
      lines.push(`  ${theme.bold(theme.accent(sectionLine("ARGUMENTS", width)))}`);
      const rows = args.map((a) => [a.name(), a.description]);
      lines.push(renderRows(rows, width));
    }

    if (cmd.long) {
      lines.push("");
      lines.push(`  ${theme.bold(theme.accent(sectionLine("DESCRIPTION", width)))}`);
      lines.push(wrapText(cmd.long, width - 2).map((l) => `  ${l}`).join("\n"));
    }

    if (cmd.examples && cmd.examples.length > 0) {
      lines.push("");
      lines.push(`  ${theme.bold(theme.accent(sectionLine("EXAMPLES", width)))}`);
      lines.push(cmd.examples.join("\n").split("\n").map((line) => `    ${theme.brand(line)}`).join("\n"));
    }

    lines.push("");
    return lines.join("\n");
  }
}

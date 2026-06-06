import { cancel, confirm, intro, isCancel, select, text } from "@clack/prompts";
import pc from "picocolors";

export { pc };
export { pc as colors };

export function formatBytes(bytes) {
  if (!Number.isFinite(bytes)) return "unknown";
  const units = ["B", "KB", "MB", "GB", "TB"];
  let size = bytes;
  let unit = 0;
  while (size >= 1024 && unit < units.length - 1) { size /= 1024; unit += 1; }
  return `${size.toFixed(unit === 0 ? 0 : 2)} ${units[unit]}`;
}

export function startInteractive(title = "offgrid-ai") {
  if (process.stdin.isTTY) console.clear();
  intro(title);
}

export function createPrompt() {
  return {
    async text(label, defaultValue) {
      const value = await text({ message: label, initialValue: defaultValue === undefined ? undefined : String(defaultValue) });
      return handleCancel(value)?.trim() || String(defaultValue ?? "");
    },
    async number(label, defaultValue, min, max) {
      const value = await text({
        message: label, initialValue: String(defaultValue),
        validate(input) { const n = Number(input); if (!Number.isFinite(n) || n < min || n > max) return `Enter a number from ${min} to ${max}.`; },
      });
      return Number(handleCancel(value));
    },
    async yesNo(label, defaultValue) {
      return handleCancel(await confirm({ message: label, initialValue: defaultValue }));
    },
    async choice(label, choices, defaultValue) {
      return handleCancel(await select({
        message: label, initialValue: defaultValue,
        options: choices.map((c) => ({ value: c.value, label: c.label ?? c.value, hint: c.hint })),
      }));
    },
    close() {},
  };
}

function handleCancel(value) {
  if (isCancel(value)) { cancel("Cancelled."); process.exit(0); }
  return value;
}

export function renderRows(rows) {
  const width = Math.max(...rows.map(([key]) => pc.strip(String(key)).length));
  return rows.map(([key, value]) => {
    const visible = pc.strip(String(key)).length;
    return `${key}${" ".repeat(Math.max(1, width - visible + 2))}${value}`;
  }).join("\n");
}

export function renderSection(title, body) {
  return `${pc.magenta("◆")} ${pc.bold(title)}\n${body}`;
}

export function parseOptions(argv) {
  const positional = [];
  const options = {};
  for (let i = 0; i < argv.length; i++) {
    const item = argv[i];
    if (item.startsWith("--")) {
      const key = item.slice(2);
      const next = argv[i + 1];
      if (next && !next.startsWith("--")) { options[key] = next; i += 1; }
      else options[key] = true;
    } else {
      positional.push(item);
    }
  }
  return { positional, options };
}
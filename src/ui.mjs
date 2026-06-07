import { box, cancel, confirm, intro, isCancel, select, text } from "@clack/prompts";
import pc from "picocolors";
import { stripVTControlCharacters } from "node:util";

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
  if (rows.length === 0) return "";
  const width = Math.max(...rows.map(([key]) => stripVTControlCharacters(String(key)).length));
  return rows.map(([key, value]) => {
    const visible = stripVTControlCharacters(String(key)).length;
    return `${key}${" ".repeat(Math.max(1, width - visible + 2))}${value}`;
  }).join("\n");
}

export function renderCard(title, body, options = {}) {
  let output = "";
  box(String(body ?? ""), title, {
    output: captureOutput((chunk) => { output += chunk; }, options.columns),
    withGuide: false,
    width: "auto",
    contentPadding: options.contentPadding ?? 1,
    titlePadding: options.titlePadding ?? 1,
    rounded: options.rounded ?? true,
    titleAlign: options.titleAlign ?? "left",
    contentAlign: options.contentAlign ?? "left",
    formatBorder: options.formatBorder ?? pc.magenta,
  });
  return output.trimEnd();
}

export function renderSection(title, body) {
  return renderCard(title, body, { formatBorder: pc.magenta });
}

export function humanCapabilitySummary(caps = {}) {
  const parts = [];
  if (caps.thinking) parts.push(pc.magenta("Reasoning"));
  if (caps.vision) parts.push(pc.cyan("Vision"));
  if (caps.mtp) parts.push(pc.blue("MTP"));
  if (caps.qat) parts.push(pc.green("QAT"));
  return parts.length > 0 ? parts.join(" · ") : "General chat";
}

export function statusText(kind, text) {
  const color = {
    ready: pc.green,
    running: pc.green,
    warning: pc.yellow,
    info: pc.cyan,
    muted: pc.dim,
  }[kind] ?? ((value) => value);
  return color(text);
}

function captureOutput(write, columns) {
  return {
    columns: Math.min(columns ?? process.stdout.columns ?? 88, 100),
    write,
  };
}

export function parseOptions(argv) {
  const positional = [];
  const options = {};
  for (let i = 0; i < argv.length; i++) {
    const item = argv[i];
    if (item === "--") {
      positional.push(...argv.slice(i + 1));
      break;
    }
    if (item.startsWith("--")) {
      const [key, inlineValue] = item.slice(2).split(/=(.*)/u, 2);
      const next = argv[i + 1];
      if (inlineValue !== undefined) options[key] = inlineValue;
      else if (next && !next.startsWith("-")) { options[key] = next; i += 1; }
      else options[key] = true;
    } else if (/^-[A-Za-z]+$/u.test(item)) {
      for (const key of item.slice(1)) options[key] = true;
    } else {
      positional.push(item);
    }
  }
  return { positional, options };
}

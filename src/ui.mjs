import { select as inquirerSelect, input, confirm, number, Separator } from "@inquirer/prompts";
import pc from "picocolors";
import { stripVTControlCharacters } from "node:util";

export { pc };
export { Separator };

// ── Formatting helpers (no prompt dependency) ───────────────────────────────

export function formatBytes(bytes) {
  if (!Number.isFinite(bytes)) return "unknown";
  const units = ["B", "KB", "MB", "GB", "TB"];
  let size = bytes;
  let unit = 0;
  while (size >= 1024 && unit < units.length - 1) { size /= 1024; unit += 1; }
  return `${size.toFixed(unit === 0 ? 0 : 2)} ${units[unit]}`;
}

export function renderRows(rows) {
  if (rows.length === 0) return "";
  const width = Math.max(...rows.map(([key]) => stripVTControlCharacters(String(key)).length));
  return rows.map(([key, value]) => {
    const visible = stripVTControlCharacters(String(key)).length;
    return `${key}${" ".repeat(Math.max(1, width - visible + 2))}${value}`;
  }).join("\n");
}

// ── Box renderer ────────────────────────────────────────────────────────────

function visibleLen(text) {
  return stripVTControlCharacters(String(text)).length;
}

function padVisible(text, width) {
  const pad = Math.max(0, width - visibleLen(text));
  return text + " ".repeat(pad);
}

export function renderCard(title, body, options = {}) {
  const borderColor = options.formatBorder ?? pc.magenta;
  const maxCols = options.columns ?? process.stdout.columns ?? 88;
  const lines = String(body ?? "").split("\n");
  const titleStr = title ? ` ${title} ` : "";
  const innerWidth = Math.max(
    visibleLen(titleStr),
    ...lines.map(visibleLen),
  );
  const width = Math.min(innerWidth + 2, maxCols - 2);

  const topTitle = title ? `╭${pc.reset(titleStr)}` : "╭";
  const topFill = "─".repeat(Math.max(0, width + 2 - visibleLen(titleStr)));
  const top = `${topTitle}${topFill}╮`;

  const middle = lines.map((line) => `│ ${padVisible(line, width)} │`);

  const bottom = `╰${"─".repeat(width + 2)}╯`;

  return [top, ...middle, bottom].map((l) => borderColor(l)).join("\n");
}

export function renderSection(title, body, options = {}) {
  return renderCard(title, body, { formatBorder: pc.magenta, ...options });
}

// ── Status / capability helpers ─────────────────────────────────────────────

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

// ── Interactive prompt factory ──────────────────────────────────────────────

export function startInteractive(title = "offgrid-ai") {
  if (process.stdin.isTTY) console.clear();
  console.log(pc.magenta(`◆ ${title}`));
}

export function createPrompt() {
  return {
    async text(label, defaultValue) {
      const value = await input({
        message: label,
        default: defaultValue === undefined ? undefined : String(defaultValue),
      });
      return value?.trim() || String(defaultValue ?? "");
    },

    async number(label, defaultValue, min, max) {
      const value = await number({
        message: label,
        default: defaultValue,
        validate(input) {
          if (!Number.isFinite(input) || input < min || input > max) {
            return `Enter a number from ${min} to ${max}.`;
          }
        },
      });
      return Number(value);
    },

    async yesNo(label, defaultValue) {
      return await confirm({ message: label, default: defaultValue });
    },

    async choice(label, choices, defaultValue) {
      const mapped = choices.map((c) => {
        if (c instanceof Separator) return c;
        return {
          value: c.value,
          name: c.label ?? c.value,
          description: c.hint,
          disabled: c.disabled || undefined,
        };
      });
      return await inquirerSelect({
        message: label,
        default: defaultValue,
        choices: mapped,
        pageSize: 20,
      });
    },

    close() {},
  };
}

// ── Model picker with grouped select ────────────────────────────────────────

export async function modelSelect(label, groups, { defaultKey, pageSize = 20 } = {}) {
  const choices = [];
  for (const group of groups) {
    if (group.separator) {
      choices.push(new Separator(group.separator));
    }
    for (const item of group.items) {
      if (item.separator) {
        choices.push(new Separator(item.separator));
        continue;
      }
      choices.push({
        value: item.value,
        name: item.label ?? item.value,
        description: item.description,
        disabled: item.disabled || undefined,
      });
    }
  }
  return await inquirerSelect({
    message: label,
    default: defaultKey,
    choices,
    pageSize,
  });
}

// ── Option parsing (no prompt dependency) ────────────────────────────────────

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
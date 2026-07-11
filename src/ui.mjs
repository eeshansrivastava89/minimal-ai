import { select as inquirerSelect, input, confirm, number, Separator } from "@inquirer/prompts";
import pc from "picocolors";
import { stripVTControlCharacters } from "node:util";

export { pc };
export { Separator };

// ── Formatting helpers (no prompt dependency) ───────────────────────────────

/** Pad text to a visible column width (min 1 space). Optional color applied before padding. */
export function padCol(text, width, color) {
  const visible = stripVTControlCharacters(String(text)).length;
  const str = color ? color(String(text)) : String(text);
  return str + " ".repeat(Math.max(1, width - visible));
}

export function formatBytes(bytes) {
  if (!Number.isFinite(bytes)) return "unknown";
  const units = ["B", "KB", "MB", "GB", "TB"];
  let size = bytes;
  let unit = 0;
  while (size >= 1024 && unit < units.length - 1) { size /= 1024; unit += 1; }
  return `${size.toFixed(unit === 0 ? 0 : 2)} ${units[unit]}`;
}

export function renderRows(rows, { wrapWidth } = {}) {
  if (rows.length === 0) return "";
  const width = Math.max(...rows.map(([key]) => stripVTControlCharacters(String(key)).length));
  return rows.map(([key, value]) => {
    const visible = stripVTControlCharacters(String(key)).length;
    const indent = " ".repeat(Math.max(1, width - visible + 2));
    const valStr = String(value ?? "");
    // If wrapWidth is set and the full line exceeds it, wrap the value
    if (wrapWidth) {
      const prefix = `${key}${indent}`;
      const prefixLen = stripVTControlCharacters(prefix).length;
      const availWidth = wrapWidth - prefixLen;
      if (stripVTControlCharacters(valStr).length > availWidth) {
        const lines = wrapText(valStr, availWidth);
        return [prefix + lines[0], ...lines.slice(1).map((l) => " ".repeat(prefixLen) + l)].join("\n");
      }
    }
    return `${key}${indent}${valStr}`;
  }).join("\n");
}

function wrapText(text, width) {
  const words = String(text).split(/(\s+)/u);
  const lines = [];
  let current = "";
  for (let word of words) {
    // Hard-break long unbreakable strings (file paths, etc.)
    while (stripVTControlCharacters(word).length > width) {
      if (current.trim()) { lines.push(current.trimEnd()); current = ""; }
      lines.push(word.slice(0, width));
      word = word.slice(width);
    }
    if (stripVTControlCharacters(current + word).length > width && current.trim()) {
      lines.push(current.trimEnd());
      current = word.trimStart();
    } else {
      current += word;
    }
  }
  if (current.trim()) lines.push(current.trimEnd());
  return lines.length > 0 ? lines : [text];
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
  const rawLines = String(body ?? "").split("\n");
  const titleStr = title ? ` ${title} ` : "";

  // Calculate content width: max of title, all lines, capped by maxCols
  const innerWidth = Math.max(
    visibleLen(titleStr),
    ...rawLines.map(visibleLen),
  );
  const contentWidth = Math.min(innerWidth, maxCols - 4); // 4 = borders + padding
  const width = contentWidth + 2; // inner content area

  // Wrap lines that exceed contentWidth
  const lines = [];
  for (const line of rawLines) {
    if (visibleLen(line) > contentWidth) {
      lines.push(...wrapText(line, contentWidth));
    } else {
      lines.push(line);
    }
  }

  const topTitle = title ? `╭${pc.reset(titleStr)}` : "╭";
  const topFill = "─".repeat(Math.max(0, width - visibleLen(titleStr)));
  const top = `${topTitle}${topFill}╮`;

  const middle = lines.map((line) => `│ ${padVisible(line, contentWidth)} │`);

  const bottom = `╰${"─".repeat(width)}╯`;

  return [top, ...middle, bottom].map((l) => borderColor(l)).join("\n");
}

// wrapVisible was a 1-line wrapper for wrapText — inlined directly in renderCard

export function renderSectionRows(title, rows, options = {}) {
  const maxCols = options.columns ?? process.stdout.columns ?? 88;
  const contentWidth = maxCols - 4;
  return renderSection(title, renderRows(rows, { wrapWidth: contentWidth }), { ...options, columns: maxCols });
}

export function renderSection(title, body, options = {}) {
  return renderCard(title, body, { formatBorder: pc.magenta, ...options });
}

/** A dim horizontal divider with an optional label, for separating sections in menus. */
export function divider(label = "") {
  const cols = process.stdout.columns ?? 80;
  if (!label) return pc.dim("─".repeat(Math.min(cols, 72)));
  const text = ` ${label} `;
  const remaining = Math.min(cols, 72) - stripVTControlCharacters(text).length;
  return pc.dim(text + "─".repeat(Math.max(0, remaining)));
}

/** A colored status badge (success/error/warning/info). */
export function badge(text, variant = "info") {
  const colors = { success: pc.green, error: pc.red, warning: pc.yellow, info: pc.cyan };
  const color = colors[variant] ?? pc.cyan;
  return color(`[${text}]`);
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

// ── Escape-to-cancel helper ─────────────────────────────────────────────────

function withEscape() {
  const controller = new AbortController();
  let escapeTimer = null;
  const onData = (data) => {
    // Standalone Escape = 0x1b byte alone (arrow keys send 0x1b + more bytes)
    if (data.length === 1 && data[0] === 0x1b) {
      escapeTimer = setTimeout(() => controller.abort(), 50);
    } else if (escapeTimer) {
      clearTimeout(escapeTimer);
      escapeTimer = null;
    }
  };
  process.stdin.on("data", onData);
  const cleanup = () => {
    process.stdin.removeListener("data", onData);
    if (escapeTimer) clearTimeout(escapeTimer);
  };
  return { signal: controller.signal, cleanup };
}

async function runPrompt(fn, config) {
  const { signal, cleanup } = withEscape();
  try {
    return await fn(config, { signal });
  } catch (err) {
    if (err.name === "AbortPromptError") {
      console.log(pc.dim("\nCancelled."));
      process.exit(0);
    }
    throw err;
  } finally {
    cleanup();
  }
}

// ── Interactive prompt factory ──────────────────────────────────────────────

export function startInteractive() {
  if (process.stdin.isTTY) console.clear();
}

export function createPrompt() {
  return {
    async text(label, defaultValue) {
      const value = await runPrompt(input, {
        message: label,
        default: defaultValue === undefined ? undefined : String(defaultValue),
      });
      return value?.trim() || String(defaultValue ?? "");
    },

    async number(label, defaultValue, min, max, { float = false } = {}) {
      const value = await runPrompt(number, {
        message: label,
        default: defaultValue,
        min,
        max,
        step: float ? 'any' : 1,
        validate(input) {
          if (!Number.isFinite(input) || input < min || input > max) {
            return `Enter a number from ${min} to ${max}.`;
          }
          return true;
        },
      });
      return Number(value);
    },

    async yesNo(label, defaultValue) {
      return await runPrompt(confirm, { message: label, default: defaultValue });
    },

    async choice(label, choices, defaultValue) {
      const mapped = choices.map((c) => {
        if (c instanceof Separator) return c;
        const name = c.hint ? `${c.label ?? c.value} ${pc.dim(`(${c.hint})`)}` : (c.label ?? c.value);
        return { value: c.value, name, disabled: c.disabled || undefined };
      });
      return await runPrompt(inquirerSelect, {
        message: label,
        default: defaultValue,
        choices: mapped,
        pageSize: 20,
        loop: false,
      });
    },
  };
}

// ── Model picker with grouped select ────────────────────────────────────────

export async function modelSelect(label, groups, { defaultKey, pageSize = 20 } = {}) {
  const choices = [];
  // Blank line after the prompt message for visual separation
  choices.push(new Separator(" "));
  for (let i = 0; i < groups.length; i++) {
    const group = groups[i];
    // Add blank line before each group (except the first)
    if (i > 0) choices.push(new Separator(" "));
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
        name: item.description ? `${item.label ?? item.value} ${item.description}` : (item.label ?? item.value),
        disabled: item.disabled || undefined,
      });
    }
  }
  return await runPrompt(inquirerSelect, {
    message: label,
    default: defaultKey,
    choices,
    pageSize,
    loop: false,
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
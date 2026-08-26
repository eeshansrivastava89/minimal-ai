import { isCancel as clackIsCancel, cancel as clackCancel } from "@clack/prompts";
import { stripVTControlCharacters } from "node:util";
import { theme, icons } from "./theme.mjs";
import { maxWidth, visibleLen, padEndVisible, wrapText, sectionLine } from "./layout.mjs";

export { clackIsCancel as isCancel, clackCancel as cancel };

function cardInnerWidth() {
  return maxWidth() - 4;
}

export function appHeader({ name, version, statusItems = [] }) {
  const parts = [theme.brand(name)];
  if (version) parts.push(theme.subtle(`v${version}`));

  const lines = [parts.join(" ")];
  if (statusItems.length > 0) {
    const rendered = statusItems.map((item) => {
      const icon = item.ok ? theme.success(icons.check) : theme.error(icons.cross);
      return `${icon} ${theme.subtle(item.label)}`;
    }).join("  ");
    lines.push(rendered);
  }

  return lines.join("\n");
}

export function screenHeader({ title, subtitle }) {
  const lines = [theme.bold(title)];
  if (subtitle) lines.push(theme.subtle(subtitle));
  return lines.join("\n");
}

export function section(title, width = maxWidth()) {
  return `  ${theme.bold(theme.accent(sectionLine(title, width)))}`;
}

function renderCardBody(body, width) {
  const rawLines = String(body ?? "").split("\n");
  const lines = [];
  for (const line of rawLines) {
    if (visibleLen(line) > width) {
      lines.push(...wrapText(line, width));
    } else {
      lines.push(line);
    }
  }
  return lines;
}

const CARD_TONES = {
  accent: theme.accent,
  warning: theme.warning,
  error: theme.error,
  success: theme.success,
};

export function card({ title, body, rows, tone = "accent" }) {
  // Tone colors the chrome (borders + title) only — body text stays in the
  // terminal's default color so it respects the user's theme and stays
  // readable. tone="warning" marks cards that ask for an action.
  const chrome = CARD_TONES[tone] ?? theme.accent;
  const innerWidth = cardInnerWidth();
  let source;
  if (rows) source = renderList(rows, innerWidth);
  else source = String(body ?? "");
  const lines = renderCardBody(source, innerWidth);
  const titleStr = title ? ` ${title} ` : "";
  const titleLen = visibleLen(titleStr);
  const width = innerWidth + 2;

  const top = title
    ? chrome(`╭${theme.bold(titleStr)}${"─".repeat(Math.max(0, width - titleLen))}╮`)
    : chrome(`╭${"─".repeat(width)}╮`);
  const middle = lines.map((line) => `${chrome("│")} ${padEndVisible(line, innerWidth)} ${chrome("│")}`);
  const bottom = chrome(`╰${"─".repeat(width)}╯`);

  return [top, ...middle, bottom].join("\n");
}

export function infoCard(title, body, { tone } = {}) {
  return card({ title, body, tone });
}

export function status({ kind, message }) {
  const map = {
    success: theme.success(icons.check),
    error: theme.error(icons.cross),
    warning: theme.warning(icons.warning),
    info: theme.brand(icons.info),
  };
  const icon = map[kind] ?? "";
  return `${icon} ${message}`;
}

export function logStatus(kind, message) {
  if (kind === "success") console.log(status({ kind: "success", message }));
  else if (kind === "error") console.error(status({ kind: "error", message }));
  else if (kind === "warning") console.warn(status({ kind: "warning", message }));
  else console.log(status({ kind: "info", message }));
}

export async function withSpinner(label, fn) {
  console.log(status({ kind: "info", message: `${label}...` }));
  try {
    const result = await fn();
    console.log(status({ kind: "success", message: label }));
    return result;
  } catch (err) {
    console.log(status({ kind: "error", message: label }));
    throw err;
  }
}

export function outroScreen(message, kind = "success") {
  if (kind === "error") console.log(status({ kind: "error", message }));
  else if (kind === "warning") console.log(status({ kind: "warning", message }));
  else console.log(status({ kind: "success", message }));
}

export function hintFooter(text) {
  return theme.subtle(text);
}

export function renderList(rows, width = cardInnerWidth()) {
  if (rows.length === 0) return "";
  const keyWidth = Math.max(...rows.map(([k]) => visibleLen(k))) + 2;
  const maxKeyWidth = Math.floor(width / 2);
  const effectiveKeyWidth = Math.min(keyWidth, maxKeyWidth);
  return rows.map(([k, v]) => {
    const currentKeyWidth = visibleLen(k) + 2;
    const keyPrefix = padEndVisible(`  ${k}`, effectiveKeyWidth + 2);
    const valWidth = width - effectiveKeyWidth - 2;
    const valLines = wrapText(String(v ?? ""), valWidth);
    if (currentKeyWidth > effectiveKeyWidth) {
      // This key is too long; value starts on the next line.
      return [keyPrefix, ...valLines.map((l) => " ".repeat(effectiveKeyWidth + 2) + l)].join("\n");
    }
    return [keyPrefix + valLines[0], ...valLines.slice(1).map((l) => " ".repeat(effectiveKeyWidth + 2) + l)].join("\n");
  }).join("\n");
}

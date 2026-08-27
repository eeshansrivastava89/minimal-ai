// Width/wrap math is delegated to maintained primitives (string-width /
// wrap-ansi) — the hand-rolled ANSI-length and hard-split logic this module
// used to carry produced mid-escape cuts and tiny-width hangs. Keep this
// file to width policy + thin padding helpers only.
import stringWidth from "string-width";
import wrapAnsi from "wrap-ansi";

const DEFAULT_MAX_WIDTH = 80; // non-TTY fallback (no terminal to measure)

export function maxWidth() {
  return process.stdout.columns || DEFAULT_MAX_WIDTH;
}

export function visibleLen(str) {
  return stringWidth(String(str ?? ""));
}

export function padEndVisible(str, width) {
  const len = visibleLen(str);
  return str + " ".repeat(Math.max(0, width - len));
}

export function padStartVisible(str, width) {
  const len = visibleLen(str);
  return " ".repeat(Math.max(0, width - len)) + str;
}

export function fillLine(char, width) {
  return char.repeat(Math.max(0, width));
}

export function wrapText(text, width) {
  if (!text) return [];
  // hard: split words longer than the width (never loop at degenerate widths).
  const wrapped = wrapAnsi(String(text), Math.max(1, width), { hard: true });
  return wrapped.split("\n").map((line) => line.trimEnd()).filter((line) => line.trim());
}

export function sectionLine(title, width = maxWidth()) {
  const visibleTitle = visibleLen(title);
  const fill = Math.max(0, width - visibleTitle - 1);
  return `${title} ${fillLine("─", fill)}`;
}

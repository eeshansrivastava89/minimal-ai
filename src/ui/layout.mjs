import { stripVTControlCharacters } from "node:util";

const DEFAULT_MAX_WIDTH = 80;
const ABSOLUTE_MAX_WIDTH = 120;

export function maxWidth() {
  return Math.min(process.stdout.columns || DEFAULT_MAX_WIDTH, ABSOLUTE_MAX_WIDTH);
}

export function visibleLen(str) {
  return stripVTControlCharacters(String(str ?? "")).length;
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
  const words = String(text).split(/(\s+)/u);
  const lines = [];
  let current = "";
  for (let word of words) {
    while (visibleLen(word) > width && word.length > 0) {
      if (current.trim()) { lines.push(current.trimEnd()); current = ""; }
      lines.push(word.slice(0, width));
      word = word.slice(width);
    }
    if (visibleLen(current + word) > width && current.trim()) {
      lines.push(current.trimEnd());
      current = word.trimStart();
    } else {
      current += word;
    }
  }
  if (current.trim()) lines.push(current.trimEnd());
  return lines.length > 0 ? lines : [String(text)];
}

export function sectionLine(title, width = MAX_WIDTH) {
  const visibleTitle = visibleLen(title);
  const fill = Math.max(0, width - visibleTitle - 1);
  return `${title} ${fillLine("─", fill)}`;
}

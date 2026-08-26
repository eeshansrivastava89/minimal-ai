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

const ANSI_ESCAPE = /\x1b\[[0-9;]*m/g;

/**
 * Hard-split a string at a visible width without cutting an ANSI escape
 * sequence mid-way (escape runs are zero-width and copied wholesale).
 * Returns [head, tail].
 */
function hardSliceVisible(str, width) {
  ANSI_ESCAPE.lastIndex = 0;
  let vis = 0;
  let last = 0;
  let cutIndex = -1;
  let m;
  while ((m = ANSI_ESCAPE.exec(str)) !== null) {
    const plain = str.slice(last, m.index);
    if (vis + plain.length > width) {
      cutIndex = last + (width - vis);
      break;
    }
    vis += plain.length;
    last = m.index + m[0].length;
  }
  if (cutIndex === -1) {
    const plain = str.slice(last);
    cutIndex = last + Math.max(0, width - vis);
  }
  return [str.slice(0, cutIndex), str.slice(cutIndex)];
}

export function wrapText(text, width) {
  if (!text) return [];
  // Never loop on a degenerate width (reachable at COLUMNS <= 8).
  const w = Math.max(1, width);
  const words = String(text).split(/(\s+)/u);
  const lines = [];
  let current = "";
  for (let word of words) {
    while (visibleLen(word) > w && word.length > 0) {
      if (current.trim()) { lines.push(current.trimEnd()); current = ""; }
      const [head, tail] = hardSliceVisible(word, w);
      lines.push(head);
      word = tail;
    }
    if (visibleLen(current + word) > w && current.trim()) {
      lines.push(current.trimEnd());
      current = word.trimStart();
    } else {
      current += word;
    }
  }
  if (current.trim()) lines.push(current.trimEnd());
  return lines.length > 0 ? lines : [String(text)];
}

export function sectionLine(title, width = maxWidth()) {
  const visibleTitle = visibleLen(title);
  const fill = Math.max(0, width - visibleTitle - 1);
  return `${title} ${fillLine("─", fill)}`;
}

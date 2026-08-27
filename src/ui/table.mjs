// The one table primitive (tables.mjs). cli-table3 does the drawing —
// box-drawing borders between every cell, ANSI-safe columns, cell wrapping —
// and this module owns the width policy only: columns size to content, then
// shrink the widest columns (wrapping, never truncating) until the table fits
// the terminal. Screens get real grid lines without hand-rolled alignment.
import Table from "cli-table3";
import { visibleLen, maxWidth } from "./layout.mjs";
import { theme } from "./theme.mjs";

// Absolute content floor — below this, a terminal is too narrow for the
// table and columns stop shrinking (wrapping at word boundaries already did
// the work by then).
const MIN_COLUMN_CONTENT = 8;

/** Visible width of the widest line in a cell (or ""). */
function cellWidth(cell) {
  const text = String(cell ?? "");
  return text.split("\n").reduce((max, line) => Math.max(max, visibleLen(line)), 0);
}

/** Natural (content) width of a column across headers + cells. */
function naturalWidth(cells) {
  return Math.max(...cells.map(cellWidth));
}

/**
 * The content floor a column cannot drop below without cli-table3
 * ellipsizing it: its longest unbreakable word. Cells can always wrap at
 * word boundaries, so this is the guaranteed no-truncation width
 * ("nothing ever gets cut off").
 */
function columnFloor(cells) {
  return Math.max(
    ...cells.flatMap((cell) => String(cell ?? "").split(/\s+/u).map((word) => visibleLen(word))),
  );
}

/**
 * Content widths sized to the longest word / line, then squeezed to fit
 * `budget` by shrinking the widest columns first — never below their word
 * floor, so cells wrap instead of ever truncating. cli-table3's colWidth
 * includes its 2-column cell padding; the border chars are added here.
 */
function fitColumnWidths(columns, budget) {
  const widths = columns.map(naturalWidth);
  const floors = columns.map(columnFloor);
  const overhead = columns.length + 1 + 2 * columns.length; // borders + cell padding
  const total = () => widths.reduce((a, b) => a + b, 0) + overhead;
  while (total() > budget) {
    const widest = widths.reduce((a, b, i, arr) => (b > arr[a] ? i : a), 0);
    if (widths[widest] <= floors[widest] || widths[widest] <= MIN_COLUMN_CONTENT) break;
    widths[widest] -= 1;
  }
  return widths;
}

/**
 * Render a bordered table that fits the terminal.
 * @param {object} opts
 * @param {string[]} opts.headers    one header label per column
 * @param {string[][]} opts.rows     one array of cells per row (strings or
 *                                   newline-joined lines; must align with headers)
 * @param {number} [opts.budget]     total width budget (defaults to terminal - 2)
 * @returns {string} the table, or "" when there are no columns
 */
export function renderTable({ headers, rows, budget = maxWidth() - 2 }) {
  if (!headers?.length) return "";
  const columns = headers.map((header, i) => [header, ...rows.map((row) => row[i])]);
  const widths = fitColumnWidths(columns, budget);
  // cli-table3's colWidth includes its 2-column cell padding — add it back
  // so the content area matches the widths we sized (no premature ellipsis).
  const table = new Table({ colWidths: widths.map((width) => width + 2), wordWrap: true });
  table.push(headers.map((header) => theme.bold(header)));
  for (const row of rows) table.push(row.map((cell) => String(cell ?? "")));
  return table.toString();
}
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { stripVTControlCharacters } from "node:util";
import { renderTable, theme } from "../src/ui.mjs";
import { styleMatrixHeader } from "../src/commands/autotune.mjs";
import { rowCoordinates, comboPossible, planMatrix, resultsMatrix, matrixHeaders, thinkingColumnLabel } from "../src/autotune/matrix.mjs";

function gridRow(id, settings) {
  return { id, configId: id, label: id, family: "x", settings, tested: true, estMinutes: 8 };
}

const BASE = { mtp_enabled: false, dflash_enabled: false, enable_thinking: false, thinking_budget_enabled: false, qwen35_ane_prefill_enabled: false, turboquant_kv_enabled: false };
const ROWS = [
  gridRow("vanilla", { ...BASE }),
  gridRow("mtp", { ...BASE, mtp_enabled: true }),
  gridRow("dflash", { ...BASE, dflash_enabled: true }),
  gridRow("thinking", { ...BASE, enable_thinking: true, thinking_budget_enabled: true, thinking_budget_tokens: 4096 }),
  gridRow("mtp-thinking", { ...BASE, mtp_enabled: true, enable_thinking: true, thinking_budget_enabled: true, thinking_budget_tokens: 4096 }),
  gridRow("ane", { ...BASE, qwen35_ane_prefill_enabled: true }),
  gridRow("turboquant-q4", { ...BASE, turboquant_kv_enabled: true, turboquant_kv_bits: 4 }),
  gridRow("turboquant-q8", { ...BASE, turboquant_kv_enabled: true, turboquant_kv_bits: 8 }),
];

describe("rowCoordinates (matrix derives everything from settings)", () => {
  it("maps each grid row to its cell coordinates", () => {
    assert.deepEqual(rowCoordinates(ROWS[0].settings), { spec: "none", think: "off", ane: "off", kv: "off" });
    assert.deepEqual(rowCoordinates(ROWS[1].settings), { spec: "mtp", think: "off", ane: "off", kv: "off" });
    assert.deepEqual(rowCoordinates(ROWS[2].settings), { spec: "dflash", think: "off", ane: "off", kv: "off" });
    assert.deepEqual(rowCoordinates(ROWS[3].settings), { spec: "none", think: "on", ane: "off", kv: "off" });
    assert.deepEqual(rowCoordinates(ROWS[4].settings), { spec: "mtp", think: "on", ane: "off", kv: "off" });
    assert.deepEqual(rowCoordinates(ROWS[5].settings), { spec: "none", think: "off", ane: "on", kv: "off" });
    assert.deepEqual(rowCoordinates(ROWS[6].settings), { spec: "none", think: "off", ane: "off", kv: "q4" });
    assert.deepEqual(rowCoordinates(ROWS[7].settings), { spec: "none", think: "off", ane: "off", kv: "q8" });
  });
});

describe("comboPossible", () => {
  it("DFlash refuses thinking + ANE (separate engine path)", () => {
    assert.equal(comboPossible("dflash", "on", "off"), false);
    assert.equal(comboPossible("dflash", "off", "on"), false);
    assert.equal(comboPossible("dflash", "on", "on"), false);
    assert.equal(comboPossible("dflash", "off", "off"), true);
  });
  it("every other combination is possible", () => {
    for (const spec of ["none", "mtp"]) {
      for (const think of ["off", "on"]) {
        for (const ane of ["off", "on"]) assert.equal(comboPossible(spec, think, ane), true);
      }
    }
  });
});

describe("planMatrix (dry-run: ✓ / – / NA)", () => {
  it("marks exactly the 8 sweep rows, NA wherever impossible, – elsewhere", () => {
    const blocks = planMatrix(ROWS);
    assert.equal(blocks.length, 3); // kv-quant off/q4/q8 blocks
    let ticks = 0, na = 0, empty = 0;
    for (const block of blocks) {
      for (const row of block.rows) for (const cell of row.cells) {
        if (cell.kind === "tick") ticks += 1;
        if (cell.kind === "na") na += 1;
        if (cell.kind === "empty") empty += 1;
      }
    }
    assert.equal(ticks, 8);
    // DFlash row x (think on | ane on) = 3 impossible cells per block
    assert.equal(na, 3 * 3);
    assert.equal(ticks + na + empty, 3 * 12); // 36 combos
  });

  it("budget in the header comes from the grid data", () => {
    assert.equal(thinkingColumnLabel(ROWS), "think +4096");
    assert.deepEqual(matrixHeaders(ROWS), ["think off · ANE off", "think off · ANE on", "think +4096 · ANE off", "think +4096 · ANE on"]);
  });
});

describe("resultsMatrix (measured cells carry tps + delta)", () => {
  function resultRow(configId, median, mad = 0.5) {
    const grid = ROWS.find((r) => r.configId === configId);
    return { configId, label: grid.label, family: grid.family, settings: grid.settings, summary: { median, mad } };
  }
  const results = [
    resultRow("vanilla", 31.6),
    resultRow("mtp", 38.8),
    resultRow("dflash", 28.5),
    resultRow("thinking", 31.4),
    resultRow("mtp-thinking", 47.6),
    resultRow("ane", 30.9),
    resultRow("turboquant-q4", 30.0),
    resultRow("turboquant-q8", 31.2),
  ];
  const recommendation = { ok: true, recommendation: { configId: "mtp" } };

  it("renders deltas vs the vanilla baseline and stars the recommendation", () => {
    const blocks = resultsMatrix(results, recommendation);
    const kvOff = blocks.find((b) => b.kv === "off");
    const cell = (spec, colIdx) => kvOff.rows.find((r) => r.label.startsWith(spec)).cells[colIdx];
    assert.deepEqual(cell("none", 0), { text: "31.6 (baseline)", kind: "value" });
    assert.deepEqual(cell("MTP", 0), { text: "38.8 (+23%)", kind: "value-star" });
    assert.deepEqual(cell("MTP", 2), { text: "47.6 (+51%)", kind: "value" });
    assert.deepEqual(cell("DFlash", 0), { text: "28.5 (−10%)", kind: "value" });
    assert.deepEqual(cell("none", 1), { text: "30.9 (−2% ≈)", kind: "value" });
    assert.deepEqual(cell("MTP", 1), { text: "–", kind: "empty" });
    assert.deepEqual(cell("DFlash", 2), { text: "NA", kind: "na" });
    const kvQ4 = blocks.find((b) => b.kv === "q4");
    assert.deepEqual(kvQ4.rows[0].cells[0], { text: "30.0 (−5%)", kind: "value" });
    assert.deepEqual(kvQ4.rows[0].cells[2], { text: "–", kind: "empty" });
  });
});

describe("styleMatrixHeader", () => {
  it("colors off red, on green, and the +budget green — plain text intact", () => {
    assert.equal(styleMatrixHeader("think off · ANE off"), `think ${theme.error("off")} · ANE ${theme.error("off")}`);
    assert.equal(styleMatrixHeader("think +4096 · ANE on"), `think ${theme.success("+4096")} · ANE ${theme.success("on")}`);
    // Stripped, the header still reads exactly as authored.
    assert.equal(stripVTControlCharacters(styleMatrixHeader("think +4096 · ANE on")), "think +4096 · ANE on");
  });
});

describe("renderTable", () => {
  it("draws full borders around every cell and fits the budget", () => {
    const table = renderTable({
      headers: ["Speculative", "think off · ANE off"],
      rows: [["none", "31.6 (baseline)"], ["DFlash (z-lab)", "NA"]],
      budget: 60,
    });
    const lines = table.split("\n").map(stripVTControlCharacters);
    assert.match(lines[0], /^[┌─┬┐]+$/); // top border
    assert.match(lines[lines.length - 1], /^[└─┴┘]+$/); // bottom border
    // Interior horizontal separators between EVERY row (├ ─ ┼ ┤ glyphs).
    assert.ok(lines.some((l) => l.includes("├") && l.includes("┼") && l.includes("┤")));
    assert.ok(lines.some((l) => l.includes("│"))); // vertical separators
    for (const line of lines) {
      assert.ok(line.length <= 61, `line ${line.length} exceeds budget: ${line}`);
    }
    assert.ok(lines.some((l) => l.includes("31.6"))); // content intact — nothing cut
  });

  it("wraps long cells instead of cutting them", () => {
    const long = "this note is deliberately long enough to wrap";
    const table = renderTable({ headers: ["h"], rows: [[long]], budget: 30 });
    const plain = stripVTControlCharacters(table).replace(/[│┌┐└┘├┤┬┴─]/gu, " ").replace(/\s+/gu, " ").trim();
    assert.ok(plain.endsWith(long)); // full text present word-for-word (header cell precedes it)
    assert.ok(table.split("\n").length > 4); // more than header+1 row lines
  });
});
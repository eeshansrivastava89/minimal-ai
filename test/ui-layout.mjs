import { describe, it } from "node:test";
import assert from "node:assert/strict";

const { wrapText, sectionLine, visibleLen } = await import("../src/ui/layout.mjs");
const { theme } = await import("../src/ui/theme.mjs");

// An escape is always \x1b[ … m — a "complete" ANSI sequence.
// eslint-disable-next-line no-control-regex
const ESCAPE_RE = /\x1b\[[0-9;]*m/g;

describe("wrapText", () => {
  it("never infinite-loops at degenerate widths (COLUMNS <= 8 path)", () => {
    for (const w of [0, -1, 1]) {
      const lines = wrapText("hello world this wraps", w);
      assert.ok(lines.length > 0);
    }
  });

  it("hard-splits long styled words without cutting an ANSI escape sequence", () => {
    const word = theme.success("averylongstyledword");
    for (const line of wrapText(word, 6)) {
      // Every line must contain only COMPLETE escapes (paired \x1b[ … m).
      const escapes = line.match(ESCAPE_RE) ?? [];
      for (const esc of escapes) assert.ok(esc.endsWith("m"));
      // No line may contain a dangling escape start ("\x1b[" without "m").
      assert.ok(!line.replace(ESCAPE_RE, "").includes("\x1b"), `dangling escape in: ${JSON.stringify(line)}`);
      assert.ok(visibleLen(line) <= 6, `over-wide: ${visibleLen(line)}`);
    }
  });

  it("wraps plain text on word boundaries", () => {
    const lines = wrapText("alpha beta gamma delta", 11);
    assert.deepEqual(lines, ["alpha beta", "gamma delta"]);
  });
});

describe("sectionLine", () => {
  it("has a working width default (no ReferenceError)", () => {
    const line = sectionLine("Section");
    assert.ok(line.startsWith("Section ─"));
    assert.equal(visibleLen(line), 80); // maxWidth() default off-TTY
  });
});

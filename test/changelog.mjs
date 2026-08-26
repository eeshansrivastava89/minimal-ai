import { describe, it } from "node:test";
import assert from "node:assert/strict";

const { renderEntryBody } = await import("../src/changelog.mjs");

// stripAnsi so assertions don't depend on the test runner's TTY/color state.
// eslint-disable-next-line no-control-regex
const stripAnsi = (s) => s.replace(/\x1b\[[0-9;]*m/g, "");

const render = (content, width = 76) =>
  stripAnsi(renderEntryBody({ version: "1.0.0", content }, width)).split("\n");

describe("renderEntryBody", () => {
  it("keeps nested bullets as their own indented bullets (never absorbed)", () => {
    const lines = render([
      "### Fixed",
      "- Parent bullet",
      "  - child one",
      "  - child two",
    ].join("\n"));

    const parent = lines.find((l) => l.includes("Parent bullet"));
    assert.ok(parent, "parent bullet rendered");
    assert.equal(parent.trim().startsWith("- "), true);
    assert.ok(!parent.includes("child"), "children must not be absorbed into the parent");

    const childOne = lines.find((l) => l.includes("child one"));
    const childTwo = lines.find((l) => l.includes("child two"));
    assert.ok(/^\s{4}-\schild one$/.test(childOne), `child one indented: "${childOne}"`);
    assert.ok(/^\s{4}-\schild two$/.test(childTwo), `child two indented: "${childTwo}"`);
  });

  it("still joins a bullet's indented continuation lines into one paragraph", () => {
    const lines = render("- A bullet wrapped by hand\n  across two source lines");
    assert.equal(lines.length, 1);
    assert.equal(lines[0], "  - A bullet wrapped by hand across two source lines");
  });

  it("renders section headers and drops blank lines", () => {
    const lines = render("\n### Added\n\n- one\n\n### Fixed\n\n- two\n");
    assert.ok(lines.some((l) => l.includes("Added")));
    assert.ok(lines.some((l) => l.includes("Fixed")));
    assert.ok(lines.some((l) => l === "  - one"));
    assert.ok(lines.some((l) => l === "  - two"));
    assert.ok(!lines.includes("### Added"));
  });

  it("mirrors a real shipped entry shape (3.0.0-style nesting)", () => {
    const content = [
      "### Breaking Changes",
      "- **Renamed to minimal-ai** — the CLI, config dir, and npm package changed:",
      "  - Command: `og` is now `minimal-ai`",
      "  - Config dir moved",
    ].join("\n");
    const lines = render(content);
    assert.ok(lines.some((l) => l.includes("Renamed to minimal-ai")));
    assert.ok(lines.some((l) => /^\s{4}-\s/.test(l) && l.includes("Config dir moved")),
      "nested bullet kept as a bullet");
    // No stray "- " fragment merged into the wrapped parent paragraph.
    for (const l of lines) {
      if (l.includes("Renamed")) assert.ok(!l.includes("Config dir moved"));
    }
  });
});

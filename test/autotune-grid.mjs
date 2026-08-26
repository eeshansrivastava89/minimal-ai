import { describe, it } from "node:test";
import assert from "node:assert/strict";

const {
  baseFamily,
  isFinetune,
  findDflashDrafts,
  pickDflashDraft,
  generateGrid,
  estimateGridMinutes,
} = await import("../src/autotune/grid.mjs");
const { normalizeOmlxAdminModel } = await import("../src/autotune/probe.mjs");

// ── Fixtures (mirror the live 2026-08-26 admin probe) ───────────────────────

function fixture(raw) {
  return normalizeOmlxAdminModel(raw);
}

// The DFlash2 draft discovered on the server.
const dflashDraft = fixture({
  id: "Qwen3.8-27B-DFlash2",
  display_name: "z-lab/Qwen3.8-27B-DFlash2",
  model_path: "/Users/x/.omlx/models/z-lab/Qwen3.8-27B-DFlash2",
  loaded: false,
  estimated_size: 4042655744,
  engine_type: "batched",
  mtp_compatible: false,
  dflash_compatible: true,
  thinking_default: null,
});

// mlx-community base model — DFlash fast path (REF row, 15.7 tps).
const refBase = fixture({
  id: "Qwen3.8-27B-4bit",
  display_name: "mlx-community/Qwen3.8-27B-4bit",
  loaded: false,
  estimated_size: 16857268416,
  engine_type: "vlm",
  mtp_compatible: false,
  mtp_compatibility_reason: "Config declares MTP layers but the weight files contain neither mtp.* tensors nor native nextn layers.",
  dflash_compatible: true,
  thinking_default: true,
});

// chimingw personality fine-tune — MTP fast path, DFlash HURTS (7.4 vs 10.1).
const chimingw = fixture({
  id: "Qwen3.8-27B-Uncensored-OrcaRouter-MLX-4bit",
  display_name: "chimingw/Qwen3.8-27B-Uncensored-OrcaRouter-MLX-4bit",
  loaded: false,
  estimated_size: 17800000000,
  engine_type: "vlm",
  mtp_compatible: true,
  dflash_compatible: true,
  thinking_default: true,
});

// A re-conversion with MTP heads preserved — NOT a personality fine-tune, so
// a base DFlash draft should still match it.
const mplx = fixture({
  id: "Qwen3.8-27B-MTPLX-Optimized-Speed",
  display_name: "Youssofal/Qwen3.8-27B-MTPLX-Optimized-Speed",
  loaded: false,
  estimated_size: 21700000000,
  engine_type: "vlm",
  mtp_compatible: true,
  dflash_compatible: true,
  thinking_default: true,
});

// A model with no speculative path at all.
const noSpec = fixture({
  id: "Qwen3.5-4B-OptiQ-4bit",
  display_name: "mlx-community/Qwen3.5-4B-OptiQ-4bit",
  loaded: false,
  estimated_size: 4200000000,
  engine_type: "vlm",
  mtp_compatible: false,
  mtp_compatibility_reason: "MTPLX side-car detected but not imported.",
  dflash_compatible: true,
  thinking_default: true,
});

const allModels = [refBase, dflashDraft, chimingw, mplx, noSpec];

// ── baseFamily / isFinetune ─────────────────────────────────────────────────

describe("baseFamily", () => {
  it("collapses quant, variant, and fine-tune suffixes to the family", () => {
    assert.equal(baseFamily("Qwen3.8-27B-4bit"), "qwen3.8-27b");
    assert.equal(baseFamily("Qwen3.8-27B-Uncensored-OrcaRouter-MLX-4bit"), "qwen3.8-27b");
    assert.equal(baseFamily("Qwen3.8-27B-DFlash2"), "qwen3.8-27b");
    assert.equal(baseFamily("Qwen3.8-27B-MTPLX-Optimized-Speed"), "qwen3.8-27b");
    assert.equal(baseFamily("mlx-community/Qwen3.8-27B-4bit"), "qwen3.8-27b");
    assert.equal(baseFamily("Qwen3.5-4B-OptiQ-4bit"), "qwen3.5-4b");
  });
});

describe("isFinetune", () => {
  it("flags personality fine-tunes but not format variants or re-conversions", () => {
    assert.equal(isFinetune("Qwen3.8-27B-Uncensored-OrcaRouter-MLX-4bit"), true);
    assert.equal(isFinetune("Qwen3.8-27B-Instruct"), true);
    assert.equal(isFinetune("Qwen3.8-27B-DPO"), true);
    assert.equal(isFinetune("Qwen3.8-27B-4bit"), false);
    assert.equal(isFinetune("Qwen3.8-27B-DFlash2"), false);
    assert.equal(isFinetune("Qwen3.8-27B-MTPLX-Optimized-Speed"), false);
    assert.equal(isFinetune("Qwen3.5-4B-OptiQ-4bit"), false);
  });
});

// ── DFlash draft discovery + matching ───────────────────────────────────────

describe("findDflashDrafts", () => {
  it("picks the DFlash2 entry out of the full model list", () => {
    const drafts = findDflashDrafts(allModels);
    assert.equal(drafts.length, 1);
    assert.equal(drafts[0].id, "Qwen3.8-27B-DFlash2");
  });
});

describe("pickDflashDraft", () => {
  it("matches a base target to the base draft", () => {
    const pick = pickDflashDraft(refBase, [dflashDraft]);
    assert.equal(pick.matched, true);
    assert.equal(pick.draft.id, "Qwen3.8-27B-DFlash2");
  });

  it("matches a re-conversion (not a personality fine-tune)", () => {
    const pick = pickDflashDraft(mplx, [dflashDraft]);
    assert.equal(pick.matched, true);
  });

  it("rejects a personality fine-tune with a mismatch reason", () => {
    const pick = pickDflashDraft(chimingw, [dflashDraft]);
    assert.equal(pick.matched, false);
    assert.match(pick.reason, /fine-tune/i);
  });

  it("reports a missing draft when none of the family exists", () => {
    const pick = pickDflashDraft(refBase, []);
    assert.equal(pick.matched, false);
    assert.match(pick.reason, /no DFlash draft/i);
  });
});

// ── generateGrid ────────────────────────────────────────────────────────────

describe("generateGrid", () => {
  it("produces a stable, ordered row set with the required shape", () => {
    const rows = generateGrid(refBase, allModels);
    assert.deepEqual(
      rows.map((r) => r.id),
      ["vanilla", "mtp", "dflash", "thinking", "ane", "turboquant-q4", "turboquant-q8"],
    );
    for (const r of rows) {
      assert.ok(typeof r.label === "string" && r.label.length > 0);
      assert.ok(typeof r.tested === "boolean");
      assert.ok(typeof r.estMinutes === "number" && r.estMinutes > 0);
      assert.ok(r.settings && typeof r.settings === "object");
      assert.equal(r.tested ? r.skipReason : null, null);
    }
  });

  it("adds an mtp-thinking row only when the model is MTP-compatible", () => {
    const mtpRows = generateGrid(chimingw, allModels).map((r) => r.id);
    assert.ok(mtpRows.includes("mtp-thinking"));

    const noMtpRows = generateGrid(refBase, allModels).map((r) => r.id);
    assert.ok(!noMtpRows.includes("mtp-thinking"));
  });

  it("tests DFlash with the matched draft for a base model (REF fast path)", () => {
    const dflash = generateGrid(refBase, allModels).find((r) => r.id === "dflash");
    assert.equal(dflash.tested, true);
    assert.equal(dflash.settings.dflash_enabled, true);
    // oMLX consumes dflash_draft_model as a filesystem path (the dashboard
    // sets model_path || id as the select value) — not a display name.
    assert.equal(dflash.settings.dflash_draft_model, "/Users/x/.omlx/models/z-lab/Qwen3.8-27B-DFlash2");
  });

  it("falls back to the model id when the draft has no path", () => {
    const noPathModels = allModels.map((m) => (m.displayName.includes("DFlash") ? { ...m, modelPath: null } : m));
    const dflash = generateGrid(refBase, noPathModels).find((r) => r.id === "dflash");
    assert.equal(dflash.settings.dflash_draft_model, "Qwen3.8-27B-DFlash2");
  });

  it("skips DFlash for a personality fine-tune with a mismatch reason (chimingw)", () => {
    const dflash = generateGrid(chimingw, allModels).find((r) => r.id === "dflash");
    assert.equal(dflash.tested, false);
    assert.match(dflash.skipReason, /fine-tune/i);
    // Would-be settings still attached for the dry-run plan.
    assert.equal(dflash.settings.dflash_enabled, true);
  });

  it("skips MTP when not compatible and carries the probe's reason", () => {
    const mtp = generateGrid(refBase, allModels).find((r) => r.id === "mtp");
    assert.equal(mtp.tested, false);
    assert.match(mtp.skipReason, /MTP/i);
  });

  it("skips both speculative rows for a model with neither path", () => {
    const rows = generateGrid(noSpec, allModels);
    const mtp = rows.find((r) => r.id === "mtp");
    const dflash = rows.find((r) => r.id === "dflash");
    // noSpec is dflash_compatible but has no matching draft for the 4B family.
    assert.equal(mtp.tested, false);
    assert.equal(dflash.tested, false);
  });

  it("never stacks MTP and DFlash on the same row", () => {
    for (const target of [refBase, chimingw, mplx, noSpec]) {
      for (const r of generateGrid(target, allModels)) {
        assert.ok(
          !(r.settings.mtp_enabled && r.settings.dflash_enabled),
          `${target.id} row ${r.id} stacks MTP + DFlash`,
        );
      }
    }
  });

  it("forces DFlash off on every thinking row so the budget is enforced", () => {
    for (const target of [refBase, chimingw, mplx]) {
      const rows = generateGrid(target, allModels);
      const thinking = rows.filter((r) => r.family === "thinking");
      for (const r of thinking) {
        assert.equal(r.settings.dflash_enabled, false, `${target.id} ${r.id} has DFlash on`);
        assert.equal(r.settings.enable_thinking, true);
        assert.equal(r.settings.thinking_budget_enabled, true);
        assert.equal(r.settings.thinking_budget_tokens, 4096);
      }
    }
  });

  it("isolates ANE prefill on the vanilla baseline", () => {
    const ane = generateGrid(refBase, allModels).find((r) => r.id === "ane");
    assert.equal(ane.tested, true);
    assert.equal(ane.settings.qwen35_ane_prefill_enabled, true);
    assert.equal(ane.settings.mtp_enabled, false);
    assert.equal(ane.settings.dflash_enabled, false);
    assert.equal(ane.settings.enable_thinking, false);
  });

  it("skips the ANE row for non-Qwen3.5/3.6/3.8 families (qwen35_ane_* is a private GDN feature)", () => {
    const llama = fixture({
      id: "Llama-3.3-8B-4bit",
      display_name: "mlx-community/Llama-3.3-8B-4bit",
      loaded: false,
      engine_type: "vlm",
      mtp_compatible: false,
      dflash_compatible: false,
      thinking_default: null,
    });
    const ane = generateGrid(llama, allModels).find((r) => r.id === "ane");
    assert.equal(ane.tested, false);
    assert.match(ane.skipReason, /Qwen3\.5\/3\.6\/3\.8-only/);
  });

  it("emits turboquant q4 and q8 rows with the right bits", () => {
    const rows = generateGrid(refBase, allModels);
    const q4 = rows.find((r) => r.id === "turboquant-q4");
    const q8 = rows.find((r) => r.id === "turboquant-q8");
    assert.equal(q4.settings.turboquant_kv_enabled, true);
    assert.equal(q4.settings.turboquant_kv_bits, 4);
    assert.equal(q8.settings.turboquant_kv_enabled, true);
    assert.equal(q8.settings.turboquant_kv_bits, 8);
  });

  it("forces every non-under-test knob off so siblings can't contaminate", () => {
    for (const target of [refBase, chimingw, mplx]) {
      for (const r of generateGrid(target, allModels)) {
        // Every row declares the full knob set (off unless under test).
        for (const key of ["mtp_enabled", "dflash_enabled", "enable_thinking", "thinking_budget_enabled", "qwen35_ane_prefill_enabled", "turboquant_kv_enabled"]) {
          assert.ok(key in r.settings, `${target.id} row ${r.id} missing ${key}`);
        }
      }
    }
  });
});

describe("estimateGridMinutes", () => {
  it("sums only tested rows", () => {
    const rows = generateGrid(chimingw, allModels);
    const total = estimateGridMinutes(rows);
    // chimingw: vanilla(8)+mtp(8)+dflash-skip(0)+thinking(12)+mtp-thinking(12)+ane(10)+q4(8)+q8(8)
    assert.equal(total, 66);
  });
});
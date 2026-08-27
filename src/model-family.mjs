// Model-family predicates — the single home for name/architecture patterns
// (A5). Previously these regexes drifted across capabilities.mjs,
// harness-pi.mjs, model-summary.mjs, and profile-setup.mjs.
//
// These are HEURISTICS over names/families/projector types — the last
// resort. Detected capability facts live in capabilities.mjs and on
// profile.capabilities; only fall back to a family pattern when no
// authoritative source answered.

/** Name-based thinking detection for models whose metadata can't be read
 *  (managed oMLX/Ollama models without an authoritative answer). */
export function nameHintsThinking(hints) {
  return /qwen3|qwen3\.\d|gemma-4|gemma4|deepseek-r[12]/i.test(String(hints).toLowerCase());
}

/** Qwen3.5/3.6/3.8/Next family — templates accept only low/medium/xhigh,
 *  with xhigh as the template default (see harness-pi.mjs). */
export function isQwen3xFamily(family) {
  return /qwen3[._-]?(?:[568]|next)/i.test(family);
}

/** Families whose chat templates read enable_thinking + reasoning_effort
 *  kwargs — the generic chat-template kwargs format carries BOTH the on/off
 *  toggle and the effort level for these (see harness-pi.mjs). */
export function usesChatTemplateKwargs(family) {
  return family.includes("qwen") || family.includes("gemma-4") || family.includes("gemma 4");
}

/** Gemma 4 unified projector (gemma4uv/gemma4ua) — needs llama.cpp b9549+. */
export function isGemma4UnifiedProjector(projectorType) {
  return /gemma4u[va]/i.test(String(projectorType ?? ""));
}

/** Detected gemma4 architecture fact (drafter hints in model summaries). */
export function isGemma4Architecture(caps) {
  return caps?.architecture === "gemma4";
}

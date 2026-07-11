// ── Single path for parsing and formatting model names ─────────────────────
//
// Every model display name in offgrid-ai goes through parseModelName().
// No other function should format, title-case, or dissect a model name.
//
// The returned `id` is always the raw identifier (untouched) and is used for
// API calls, profile IDs, and Pi config matching.
// The returned `display` is the human-readable string shown in pickers, details,


// ── Known model families ────────────────────────────────────────────────
//
// Mapped to their title-case form. Matched as prefix tokens so "qwen"
// matches "qwen3", "qwen2.5", etc.

const FAMILY_TITLE_CASE = {
  "deepseek-r": "DeepSeek-R",
  "deepseek": "DeepSeek",
  "starcoder2": "StarCoder2",
  "starcoder": "StarCoder",
  "command-r": "Command-R",
  "command": "Command",
  "codestral": "Codestral",
  "mistral": "Mistral",
  "mixtral": "Mixtral",
  "mathstral": "Mathstral",
  "pixtral": "Pixtral",
  "gemma": "Gemma",
  "qwen": "Qwen",
  "llama": "Llama",
  "phi": "Phi",
  "yi": "Yi",
  "zephyr": "Zephyr",
  "internlm": "InternLM",
  "cohere": "Cohere",
  "falcon": "Falcon",
  "baichuan": "Baichuan",
  "mamba": "Mamba",
  "solar": "Solar",
  "granite": "Granite",
  "dbrx": "DBRX",
  "stablelm": "StableLM",
};

// Sort families by length descending so longer families match first
const SORTED_FAMILIES = Object.keys(FAMILY_TITLE_CASE).sort((a, b) => b.length - a.length);

// ── Quant patterns (order matters — longer/more-specific first) ────────

const QUANT_PATTERNS = [
  /[-_]UD-[A-Z0-9_]+/i,
  /[-_]IQ[0-9_]+(?:_[A-Z]+)?/i,
  /[-_]Q\d_K_[A-Z]+/i,
  /[-_]Q\d_[01]/i,
  /[-_]F(?:16|32)/i,
  /[-_]BF16/i,
  /[-_]\d+bit\b/i,
];

// ── Tag tokens extracted from the name ──────────────────────────────────

const TAG_TOKENS = [
  "it", "instruct", "chat", "code", "base", "vision", "mtp",
  "mmproj", "draft", "assistant",
];

// ── Main entry point ───────────────────────────────────────────────────

/**
 * Parse a raw model identifier into a structured display name.
 *
 * @param {string} rawId  The raw identifier: GGUF filename (no .gguf) or oMLX model id.
 * @param {"local-gguf"|"omlx"} source  Where this name came from.
 * @returns {{ publisher: string|null, model: string, params: string|null,
 *             quant: string|null, tags: string[], display: string,
 *             sort: string, id: string }}
 */
export function parseModelName(rawId, source) {
  const id = rawId; // never modify the raw id

  // 1. Extract publisher (anything before the first /, or -- for oMLX)
  let publisher = null;
  let name = rawId;
  const slashIdx = rawId.indexOf("/");
  if (slashIdx !== -1) {
    publisher = rawId.slice(0, slashIdx);
    name = rawId.slice(slashIdx + 1);
  } else if (source === "omlx") {
    // oMLX uses org--name format
    const dashIdx = rawId.indexOf("--");
    if (dashIdx !== -1) {
      publisher = rawId.slice(0, dashIdx);
      name = rawId.slice(dashIdx + 2);
    }
  }

  // 2. Extract quant (GGUF quantization suffix)
  let quant = null;
  for (const pattern of QUANT_PATTERNS) {
    const match = name.match(pattern);
    if (match) {
      quant = match[0].replace(/^[-_]/, "");
      name = name.slice(0, match.index) + name.slice(match.index + match[0].length);
      break;
    }
  }

  // 4. Extract known tags as hyphen/underscore-delimited tokens
  const tags = [];
  for (const tag of TAG_TOKENS) {
    const tagRegex = new RegExp(`(?:^|[-_])${tag}(?:$|[-_])`, "i");
    if (tagRegex.test(name)) {
      tags.push(tag);
      // Remove the tag token from the name
      name = name.replace(new RegExp(`(?:^|[-_])${tag}(?=[-_]|$)`, "i"), "");
    }
  }
  // Clean up leftover separators
  name = name.replace(/[-_]{2,}/g, "-").replace(/^[-_]+|[-_]+$/g, "");

  // 5. Title-case the remaining model name
  let model = titleCaseModel(name);

  // If nothing is left after parsing, fall back to the raw name
  if (!model || model.trim() === "") {
    model = rawId.includes("/") ? rawId : rawId.replace(/[-_]/g, " ");
  }

  // 6. Extract params (size like 30B, 12B) for sort/filter convenience
  const params = extractParams(model);

  // 7. Build display string
  const display = buildDisplay(publisher, model, tags);

  // 8. Build sort key (lowercase, no publisher, for alphabetical ordering)
  const sort = model.toLowerCase().replace(/[-_]/g, " ");

  return { publisher, model, params, quant, tags, display, sort, id };
}

// ── Display builder ────────────────────────────────────────────────────

function buildDisplay(publisher, model, tags) {
  let modelPart = model;
  if (tags.length > 0) {
    modelPart += ` (${tags.join(", ")})`;
  }
  return publisher ? `${publisher}/${modelPart}` : modelPart;
}

// ── Params extraction ──────────────────────────────────────────────────

function extractParams(model) {
  const match = model.match(/\b(\d+(?:\.\d+)?)\s*B\b/);
  return match ? match[1] + "B" : null;
}

// ── Title-case model names ────────────────────────────────────────────

function titleCaseModel(name) {
  // Replace hyphens and underscores with spaces
  let result = name.replace(/[-_]/g, " ");

  // Title-case known families (prefix match so "qwen" matches "qwen3", etc.)
  // Insert a space between the family name and a following digit/version.
  for (const family of SORTED_FAMILIES) {
    const pattern = new RegExp(`\\b${family}(?=[0-9])`, "gi");
    result = result.replace(pattern, FAMILY_TITLE_CASE[family] + " ");
    // Also match family at end of word (no digit following)
    const patternEnd = new RegExp(`\\b${family}(?![a-z0-9])`, "gi");
    result = result.replace(patternEnd, FAMILY_TITLE_CASE[family]);
  }

  // Title-case param sizes (30b → 30B, 12b → 12B, 0.5b → 0.5B)
  result = result.replace(/\b(\d+(?:\.\d+)?)\s*[bB]\b/g, (_, num) => {
    return num + "B";
  });

  // Title-case version numbers that follow a family name (Gemma 3, Qwen 2.5)
  // Pattern: family name followed by a space then a bare digit sequence
  // that's not a param size (not followed by B/b).
  // We already have "Gemma 4", "Qwen 3" etc. from family + spacing.
  // Just ensure the numbers look clean.

  // Title-case "it" and "instruct" if they survived tag extraction
  result = result.replace(/\bit\b/g, "IT");
  result = result.replace(/\binstruct\b/gi, "Instruct");

  // Title-case "r1", "r2" etc. (DeepSeek-R1, etc.)
  result = result.replace(/\br(\d+)\b/gi, (_, num) => `R${num}`);

  // Title-case standalone aXb patterns (A3B, A12B — active parameters)
  result = result.replace(/\ba(\d+)\s*b\b/gi, (_, num) => `A${num}B`);

  // Title-case eXb patterns (E2B, E12B — effective parameters)
  result = result.replace(/\be(\d+)\s*b\b/gi, (_, num) => `E${num}B`);

  // Clean up extra spaces
  result = result.replace(/\s{2,}/g, " ").trim();

  return result;
}
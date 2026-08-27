import { ensureDirs } from "../config.mjs";
import { backendFor } from "../backends.mjs";
import { readProfile, saveProfile } from "../profiles.mjs";
import { parseOptions, status } from "../ui.mjs";
import { runProfile } from "../launch.mjs";

// Re-export the launch service for backward compatibility with any caller
// still importing from this command module. The canonical home is now
// ../launch.mjs (H3/H4): services and other commands depend on the service,
// not on this CLI handler.
export { runProfile } from "../launch.mjs";

const THINKING_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh", "max"];

export async function runCommand(argv) {
  await ensureDirs();
  const { positional, options } = parseOptions(argv);
  if (!positional[0]) throw new Error("Specify a model name: minimal-ai run <model>");
  const profile = await readProfile(positional[0]);

  // Per-model thinking level: persists on the profile so later launches
  // (picker chat, benchmark) inherit it. Ollama's /v1 ignores thinking.
  if (options.thinking !== undefined && options.thinking !== true) {
    const level = String(options.thinking).toLowerCase();
    if (!THINKING_LEVELS.includes(level)) {
      throw new Error(`Invalid --thinking level: "${options.thinking}". Supported: ${THINKING_LEVELS.join(", ")}`);
    }
    if (backendFor(profile.backend).id === "ollama") {
      console.log(status({ kind: "warning", message: `Ollama's OpenAI-compatible /v1 ignores thinking levels — --thinking ${level} has no effect for this model.` }));
    } else {
      await saveProfile({ ...profile, thinkingLevel: level });
      profile.thinkingLevel = level;
    }
    options.thinking = level;
  }

  return await runProfile(profile, normalizeWithOption(options));
}

/** CLI boundary: `--with server` means "start the server only" — translate
 *  to the explicit flag so the pseudo-harness string never propagates. */
function normalizeWithOption(options) {
  if (options.with !== "server") return options;
  const rest = { ...options };
  delete rest.with;
  return { ...rest, serverOnly: true };
}
// Profile setup/reconfigure entry (A1). The monolithic profile-setup.mjs
// split into per-backend flows (local/omlx/ollama) + shared machinery
// (questions); this index keeps the public surface and the managed dispatch
// in one place.

import { backendFor } from "../backends.mjs";
import { configureOmlxProfile } from "./omlx.mjs";
import { configureOllamaProfile } from "./ollama.mjs";
import { configureLocalProfile } from "./local.mjs";
import { CancelSetup } from "./questions.mjs";
import { theme } from "../ui.mjs";

export { configureLocalProfile } from "./local.mjs";
export { samplerDefault, lowBitKvWarning, LONG_CONTEXT_KV_THRESHOLD } from "./questions.mjs";

/** Configure a managed (oMLX / Ollama) profile; cancel-safe like local. */
export async function configureManagedProfile(profile) {
  try {
    // Per-backend flow colocated in sibling modules; llama.cpp is the local
    // flow. (Dispatch by backend id is kept to this single call site — the
    // manager modules are siblings, not importable from backends.mjs without
    // a cycle.)
    return backendFor(profile.backend).id === "ollama"
      ? await configureOllamaProfile(profile)
      : await configureOmlxProfile(profile);
  } catch (err) {
    if (err instanceof CancelSetup) {
      console.log(theme.subtle("Cancelled."));
      return null;
    }
    throw err;
  }
}
// stripTrailingSlash lives in the leaf server-http.mjs (single definition);
// re-exported here for importers that used to reach server-check.
import { stripTrailingSlash as normalizeUrl } from "./server-http.mjs";
export { stripTrailingSlash } from "./server-http.mjs";

/** Check if an OpenAI-compatible server is responding at the given base URL. */
export async function serverReady(baseUrl) {
  try {
    const response = await fetch(`${normalizeUrl(baseUrl)}/models`, { signal: AbortSignal.timeout(2000) });
    return response.ok;
  } catch {
    return false;
  }
}
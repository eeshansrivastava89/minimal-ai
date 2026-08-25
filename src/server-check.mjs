/** Strip all trailing slashes from a URL. Single helper shared with
 *  server-status.mjs so baseUrl normalization is consistent (a baseUrl like
 *  `http://localhost:8080//` used to be handled differently across callers —
 *  serverReady stripped one slash, serverModelIds stripped all). (M4) */
export function stripTrailingSlash(url) {
  return String(url).replace(/\/+$/u, "");
}

/** Check if an OpenAI-compatible server is responding at the given base URL. */
export async function serverReady(baseUrl) {
  try {
    const response = await fetch(`${stripTrailingSlash(baseUrl)}/models`, { signal: AbortSignal.timeout(2000) });
    return response.ok;
  } catch {
    return false;
  }
}
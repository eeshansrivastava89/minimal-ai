/** Check if an OpenAI-compatible server is responding at the given base URL. */
export async function serverReady(baseUrl) {
  try {
    const response = await fetch(`${baseUrl.replace(/\/$/, "")}/models`, { signal: AbortSignal.timeout(2000) });
    return response.ok;
  } catch {
    return false;
  }
}
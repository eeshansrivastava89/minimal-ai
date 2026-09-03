import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import type { OmlxModel } from "./types.ts";

const DEFAULT_BASE_URL = "http://127.0.0.1:8000/v1";
const DEFAULT_TIMEOUT_MS = 10_000;
const DEFAULT_SETTINGS_PATH = join(homedir(), ".omlx", "settings.json");

export interface OmlxRequestOptions {
  baseUrl?: string;
  apiKey?: string | false;
  settingsPath?: string | false;
  signal?: AbortSignal;
  timeoutMs?: number;
}

export interface OmlxConnectionResult {
  ok: boolean;
  baseUrl: string;
  error?: string;
}

interface ModelsResponse {
  data?: unknown;
}

export function normalizeOmlxBaseUrl(baseUrl?: string): string {
  const raw = baseUrl?.trim() || DEFAULT_BASE_URL;
  let url: URL;

  try {
    url = new URL(raw);
  } catch (error) {
    throw new Error(`Invalid oMLX base URL "${raw}": ${formatCause(error)}`);
  }

  url.hash = "";
  url.search = "";

  const pathname = url.pathname.replace(/\/+$/u, "");
  url.pathname = pathname.length === 0 ? "/v1" : pathname;

  return url.toString().replace(/\/+$/u, "");
}

export async function checkOmlxConnection(
  baseUrl?: string,
  options: Omit<OmlxRequestOptions, "baseUrl"> = {}
): Promise<OmlxConnectionResult> {
  const normalizedBaseUrl = normalizeOmlxBaseUrl(baseUrl);

  try {
    await fetchJson(`${normalizedBaseUrl}/models`, {
      method: "GET",
      signal: options.signal,
      timeoutMs: options.timeoutMs,
      apiKey: await resolveOmlxApiKey(options),
      context: "checking oMLX connection"
    });

    return {
      ok: true,
      baseUrl: normalizedBaseUrl
    };
  } catch (error) {
    return {
      ok: false,
      baseUrl: normalizedBaseUrl,
      error: error instanceof Error ? error.message : String(error)
    };
  }
}

export async function listOmlxModels(
  baseUrl?: string,
  options: Omit<OmlxRequestOptions, "baseUrl"> = {}
): Promise<OmlxModel[]> {
  const normalizedBaseUrl = normalizeOmlxBaseUrl(baseUrl);
  const body = (await fetchJson(`${normalizedBaseUrl}/models`, {
    method: "GET",
    signal: options.signal,
    timeoutMs: options.timeoutMs,
    apiKey: await resolveOmlxApiKey(options),
    context: "listing oMLX models"
  })) as ModelsResponse;

  if (!Array.isArray(body.data)) {
    throw new Error("Malformed oMLX /models response: expected data array.");
  }

  return body.data.map((model, index) => {
    if (!isRecord(model) || typeof model.id !== "string") {
      throw new Error(
        `Malformed oMLX /models response: model at index ${index} is missing a string id.`
      );
    }

    return {
      id: model.id,
      ...(typeof model.object === "string" ? { object: model.object } : {}),
      ...(typeof model.created === "number" ? { created: model.created } : {}),
      ...(typeof model.owned_by === "string" ? { owned_by: model.owned_by } : {})
    };
  });
}

async function resolveOmlxApiKey(
  options: Omit<OmlxRequestOptions, "baseUrl">
): Promise<string | undefined> {
  if (options.apiKey === false) {
    return undefined;
  }
  if (typeof options.apiKey === "string" && options.apiKey.trim()) {
    return options.apiKey.trim();
  }
  if (process.env.OMLX_API_KEY?.trim()) {
    return process.env.OMLX_API_KEY.trim();
  }
  if (options.settingsPath === false) {
    return undefined;
  }

  const settingsPath = options.settingsPath ?? DEFAULT_SETTINGS_PATH;
  try {
    const settings = JSON.parse(await readFile(settingsPath, "utf8")) as unknown;
    if (!isRecord(settings) || !isRecord(settings.auth)) {
      return undefined;
    }
    const key = settings.auth.api_key;
    return typeof key === "string" && key.trim() ? key.trim() : undefined;
  } catch {
    return undefined;
  }
}

async function fetchJson(
  url: string,
  options: RequestInit & {
    apiKey?: string;
    context: string;
    timeoutMs?: number;
  }
): Promise<unknown> {
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const abortController = new AbortController();
  let timeoutId: ReturnType<typeof setTimeout> | undefined;
  let timedOut = false;

  const abortFromCaller = () => abortController.abort(options.signal?.reason);

  if (options.signal?.aborted) {
    throw new Error(`oMLX ${options.context} was aborted.`);
  } else {
    options.signal?.addEventListener("abort", abortFromCaller, { once: true });
  }

  if (timeoutMs > 0) {
    timeoutId = setTimeout(() => {
      timedOut = true;
      abortController.abort(new DOMException("Request timed out", "TimeoutError"));
    }, timeoutMs);
  }

  try {
    const headers = new Headers(options.headers);
    if (options.apiKey) {
      headers.set("authorization", `Bearer ${options.apiKey}`);
    }

    const response = await fetch(url, {
      ...options,
      headers,
      signal: abortController.signal
    });

    if (!response.ok) {
      const authHint = response.status === 401
        ? " Set OMLX_API_KEY or keep ~/.omlx/settings.json available to the dev server."
        : "";
      throw new Error(
        `oMLX request failed with HTTP ${response.status} ${response.statusText} while ${options.context}.${authHint}`.trim()
      );
    }

    return await response.json();
  } catch (error) {
    if (timedOut) {
      throw new Error(`oMLX ${options.context} timed out after ${timeoutMs}ms.`);
    }

    if (isAbortError(error) || abortController.signal.aborted) {
      throw new Error(`oMLX ${options.context} was aborted.`);
    }

    if (error instanceof Error && error.message.includes("HTTP ")) {
      throw error;
    }

    throw new Error(`oMLX ${options.context} network error: ${formatCause(error)}`);
  } finally {
    if (timeoutId) {
      clearTimeout(timeoutId);
    }
    options.signal?.removeEventListener("abort", abortFromCaller);
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function isAbortError(error: unknown): boolean {
  return error instanceof DOMException && error.name === "AbortError";
}

function formatCause(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }

  return String(error);
}

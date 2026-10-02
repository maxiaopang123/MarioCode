import {
  SharedProviderDiscoverInputSchema,
  SharedProviderDiscoveredModelSchema,
  type SharedProviderDiscoverInput,
  type SharedProviderDiscoveryResult,
  type SharedProviderPublic,
} from "@contracts/sharedProvider";
import { SharedProviderStore } from "@main/lib/sharedProviderStore.js";

const REQUEST_TIMEOUT_MS = 12_000;
const MAX_RESPONSE_BYTES = 2 * 1024 * 1024;
const MAX_REDIRECTS = 3;
const MAX_MODELS = 1_000;

type FetchLike = (input: string | URL, init?: RequestInit) => Promise<Response>;

export interface SharedProviderDiscoveryDeps {
  fetch?: FetchLike;
  getProvider?: (id: string) => SharedProviderPublic | null;
  resolveApiKey?: (id: string) => string | null;
  /** Test seam; production always uses REQUEST_TIMEOUT_MS. */
  timeoutMs?: number;
}

function bareHostname(url: URL): string {
  return url.hostname.toLowerCase().replace(/^\[|\]$/g, "").replace(/\.$/, "");
}

function isExplicitMetadataOrLinkLocal(hostname: string): boolean {
  const octets = hostname.split(".").map(Number);
  if (octets.length === 4 && octets.every((part) => Number.isInteger(part) && part >= 0 && part <= 255)) {
    if (octets[0] === 169 && octets[1] === 254) return true;
    if (hostname === "100.100.100.200") return true;
  }
  const firstHextet = Number.parseInt(hostname.split(":", 1)[0] ?? "", 16);
  if (hostname.includes(":") && firstHextet >= 0xfe80 && firstHextet <= 0xfebf) return true;
  if (hostname === "fd00:ec2::254") return true;
  return new Set([
    "metadata.google.internal",
    "metadata.google",
    "metadata.azure.internal",
    "metadata.aws.internal",
    "instance-data",
    "instance-data.ec2.internal",
  ]).has(hostname);
}

/** Match the HTTP(S) endpoints accepted by provider configuration, including
 * user-configured HTTP gateways. Saved-key route checks and same-origin
 * redirects protect credentials; metadata/link-local targets remain denied. */
export function validateSharedProviderDiscoveryUrl(value: string): URL {
  let parsed: URL;
  try { parsed = new URL(value); }
  catch { throw new Error("Model discovery requires a valid HTTP(S) endpoint; you can still add model IDs manually"); }
  if ((parsed.protocol !== "http:" && parsed.protocol !== "https:")
    || parsed.username !== ""
    || parsed.password !== ""
    || parsed.search !== ""
    || parsed.hash !== "") {
    throw new Error("Model discovery requires an HTTP(S) URL without credentials, query, or fragment; you can still add model IDs manually");
  }
  const hostname = bareHostname(parsed);
  if (isExplicitMetadataOrLinkLocal(hostname)) {
    throw new Error("Model discovery blocks link-local and cloud metadata endpoints; you can still add model IDs manually");
  }
  return parsed;
}

function comparableUrl(value: string): string {
  const parsed = validateSharedProviderDiscoveryUrl(value);
  parsed.pathname = parsed.pathname.replace(/\/+$/, "") || "/";
  return parsed.toString();
}

/** Infer the commonly implemented model-list endpoint without mutating the
 * supplied base URL. An explicit endpoint remains available for gateways that
 * do not expose models beside their request endpoint. */
export function resolveSharedProviderModelsUrl(input: Pick<SharedProviderDiscoverInput, "baseUrl" | "protocol" | "modelsEndpoint">): URL {
  if (input.modelsEndpoint) return validateSharedProviderDiscoveryUrl(input.modelsEndpoint);

  const url = validateSharedProviderDiscoveryUrl(input.baseUrl);
  let path = url.pathname.replace(/\/+$/, "");
  path = path.replace(/\/(?:chat\/completions|responses|messages)$/i, "");
  if (!/\/models$/i.test(path)) path = `${path || "/v1"}/models`;
  url.pathname = path.replace(/\/{2,}/g, "/");
  return url;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function nonEmptyString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

/** Parse the two model-list envelopes used by OpenAI-compatible gateways.
 * Invalid rows are ignored, while duplicate ids keep the first occurrence. */
export function parseSharedProviderModels(payload: unknown): SharedProviderDiscoveryResult {
  const root = asRecord(payload);
  const rows = Array.isArray(root?.data) ? root.data : Array.isArray(root?.models) ? root.models : null;
  if (!rows) throw new Error("Model-list response must contain a data[] or models[] array");

  const models: SharedProviderDiscoveryResult["models"] = [];
  const seen = new Set<string>();
  let truncated = false;
  for (let index = 0; index < rows.length; index++) {
    const row = rows[index];
    const record = asRecord(row);
    if (!record) continue;
    const id = nonEmptyString(record.id) ?? nonEmptyString(record.name);
    if (!id || seen.has(id)) continue;
    const preferredLabel = nonEmptyString(record.display_name)
      ?? nonEmptyString(record.displayName)
      ?? nonEmptyString(record.name)
      ?? id;
    const candidate = SharedProviderDiscoveredModelSchema.safeParse({ id, label: preferredLabel });
    const fallback = candidate.success ? candidate : SharedProviderDiscoveredModelSchema.safeParse({ id, label: id });
    if (!fallback.success) continue;
    seen.add(id);
    models.push(fallback.data);
    if (models.length === MAX_MODELS) {
      truncated = index < rows.length - 1;
      break;
    }
  }
  if (models.length === 0) throw new Error("Model-list response contained no valid model IDs");
  const continuationKeys = ["next", "next_cursor", "nextCursor"] as const;
  const upstreamPartial = root?.has_more === true
    || root?.hasMore === true
    || continuationKeys.some((key) => root?.[key] !== undefined && root[key] !== null && root[key] !== "" && root[key] !== false);
  return { models, truncated, partial: truncated || upstreamPartial };
}

function resolveDiscoveryKey(
  input: SharedProviderDiscoverInput,
  getProvider: (id: string) => SharedProviderPublic | null,
  resolveApiKey: (id: string) => string | null,
): string {
  const temporaryKey = input.apiKey ?? "";
  if (temporaryKey.length > 0) {
    if (!temporaryKey.trim()) throw new Error("API key cannot contain only whitespace");
    return temporaryKey;
  }
  if (!input.id) throw new Error("Enter an API key to load models for an unsaved provider");

  const saved = getProvider(input.id);
  if (!saved) throw new Error("The saved provider no longer exists; enter an API key or save the draft first");
  if (!saved.protocols.includes(input.protocol)) {
    throw new Error("The selected discovery protocol differs from the saved provider; enter the API key again or save the draft first");
  }
  const savedBaseUrl = saved.endpointOverrides?.[input.protocol] ?? saved.baseUrl;
  const sameBase = comparableUrl(savedBaseUrl) === comparableUrl(input.baseUrl);
  const sameModelsEndpoint = saved.modelsEndpoint === undefined
    ? input.modelsEndpoint === undefined
    : input.modelsEndpoint !== undefined && comparableUrl(saved.modelsEndpoint) === comparableUrl(input.modelsEndpoint);
  if (!sameBase || !sameModelsEndpoint) {
    throw new Error("The endpoint has unsaved changes. Enter the API key again or save the provider before loading models");
  }
  const savedKey = resolveApiKey(saved.id);
  if (!savedKey) throw new Error("The saved API key is unavailable; enter it again before loading models");
  return savedKey;
}

function authHeaders(protocol: SharedProviderDiscoverInput["protocol"], apiKey: string): Headers {
  const headers = new Headers({ Accept: "application/json" });
  if (protocol === "anthropic") {
    headers.set("x-api-key", apiKey);
    headers.set("anthropic-version", "2023-06-01");
  } else {
    headers.set("Authorization", `Bearer ${apiKey}`);
  }
  return headers;
}

async function fetchWithoutCredentialRedirect(
  fetchFn: FetchLike,
  initialUrl: URL,
  init: RequestInit,
): Promise<Response> {
  let current = initialUrl;
  for (let redirects = 0; redirects <= MAX_REDIRECTS; redirects++) {
    const response = await fetchFn(current, { ...init, redirect: "manual" });
    if (response.status < 300 || response.status >= 400) return response;
    try { await response.body?.cancel(); } catch { /* best-effort connection cleanup */ }
    if (redirects === MAX_REDIRECTS) throw new Error(`Model discovery exceeded ${MAX_REDIRECTS} redirects`);
    const location = response.headers.get("location");
    if (!location) throw new Error(`Model discovery returned redirect status ${response.status} without a Location header`);
    let next: URL;
    try { next = validateSharedProviderDiscoveryUrl(new URL(location, current).toString()); }
    catch (error) {
      if (error instanceof Error && error.message.startsWith("Model discovery")) throw error;
      throw new Error("Model discovery returned an invalid redirect URL; you can still add model IDs manually");
    }
    if (next.origin !== current.origin) {
      throw new Error("Model discovery refused a cross-origin redirect so the API key is not sent to another host");
    }
    current = next;
  }
  throw new Error("Model discovery redirect handling failed");
}

async function readLimitedBody(response: Response): Promise<string> {
  const declared = Number(response.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > MAX_RESPONSE_BYTES) {
    try { await response.body?.cancel(); } catch { /* best-effort connection cleanup */ }
    throw new Error(`Model-list response exceeds the ${MAX_RESPONSE_BYTES / 1024 / 1024} MiB limit`);
  }
  if (!response.body) return "";
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > MAX_RESPONSE_BYTES) {
        await reader.cancel();
        throw new Error(`Model-list response exceeds the ${MAX_RESPONSE_BYTES / 1024 / 1024} MiB limit`);
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
  return new TextDecoder().decode(bytes);
}

export async function discoverSharedProviderModels(
  rawInput: SharedProviderDiscoverInput,
  deps: SharedProviderDiscoveryDeps = {},
): Promise<SharedProviderDiscoveryResult> {
  const input = SharedProviderDiscoverInputSchema.parse(rawInput);
  const apiKey = resolveDiscoveryKey(
    input,
    deps.getProvider ?? SharedProviderStore.getPublic,
    deps.resolveApiKey ?? SharedProviderStore.resolveApiKey,
  );
  const url = resolveSharedProviderModelsUrl(input);
  const timeoutMs = deps.timeoutMs ?? REQUEST_TIMEOUT_MS;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    let response: Response;
    try {
      response = await fetchWithoutCredentialRedirect(
        deps.fetch ?? fetch,
        url,
        { method: "GET", headers: authHeaders(input.protocol, apiKey), signal: controller.signal },
      );
    } catch (error) {
      if (controller.signal.aborted) throw error;
      if (error instanceof Error && error.message.startsWith("Model discovery")) throw error;
      throw new Error("Model discovery request failed. Check the endpoint, network connection, and API key");
    }
    if (!response.ok) {
      try { await response.body?.cancel(); } catch { /* best-effort connection cleanup */ }
      throw new Error(`Model discovery returned HTTP ${response.status}`);
    }
    const body = await readLimitedBody(response);
    let payload: unknown;
    try { payload = JSON.parse(body); }
    catch { throw new Error("Model-list response is not valid JSON"); }
    return parseSharedProviderModels(payload);
  } catch (error) {
    if (controller.signal.aborted) throw new Error(`Model discovery timed out after ${timeoutMs / 1_000} seconds`);
    if (input.protocol === "anthropic" && error instanceof Error) {
      throw new Error(`${error.message}. If this Anthropic-compatible service has no model-list endpoint, enter a custom models endpoint or add model IDs manually`);
    }
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

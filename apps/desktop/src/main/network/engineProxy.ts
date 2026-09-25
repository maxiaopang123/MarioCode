/**
 * The engines' network route (Settings → 网络): connect directly, follow the
 * system proxy, or use a custom proxy — applied to the Claude binary, the
 * Codex app-server and the Pi host, and to the OpenAI-protocol bridge's
 * upstream calls.
 *
 * Engine processes only learn about a proxy through env vars
 * (HTTP(S)_PROXY / NO_PROXY; the Pi host is plain Node, whose fetch honors
 * them only with NODE_USE_ENV_PROXY=1), so "system" is resolved here through
 * Chromium's resolver and handed down as env. Proxy vars already on the app's
 * own env win in "system" mode — the Claude and Codex CLIs followed them
 * before this setting existed. "Direct" strips them and sets NO_PROXY=* so a
 * client that reads the OS proxy on its own (Codex on Windows) stays direct
 * too.
 *
 * The bridge runs inside main, where Node's fetch never uses a proxy; proxied
 * upstream calls go through a Chromium session pinned to the same proxy.
 */
import { session, type Session } from "electron";
import {
  NETWORK_PROXY_SETTING_KEY,
  normalizeProxyUrl,
  parseNetworkProxySettings,
  type NetworkProxySettings,
  type NetworkProxyStatus,
} from "@contracts/ipc";
import { SettingRepo } from "@main/store/repositories.js";
import { log } from "@main/lib/logger.js";

type Env = Record<string, string | undefined>;

interface Route {
  proxyUrl: string | null;
  source: NetworkProxyStatus["source"];
  /** "direct" mode: also opt out of proxies a client would find by itself. */
  forceDirect: boolean;
}

const OWNED_VARS = ["HTTP_PROXY", "HTTPS_PROXY", "ALL_PROXY", "NO_PROXY", "NODE_USE_ENV_PROXY"];
const LOCAL_HOSTS = ["localhost", "127.0.0.1", "::1"];
/** Representative engine endpoint, for PAC-style system settings that answer per URL. */
const PROBE_URL = "https://api.anthropic.com/";

function readSettings(): NetworkProxySettings {
  return parseNetworkProxySettings(SettingRepo.get(NETWORK_PROXY_SETTING_KEY));
}

function readVar(env: Env, name: string): string | undefined {
  for (const [key, value] of Object.entries(env)) {
    if (key.toUpperCase() === name && value) return value;
  }
  return undefined;
}

function deleteVar(env: Env, name: string): void {
  for (const key of Object.keys(env)) {
    if (key.toUpperCase() === name) delete env[key];
  }
}

function writeVar(env: Env, name: string, value: string): void {
  deleteVar(env, name);
  env[name] = value;
  // Windows env names are case-insensitive; elsewhere some clients only read
  // the lowercase spelling.
  if (process.platform !== "win32") env[name.toLowerCase()] = value;
}

function envProxyUrl(env: Env): string | undefined {
  return readVar(env, "HTTPS_PROXY") ?? readVar(env, "HTTP_PROXY") ?? readVar(env, "ALL_PROXY");
}

function withLocalHosts(noProxy: string | undefined): string {
  const entries = (noProxy ?? "").split(",").map((s) => s.trim()).filter(Boolean);
  for (const host of LOCAL_HOSTS) if (!entries.includes(host)) entries.push(host);
  return entries.join(",");
}

let resolver: Promise<Session> | null = null;

function systemResolver(): Promise<Session> {
  resolver ??= (async () => {
    const ses = session.fromPartition("mcode-network-resolver");
    await ses.setProxy({ mode: "system" });
    return ses;
  })().catch((err: unknown) => {
    resolver = null;
    throw err;
  });
  return resolver;
}

/** The OS proxy for `url` as an http(s) URL; null for DIRECT, and for SOCKS
 *  rules, which the engines' env proxies can't speak. */
async function resolveSystemProxy(url: string): Promise<string | null> {
  try {
    const rule = (await (await systemResolver()).resolveProxy(url)).split(";")[0]?.trim() ?? "";
    const match = /^(PROXY|HTTPS)\s+(\S+)$/i.exec(rule);
    if (!match) return null;
    return `${match[1]!.toUpperCase() === "HTTPS" ? "https" : "http"}://${match[2]}`;
  } catch (err) {
    log.warn(`network: system proxy lookup failed: ${err instanceof Error ? err.message : String(err)}`);
    return null;
  }
}

async function resolveRoute(settings: NetworkProxySettings, url = PROBE_URL): Promise<Route> {
  if (settings.mode === "direct") return { proxyUrl: null, source: null, forceDirect: true };
  if (settings.mode === "custom") {
    const custom = normalizeProxyUrl(settings.customUrl);
    if (custom) return { proxyUrl: custom, source: "custom", forceDirect: false };
    log.warn(`network: invalid custom proxy ${JSON.stringify(settings.customUrl)}; following the system proxy`);
  }
  const inherited = envProxyUrl(process.env);
  if (inherited) return { proxyUrl: inherited, source: "env", forceDirect: false };
  const system = await resolveSystemProxy(url);
  return { proxyUrl: system, source: system ? "system" : null, forceDirect: false };
}

function applyRoute<T extends Env>(env: T, route: Route): T {
  const out: Env = { ...env };
  if (route.source === "env") {
    // The app's own proxy vars stay; Node (the Pi host) needs the opt-in to
    // honor them, and local endpoints (the bridge, Ollama…) must bypass them.
    out.NODE_USE_ENV_PROXY = "1";
    writeVar(out, "NO_PROXY", withLocalHosts(readVar(out, "NO_PROXY")));
    return out as T;
  }
  const inheritedNoProxy = readVar(out, "NO_PROXY");
  for (const name of OWNED_VARS) deleteVar(out, name);
  if (route.forceDirect) {
    writeVar(out, "NO_PROXY", "*");
  } else if (route.proxyUrl) {
    writeVar(out, "HTTPS_PROXY", route.proxyUrl);
    writeVar(out, "HTTP_PROXY", route.proxyUrl);
    writeVar(out, "NO_PROXY", withLocalHosts(inheritedNoProxy));
    out.NODE_USE_ENV_PROXY = "1";
  } else if (inheritedNoProxy) {
    writeVar(out, "NO_PROXY", inheritedNoProxy);
  }
  return out as T;
}

/** `env` with the proxy vars the network setting owns applied — for every
 *  engine process spawn. */
export async function withEngineNetworkEnv<T extends Env>(env: T): Promise<T> {
  return applyRoute(env, await resolveRoute(readSettings()));
}

/** The proxy-related part of an engine env, to spot a route change on a
 *  long-lived engine process. */
export function networkFingerprint(env: Env): string {
  return OWNED_VARS.map((name) => readVar(env, name) ?? "").join("\u0000");
}

export async function engineProxyStatus(): Promise<NetworkProxyStatus> {
  const settings = readSettings();
  const { proxyUrl, source } = await resolveRoute(settings);
  return { mode: settings.mode, proxyUrl, source };
}

let proxied: { proxyUrl: string; ready: Promise<Session> } | null = null;

function proxiedSession(proxyUrl: string): Promise<Session> {
  if (proxied?.proxyUrl !== proxyUrl) {
    const ses = session.fromPartition("mcode-network-proxied");
    const ready = ses
      .setProxy({ proxyRules: proxyUrl, proxyBypassRules: "<local>" })
      .then(() => ses)
      .catch((err: unknown) => {
        if (proxied?.ready === ready) proxied = null;
        throw err;
      });
    proxied = { proxyUrl, ready };
  }
  return proxied.ready;
}

/**
 * fetch for the bridge's upstream calls: Node's fetch when the route is
 * direct (its undici error codes feed the bridge's retry logic), otherwise
 * Chromium's network stack on a session pinned to the route's proxy.
 */
export async function engineFetch(url: string, init: RequestInit): Promise<Response> {
  const route = await resolveRoute(readSettings(), url);
  if (!route.proxyUrl) return fetch(url, init);
  return (await proxiedSession(route.proxyUrl)).fetch(url, init);
}

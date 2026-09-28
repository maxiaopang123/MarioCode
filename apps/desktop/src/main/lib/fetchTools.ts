/**
 * Process-based fetch helpers: git clone / file download / zip extraction.
 *
 * Moved out of the (removed) plugin manager so other features (e.g. a future
 * skills marketplace) can reuse the proxy-aware transport. Electron-free.
 */
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";

const GIT_TIMEOUT_MS = 120_000;
/** Archive downloads are one shot per install and can be tens of MB on a slow
 *  link — generous, but bounded so a stalled socket cannot hold the install
 *  (and the panel's busy state) forever. */
const DOWNLOAD_TIMEOUT_MS = 300_000;

/* ── Process helpers (git / unzip) ── */

export interface SpawnResult {
  ok: boolean;
  message: string;
}

export interface RunOpts {
  cwd?: string;
  timeoutMs?: number;
  /** Spawn WITHOUT the proxy env vars (http(s)_proxy / ALL_PROXY) — used by
   *  gitClone's proxy-bypass retry so curl can't fall back to them. */
  noProxyEnv?: boolean;
}

const PROXY_ENV_RE = /^(https?_proxy|all_proxy)$/i;

export function runCommand(
  cmd: string,
  args: string[],
  opts: RunOpts = {},
): Promise<SpawnResult> {
  return new Promise((resolve) => {
    const env = opts.noProxyEnv
      ? Object.fromEntries(
          Object.entries(process.env).filter(([k]) => !PROXY_ENV_RE.test(k)),
        )
      : undefined;
    const child = spawn(cmd, args, { cwd: opts.cwd, windowsHide: true, env });
    let tail = "";
    let settled = false;
    const finish = (r: SpawnResult) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(r);
    };
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      finish({ ok: false, message: `${cmd} 超时(${Math.round((opts.timeoutMs ?? 30_000) / 1000)}s)` });
    }, opts.timeoutMs ?? 30_000);
    const feed = (buf: Buffer) => {
      tail = (tail + buf.toString("utf-8")).slice(-2000);
    };
    child.stdout?.on("data", feed);
    child.stderr?.on("data", feed);
    child.on("error", (err) => finish({ ok: false, message: `${cmd} 无法启动:${err.message}` }));
    child.on("close", (code) =>
      finish(
        code === 0
          ? { ok: true, message: "" }
          : { ok: false, message: `${cmd} 退出码 ${code}:${tail.trim().slice(-400) || "(无输出)"}` },
      ),
    );
  });
}

/** curl's message when a configured proxy refuses the connection — the
 *  "proxy app is configured but not running" signature. Only this failure
 *  justifies bypassing the user's proxy: a RUNNING proxy that fails for
 *  auth/DNS/timeout reasons must stay in the path (it may be the only route
 *  to GitHub, and bypassing it would silently leak the request direct). */
const PROXY_REFUSED_RE = /Failed to connect to (?:127\.0\.0\.1|localhost|\[?::1\]?)\s*port/i;

/** Shallow-clone a git repo into `dest` (which must not exist).
 *
 *  Proxy fallback: Mcode spawns git with the inherited environment, so a
 *  machine whose git config / shell env points at a currently-dead local
 *  proxy (Clash/v2ray off — "Failed to connect to 127.0.0.1 port 7897") fails
 *  on the very first hop. When — and only when — the failure is a proxy
 *  connect-refused, retry once with proxies stripped: command-line `-c
 *  http.proxy=` overrides git config files, and the cleaned env stops curl's
 *  env-var fallback. */
export async function gitClone(url: string, dest: string, ref?: string): Promise<void> {
  const baseArgs = ["clone", "--depth", "1", "--quiet"];
  if (ref) baseArgs.push("--branch", ref);
  baseArgs.push(url, dest);
  const direct = await runCommand("git", baseArgs, { timeoutMs: GIT_TIMEOUT_MS });
  if (direct.ok) return;
  if (!PROXY_REFUSED_RE.test(direct.message)) {
    throw new Error(`git clone 失败:${direct.message}`);
  }
  const bypass = await runCommand(
    "git",
    ["-c", "http.proxy=", "-c", "https.proxy=", ...baseArgs],
    { timeoutMs: GIT_TIMEOUT_MS, noProxyEnv: true },
  );
  if (!bypass.ok) {
    throw new Error(
      `git clone 失败(代理不可用,绕过代理直连也失败):${bypass.message}。若 GitHub 需要代理访问,请先开启代理软件再重试。`,
    );
  }
}

/** Node's fetch/undici collapses EVERY network failure into the bare string
 *  "fetch failed" — the actionable part (ECONNREFUSED to a proxy port,
 *  ENOTFOUND, TLS/cert errors) hangs off `cause`. Walk the chain so the panel
 *  shows something a user can act on. */
export function describeFetchError(err: unknown): string {
  const parts: string[] = [];
  let cur: unknown = err;
  for (let depth = 0; depth < 4 && cur instanceof Error; depth++) {
    if (cur.message) parts.push(cur.message);
    cur = (cur as { cause?: unknown }).cause;
  }
  return parts.join(" ← ") || String(err);
}

/** Last-resort transport when the platform has no curl: node's fetch. Ignores
 *  the proxy environment entirely (undici does not read it), which is exactly
 *  why curl goes first. */
async function downloadViaFetch(url: string, dest: string): Promise<void> {
  try {
    const res = await fetch(url, { redirect: "follow" });
    if (!res.ok || !res.body) throw new Error(`HTTP ${res.status}`);
    await fs.writeFile(dest, Buffer.from(await res.arrayBuffer()));
  } catch (err) {
    throw new Error(
      `下载失败:${describeFetchError(err)}(${url})。若该地址需要代理访问,请先开启代理软件再重试。`,
    );
  }
}

/** Download `url` into `dest` (marketplace zip entries: `{source:"url"}` —
 *  152 of the official catalog's 292 entries, so this path is not exotic).
 *
 *  Transport is curl for the same reason gitClone uses git: it resolves
 *  proxies the way the rest of the machine does, and — the part undici's fetch
 *  cannot do — it can be re-run with the proxy env stripped. On a machine whose
 *  shell/git point at a currently-dead local proxy, `fetch` dies on the first
 *  hop (as the useless "fetch failed") while a git clone of the SAME host
 *  succeeds via the bypass; zip installs must not be the one path that fails
 *  there. Same rule as gitClone for when to bypass: only a proxy
 *  connect-refused, never a running proxy that failed for auth/DNS reasons.
 *
 *  Order: curl (inherited env) → curl (proxies stripped) → node fetch (only
 *  when curl is missing, e.g. a minimal Linux image). */
export async function downloadFile(url: string, dest: string): Promise<void> {
  const args = [
    "-fL",
    "--silent",
    "--show-error",
    "--retry",
    "2",
    "--connect-timeout",
    "15",
    "-o",
    dest,
    url,
  ];
  const first = await runCommand("curl", args, { timeoutMs: DOWNLOAD_TIMEOUT_MS });
  if (first.ok) return;
  // runCommand reports a missing binary as "<cmd> 无法启动: …" (spawn ENOENT).
  if (/无法启动/.test(first.message)) return downloadViaFetch(url, dest);
  if (!PROXY_REFUSED_RE.test(first.message)) throw new Error(`下载失败:${first.message}`);
  const bypass = await runCommand("curl", args, {
    timeoutMs: DOWNLOAD_TIMEOUT_MS,
    noProxyEnv: true,
  });
  if (bypass.ok) return;
  throw new Error(
    `下载失败(代理不可用,绕过代理直连也失败):${bypass.message}。若该地址需要代理访问,请先开启代理软件再重试。`,
  );
}

/** GNU tar's message when `C:\...` is misread as a remote `host:file` target
 *  (an MSYS/Git Bash tar sitting ahead of System32's bsdtar in PATH). */
const TAR_REMOTE_HOST_RE = /Cannot connect to .* resolve failed/i;
/** Extract a .zip via the platform tool. bsdtar (macOS / Windows 10+) reads
 *  zip natively; Linux GNU tar doesn't, so unzip is the fallback there.
 *
 *  win32 discipline: PATH can surface an MSYS/Git Bash GNU tar before the
 *  system bsdtar, and GNU tar misreads `C:\...` as a remote target — so prefer
 *  the System32 bsdtar explicitly, and when a PATH tar fails with exactly that
 *  remote-host signature, retry once with `--force-local` (GNU tar's own
 *  opt-in for colon paths; a healthy bsdtar never needs the retry). */
export async function extractZip(zipPath: string, dest: string): Promise<void> {
  if (process.platform === "win32") {
    const systemTar = path.join(process.env.SystemRoot ?? "C:\\Windows", "System32", "tar.exe");
    const tarBin = existsSync(systemTar) ? systemTar : "tar";
    let viaTar = await runCommand(tarBin, ["-xf", zipPath, "-C", dest], { timeoutMs: 60_000 });
    if (!viaTar.ok && TAR_REMOTE_HOST_RE.test(viaTar.message)) {
      viaTar = await runCommand(tarBin, ["--force-local", "-xf", zipPath, "-C", dest], { timeoutMs: 60_000 });
    }
    if (viaTar.ok) return;
    throw new Error(`zip 解压失败:${viaTar.message}`);
  }
  const viaTar = await runCommand("tar", ["-xf", zipPath, "-C", dest], { timeoutMs: 60_000 });
  if (viaTar.ok) return;
  if (process.platform === "linux") {
    const viaUnzip = await runCommand("unzip", ["-oq", zipPath, "-d", dest], { timeoutMs: 60_000 });
    if (viaUnzip.ok) return;
    throw new Error(`zip 解压失败:${viaUnzip.message}`);
  }
  throw new Error(`zip 解压失败:${viaTar.message}`);
}

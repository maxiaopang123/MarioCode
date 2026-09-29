/**
 * Hidden-window page loading for the built-in web tools: mario_web_search's
 * browser backends (Bing / Baidu result pages) and mario_web_fetch. A real Chromium
 * page means JS-rendered sites read the same as static ones, with no HTML
 * parser dependency in main.
 *
 * Isolation: an in-memory partition of its own — never the panel browser's
 * session, so the agent's background reads carry none of the user's logins
 * and leave no cookies behind; downloads, popups and permission prompts are
 * refused. The session follows Settings → 网络 like the engines do. At most
 * MAX_PAGES windows exist at once; each is destroyed after its read.
 */
import { BrowserWindow, session, type Session, type WebContents } from "electron";
import { applyEngineRouteToSession } from "@main/network/engineProxy.js";

const PARTITION = "mariocode-webtools";
const MAX_PAGES = 3;

let toolsSession: Session | null = null;
/** webContents ids whose main-frame navigation turned into a download. */
const downloadBlocked = new Set<number>();

function getToolsSession(): Session {
  if (toolsSession) return toolsSession;
  const ses = session.fromPartition(PARTITION);
  // Chrome's UA without the trailing app / Electron tokens, which some sites
  // (search engines included) answer with a stripped-down or refusal page.
  const ua = /^(.*?Safari\/[\d.]+)/.exec(ses.getUserAgent())?.[1];
  if (ua) ses.setUserAgent(ua);
  ses.setPermissionRequestHandler((_wc, _permission, callback) => callback(false));
  ses.on("will-download", (event, _item, wc) => {
    event.preventDefault();
    if (wc) downloadBlocked.add(wc.id);
  });
  toolsSession = ses;
  return ses;
}

let active = 0;
const waiters: Array<() => void> = [];

async function acquire(): Promise<void> {
  if (active < MAX_PAGES) {
    active++;
    return;
  }
  await new Promise<void>((resolve) => waiters.push(resolve));
}

function release(): void {
  const next = waiters.shift();
  if (next) next();
  else active--;
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/** Run a script in the page's main frame right away. `webContents.
 *  executeJavaScript` would first wait for the whole load to stop — minutes on
 *  a page with a hanging tracker. */
export function evalInPage<T>(wc: WebContents, code: string): Promise<T> {
  return wc.mainFrame.executeJavaScript(code, true) as Promise<T>;
}

/** After DOM ready, how long a still-loading page gets before it's read anyway. */
const LOAD_GRACE_MS = 3_000;

export interface HiddenPageOptions {
  /** Give up when the DOM isn't ready after this long (default 20s). Once it
   *  is, the rest of the load gets LOAD_GRACE_MS — slow trackers shouldn't
   *  hold a read hostage. */
  timeoutMs?: number;
  /** Wait after load before reading, for client-side rendering (default 500ms). */
  settleMs?: number;
  /** Also poll until the body text length stops changing (≤ ~2.4s more). */
  waitForStableText?: boolean;
}

/**
 * Load `url` in a hidden window, run `read` against its webContents, destroy
 * the window. Throws an Error with a model-readable message when the page
 * can't be loaded (network error, timeout before DOM ready, a download).
 */
export async function withHiddenPage<T>(
  url: string,
  read: (wc: WebContents) => Promise<T>,
  opts: HiddenPageOptions = {},
): Promise<T> {
  const ses = getToolsSession();
  await applyEngineRouteToSession(ses);
  await acquire();
  const win = new BrowserWindow({
    show: false,
    width: 1280,
    height: 900,
    webPreferences: {
      session: ses,
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
      images: false,
      spellcheck: false,
      backgroundThrottling: false,
    },
  });
  const wc = win.webContents;
  try {
    wc.setAudioMuted(true);
    wc.setWindowOpenHandler(() => ({ action: "deny" }));
    let domReady = false;
    let failure: string | null = null;
    const domReadyEvent = new Promise<"dom">((resolve) =>
      wc.once("dom-ready", () => {
        domReady = true;
        resolve("dom");
      }),
    );
    wc.on("did-fail-load", (_event, code, description, _url, isMainFrame) => {
      // -3 (ERR_ABORTED) is what a redirect-then-replace or a download looks
      // like; the load promise below reports the real outcome.
      if (isMainFrame && code !== -3) failure = `${description} (${code})`;
    });
    const timeoutMs = opts.timeoutMs ?? 20_000;
    const loaded = win.loadURL(url).then(
      () => "loaded" as const,
      () => "failed" as const,
    );
    const first = await Promise.race([loaded, domReadyEvent, sleep(timeoutMs).then(() => "timeout" as const)]);
    if (downloadBlocked.delete(wc.id)) {
      throw new Error("这个链接是文件下载,不是网页;mario_web_fetch 只读网页正文");
    }
    if (!domReady) {
      if (first === "timeout") throw new Error(`页面加载超时(${Math.round(timeoutMs / 1000)} 秒)`);
      if (first === "failed") throw new Error(`页面加载失败${failure ? `:${failure}` : ""}`);
    }
    if (first !== "loaded") await Promise.race([loaded, sleep(LOAD_GRACE_MS)]);
    await sleep(opts.settleMs ?? 500);
    if (opts.waitForStableText) {
      let previous = -1;
      for (let i = 0; i < 6; i++) {
        const length = await evalInPage<number>(wc, "document.body ? document.body.innerText.length : 0");
        if (length > 0 && length === previous) break;
        previous = length;
        await sleep(400);
      }
    }
    return await read(wc);
  } finally {
    downloadBlocked.delete(wc.id);
    win.destroy();
    release();
  }
}

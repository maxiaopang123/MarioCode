import { app, Menu, session } from "electron";
import { stopSshBroker } from "@main/mcp/sshBroker.js";
import { createMainWindow, getMainWindow, sendToRenderer } from "@main/window.js";
import { initTray, destroyTray } from "@main/tray.js";
import { isQuitting, markQuitting } from "@main/lib/quitState.js";
import { registerIpcHandlers } from "@main/ipc/index.js";
import { initDb, closeDb, awaitDb } from "@main/store/db.js";
import { initTheme } from "@main/lib/theme.js";
import { TerminalManager } from "@main/terminal/TerminalManager.js";
import { BridgeRegistry } from "@main/providers/bridge/bridgeRegistry.js";
import { lspManager } from "@main/lsp/LspManager.js";
import { BrowserManager, applyAgentHostFlags } from "@main/browser/BrowserManager.js";
import { startMobileServer, stopMobileServer } from "@main/mobile/MobileHttpServer.js";
import { relayManager } from "@main/relay/RelayManager.js";
import { RELAY_AUTO_START_SETTING_KEY } from "@contracts/relay";
import { IPC } from "@contracts/ipc";
import { SettingRepo } from "@main/store/repositories.js";
import { initUpdater } from "@main/updater.js";
import { initAutoArchiver } from "@main/session/AutoArchiver.js";
import { notificationManager } from "@main/notifications/NotificationManager.js";
import { ProgressCapsule } from "@main/progress/ProgressCapsule.js";
import { runtimeManager } from "@main/claude/RuntimeManager.js";
import { is } from "@main/utils.js";
import { preloadClaudeSdk } from "@main/providers/claude-sdk/ClaudeAgentSdkProvider.js";
import { logStartup } from "@main/lib/startupTimer.js";
import { log } from "@main/lib/logger.js";
import { schedulerService } from "@main/scheduler/SchedulerService.js";
import { clawBotService } from "@main/clawbot/ClawBotService.js";
import { clawBotChatGateway } from "@main/clawbot/ClawBotChatGateway.js";
import { setManagedRuntimeRoot } from "@main/runtimes/managedRuntimeRoots.js";
import { warmRuntimeDiscovery } from "@main/runtimes/runtimeSelection.js";
import { startSkillSyncEngine, setSkillSyncChangeListener } from "@main/lib/skillSync.js";
import { startMcpSyncEngine, setMcpSyncChangeListener } from "@main/lib/mcpSync.js";
import { join } from "node:path";
import { HTML_PREVIEW_SCHEME, registerHtmlPreviewScheme, registerHtmlPreviewProtocol } from "@main/lib/htmlPreview.js";

registerHtmlPreviewScheme();

let clawBotStartupPromise: Promise<void> | null = null;
let clawBotQuitRequested = false;
const progressCapsule = new ProgressCapsule(runtimeManager, {
  preloadPath: join(__dirname, "../preload/progressCapsule.mjs"),
  rendererFile: join(__dirname, "../renderer/capsule.html"),
  devUrl: process.env.ELECTRON_RENDERER_URL ? `${process.env.ELECTRON_RENDERER_URL}/capsule.html` : undefined,
  focusSession: (sessionId) => {
    const win = getMainWindow();
    if (!win || win.isDestroyed()) return;
    if (win.isMinimized()) win.restore();
    win.show(); win.focus();
    sendToRenderer(IPC.NOTIFICATION_FOCUS_SESSION, { channel: IPC.NOTIFICATION_FOCUS_SESSION, sessionId });
  },
});

// App identity for OS-level surfaces (desktop notifications, taskbar grouping,
// Windows AUMID). setName("MarioCode") makes the system notification card title
// read "MarioCode" instead of the raw executable name ("electron" in dev, or
// "@mariocode/desktop" from package.json).
//
// ⚠️ setName() ALSO changes the default userData path (%APPDATA%/<name>).
// Packaged builds pin userData to %APPDATA%/MarioCode explicitly; development
// keeps Electron's default (derived from the package name, @mariocode/desktop)
// so dev and packaged data never mix.
const prevUserData = app.isPackaged
  ? join(app.getPath("appData"), "MarioCode")
  : app.getPath("userData");
applyAgentHostFlags();
app.setName("MarioCode");
app.setPath("userData", prevUserData);
// Managed agent runtimes (claude/codex/pi download-on-demand) live under
// userData/runtimes. Register the root early so the binary/library resolvers
// can find installed runtimes from the very first turn.
setManagedRuntimeRoot(join(app.getPath("userData"), "runtimes"));
// Windows: AppUserModelId drives taskbar grouping + the AUMID the toast center
// uses to attribute notifications. Harmless on macOS/Linux (ignored).
if (process.platform === "win32") {
  app.setAppUserModelId("MarioCode");
}

// Global exception handlers — install BEFORE anything else. Without these, an
// uncaughtException (e.g. from `new BrowserWindow`, or a require() of a native
// module that fails to load) or an unhandledRejection (from the fire-and-forget
// `void initDb()` / `void initTheme()` / `void initUpdater()` below) crashes
// the main process silently. In a packaged build that looks exactly like "the
// app starts in the background but no window ever appears": the window is
// created with show:false and the ready-to-show -> show() path never completes
// because the process is already dying. These handlers log the cause to
// main.log so the failure is diagnosable instead of invisible.
// 重入保护:若 log.error 自身抛出(如 stderr 管道断裂 EPIPE),重入这些 handler
// 会递归到栈溢出(0xC0000409 STATUS_STACK_BUFFER_OVERRUN)。两个 handler 共用同一
// flag,因为两者都调 log.error。
let handlingGlobalError = false;
process.on("uncaughtException", (err) => {
  if (handlingGlobalError) return;
  handlingGlobalError = true;
  try {
    log.error(`uncaughtException: ${err.stack ?? err}`);
  } finally {
    handlingGlobalError = false;
  }
});
process.on("unhandledRejection", (reason) => {
  if (handlingGlobalError) return;
  handlingGlobalError = true;
  try {
    log.error(`unhandledRejection: ${reason instanceof Error ? reason.stack ?? reason : String(reason)}`);
  } finally {
    handlingGlobalError = false;
  }
});

// Single-instance lock - only one GUI instance runs at a time.
const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
  process.exit(0);
}

app.on("second-instance", () => {
  // Someone tried to run a second instance — surface our existing window.
  // Target the MAIN window explicitly: getAllWindows() also returns the
  // hidden web-tools scraping windows (tools/webPage.ts), and popping one of
  // those up left the real window unfocused.
  const win = getMainWindow();
  if (win && !win.isDestroyed()) {
    if (win.isMinimized()) win.restore();
    // show() is essential here: the main window is created with show:false
    // and only revealed on ready-to-show. If the first launch's renderer is
    // still loading (or stalled), the window may still be hidden, and bare
    // focus() does NOT make a hidden window visible — so the user would see
    // "clicking the shortcut does nothing" even though the process is alive.
    win.show();
    win.focus();
    return;
  }
  // The user quit and immediately launched again: this process is still
  // finishing its quit (before-quit can take ~6s flushing the cookie vault
  // and stopping ClawBot) and holds the lock, so the new launch exited. Come
  // back once the quit completes instead of silently doing nothing.
  if (isQuitting()) app.relaunch();
});

app.whenReady().then(async () => {
  logStartup("whenReady entered");
  registerHtmlPreviewProtocol();

  // Kick off DB init in the background (better-sqlite3 loads its native
  // binding + opens the file + migrates). We DON'T await it - the window is
  // created next so the renderer starts loading immediately. IPC handlers
  // await `awaitDb()` internally (see ipc/index.ts), so any request that
  // arrives before the DB is ready simply queues instead of failing.
  void initDb().then(() => {
    // Legacy cleanup: the browser password vault was removed; wipe any
    // credentials older builds persisted under this key (nothing reads it
    // anymore; SettingRepo has no delete, so overwrite with an empty map).
    if (SettingRepo.get("browser.credentials")) {
      SettingRepo.set("browser.credentials", "{}");
    }
  });

  // CSP only in production - in dev, Vite injects inline HMR scripts that a
  // strict CSP would block, leaving the page blank.
  if (is.prod) {
    session.defaultSession.webRequest.onHeadersReceived((details, callback) => {
      if (details.url.startsWith(`${HTML_PREVIEW_SCHEME}:`)) { callback({ responseHeaders: details.responseHeaders }); return; }
      callback({
        responseHeaders: {
          ...details.responseHeaders,
            "Content-Security-Policy": [
            "default-src 'self'; script-src 'self' 'wasm-unsafe-eval'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; font-src 'self' data:; frame-src 'self' mariocode-preview:",
          ],
        },
      });
    });
  }

  // Apply the persisted theme preference. Fire-and-forget: initTheme() awaits
  // DB readiness internally, so the first frame uses the OS-default theme and
  // is corrected to the saved preference once the DB is ready. Only a user
  // preference that differs from the OS causes a brief first-frame flash.
  void initTheme();

  // Register IPC handlers (each awaits DB readiness before running).
  registerIpcHandlers();
  logStartup("IPC handlers registered");

  // Scheduler is intentionally app-lifetime scoped: the MVP executes while
  // MarioCode is open. It waits for SQLite before scanning for one catch-up
  // occurrence of overdue tasks.
  void awaitDb().then(() => schedulerService.start()).catch((err) =>
    log.error(`scheduler failed to start: ${(err as Error).message}`),
  );
  // External skill sync engine (TODO-004): mirror + watch enabled sources.
  setSkillSyncChangeListener(() => sendToRenderer(IPC.SKILLS_SYNC_CHANGED, {}));
  void awaitDb().then(() => startSkillSyncEngine()).catch((err) =>
    log.error(`skill sync engine failed to start: ${(err as Error).message}`),
  );
  // External MCP config sync engine (TODO-004): watch + mirror external
  // tool configs (~/.claude.json, ~/.codex/config.toml, ...) into the user
  // config file so every provider picks them up.
  setMcpSyncChangeListener(() => sendToRenderer(IPC.MCP_SYNC_CHANGED, {}));
  void awaitDb().then(() => startMcpSyncEngine()).catch((err) =>
    log.error(`mcp sync engine failed to start: ${(err as Error).message}`),
  );
  clawBotStartupPromise = awaitDb().then(async () => {
    if (clawBotQuitRequested) return;
    await clawBotChatGateway.start(app.getPath("userData"), clawBotService);
    if (clawBotQuitRequested) return;
    await clawBotService.start();
  }).catch((err) => log.error(`ClawBot failed to start: ${(err as Error).message}`));
  void clawBotStartupPromise;

  // HTTP Basic Auth for the embedded browser: BrowserManager pushes an
  // "authRequest" event so the renderer shows a login dialog (answered via
  // the browser.authRespond RPC; credentials are used for that request only).
  // Requests not from a browser view are ignored (default cancel behavior).
  app.on("login", (event, webContents, _details, authInfo, callback) => {
    event.preventDefault();
    BrowserManager.handleLogin(
      webContents.id,
      webContents.getURL(),
      authInfo,
      callback,
    );
  });

  // Windows / Linux: replace Electron's default (hidden) application menu.
  // Its Window ▸ Close item binds Ctrl+W, and Ctrl+W is also the in-app
  // "close tab" shortcut — whenever that command was unavailable (single
  // display mode, no open tabs) the keystroke fell through to the menu,
  // closed the window and, via window-all-closed, quit the whole app. Keep
  // the Edit + View roles (clipboard / undo, reload, DevTools, zoom,
  // fullscreen) and drop the File / Window menus (Exit, Ctrl+M minimize,
  // Ctrl+W close); the native caption buttons and Alt+F4 still work. macOS
  // keeps the default menu: Cmd+W closes the window without quitting there.
  if (process.platform !== "darwin") {
    Menu.setApplicationMenu(Menu.buildFromTemplate([{ role: "editMenu" }, { role: "viewMenu" }]));
  }

  // Create the window immediately - don't wait for DB init to finish. The
  // renderer starts loading its JS/HMR while the DB opens in parallel.
  createMainWindow();
  logStartup("createMainWindow returned");
  // Windows / Linux: tray icon + ✕ hides to the tray instead of quitting.
  initTray();

  // Warm the Claude Agent SDK module in idle time (deferred 3s). Keeps the
  // large module out of startup AND out of the first turn's send→first-reply
  // critical path. Fire-and-forget; failures surface on real first use.
  preloadClaudeSdk();

  // Warm the local-install discovery cache so AUTO runtime mode can pick an
  // existing claude/codex/pi install on the very first turn (fire-and-forget).
  warmRuntimeDiscovery();

  // Start the auto-updater (no-op in dev; only active in packaged builds).
  // Fire-and-forget: the first check is delayed 10s anyway, and the updater
  // module is lazy-loaded, so this never blocks window creation.
  void initUpdater();

  // Start the session auto-archiver. Fire-and-forget: the first pass is
  // delayed 60s and awaits DB readiness internally, so this never blocks
  // window creation.
  initAutoArchiver();

  // Start the notification system. Fire-and-forget: it awaits DB readiness
  // internally (to load prefs), then attaches its event observer to the
  // RuntimeManager. Until the observer attaches, events are simply not
  // observed (no notification) - safe to race with window creation.
  void (async () => {
    try {
      await awaitDb();
      notificationManager.start();
      if (!isQuitting()) progressCapsule.start();
    } catch (err) {
      log.error(`NotificationManager failed to start: ${(err as Error).message}`);
    }
  })();

  // Start the mobile companion HTTP server (LAN-facing). Fire-and-forget: it
  // awaits DB readiness internally to read its enabled/port settings, then
  // binds 0.0.0.0:<port>. If disabled (mobile.enabled=0) it resolves to an
  // idle handle — safe no-op. Failure to bind (port in use) is logged but
  // never blocks the app. When "start remote access on launch" is enabled and
  // a VPS config exists, auto-connect the relay tunnel right after the mobile
  // server is up (the relay forwards into it).
  void (async () => {
    try {
      await startMobileServer();
      await maybeAutoStartRelay();
    } catch (err) {
      log.error(`mobile server failed to start: ${(err as Error).message}`);
    }
  })();

  app.on("activate", () => {
    // macOS: re-create the main window when the dock icon is clicked. A
    // hidden web-tools window may still exist, so check the main window
    // itself rather than "any window".
    const win = getMainWindow();
    if (!win || win.isDestroyed()) createMainWindow();
  });
});

// Quit when all windows are closed, except on macOS.
app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});

/** If "start remote access on launch" is enabled and a VPS config exists,
 *  auto-connect the relay tunnel. Best-effort — failures are logged, never
 *  thrown (startup must not be blocked). */
async function maybeAutoStartRelay(): Promise<void> {
  try {
    const raw = SettingRepo.get(RELAY_AUTO_START_SETTING_KEY);
    if (raw !== "1") return;
    if (!relayManager.getConfig()) return;
    log.info("relay: auto-start enabled, connecting…");
    const result = await relayManager.connect();
    if (!result.ok && result.error) {
      log.warn(`relay: auto-start connect failed: ${result.error}`);
    }
  } catch (err) {
    log.warn(`relay: auto-start failed: ${(err as Error).message}`);
  }
}

// Close PTYs + bridge servers + LSP servers + browser views + DB cleanly on shutdown (best-effort).
//
// Cookie vault: before-quit does NOT wait for async work, so the first
// invocation preventDefaults, snapshots the embedded browser's cookies into
// the settings table (time-boxed so a hung cookie store can never wedge the
// quit), then re-enters quit; the second pass runs the synchronous teardown
// below (which is also what closes the DB the vault row was written to).
let sessionCookiesFlushed = false;
let clawBotStoppedForQuit = false;
app.on("before-quit", (event) => {
  stopSshBroker();
  // A real quit (tray ▸ 退出, updater install, OS session end): from here on
  // the window's close must go through instead of hiding to the tray.
  markQuitting();
  if (!sessionCookiesFlushed) {
    event.preventDefault();
    const timeout = new Promise<void>((r) => setTimeout(r, 3000).unref());
    void Promise.race([BrowserManager.saveCookieVault(), timeout]).finally(() => {
      sessionCookiesFlushed = true;
      app.quit();
    });
    return;
  }
  // ClawBot's best-effort notifystop reads its encrypted credentials from the
  // DB-backed settings store. Give it a short bounded window before closeDb;
  // a dead network can delay shutdown by at most three seconds.
  if (!clawBotStoppedForQuit) {
    event.preventDefault();
    clawBotQuitRequested = true;
    const timeout = new Promise<void>((resolve) => setTimeout(resolve, 3000).unref());
    // Stop immediately instead of chaining behind startup: if DB initialization
    // is stalled, the 3s quit deadline may close the DB first. The startup chain
    // checks clawBotQuitRequested at both await boundaries, so it cannot revive
    // either service after these stop calls.
    const gatewayStop = clawBotChatGateway.stop();
    const serviceStop = clawBotService.stop();
    const stopClawBot = Promise.allSettled([
      clawBotStartupPromise ?? Promise.resolve(),
      gatewayStop,
      serviceStop,
    ]).then(() => undefined);
    void Promise.race([stopClawBot, timeout]).finally(() => {
      clawBotStoppedForQuit = true;
      app.quit();
    });
    return;
  }
  destroyTray();
  progressCapsule.stop();
  BridgeRegistry.disposeAll();
  TerminalManager.disposeAll();
  lspManager.disposeAll();
  BrowserManager.disposeAll();
  relayManager.disposeAll();
  schedulerService.stop();
  stopMobileServer();
  closeDb();
});

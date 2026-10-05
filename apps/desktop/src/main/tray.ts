/**
 * System tray + close-to-tray (Windows / Linux, 2026-10-05).
 *
 * Clicking the window's ✕ (or Alt+F4) used to destroy the only window, and
 * `window-all-closed` then quit the whole app — killing running agent turns,
 * the scheduler, ClawBot / WeChat and the mobile server without a word. Now
 * the close is intercepted and the window just hides; the app keeps working
 * in the background and lives on as a tray icon:
 *  - left click / double click on the icon → show the window again
 *  - right click → menu: 打开 MarioCode / 退出 MarioCode
 * The first hide shows a one-time balloon so the user learns where it went
 * (persisted under TRAY_HINT_SETTING_KEY).
 *
 * A REAL quit (tray ▸ 退出, updater quitAndInstall, OS shutdown / log-off)
 * marks quitState first, and the close handler then lets the window close.
 * If the tray can't be created (missing icon, no tray host on some Linux
 * desktops) close-to-tray stays off — hiding the window with no way back
 * would strand the user, so ✕ keeps quitting there.
 *
 * macOS is untouched: closing the window there already leaves the app in
 * the dock (window-all-closed doesn't quit on darwin).
 *
 * Strings: main has no i18n dictionary, so the handful of tray strings live
 * here as a zh / en pair keyed by the same `ui.locale` setting the renderer
 * uses; the menu is rebuilt when that setting changes (refreshTrayMenu).
 */
import { app, Menu, Tray, nativeImage, type NativeImage } from "electron";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { UI_LOCALE_SETTING_KEY } from "@contracts/ipc";
import { SettingRepo } from "@main/store/repositories.js";
import { awaitDb } from "@main/store/db.js";
import { getMainWindow } from "@main/window.js";
import { isQuitting, markQuitting } from "@main/lib/quitState.js";
import { log } from "@main/lib/logger.js";

/** "1" once the first-hide balloon has been shown. Main-only flag (the
 *  renderer never reads it), so it stays out of contracts. */
const TRAY_HINT_SETTING_KEY = "ui.trayHintShown";

const STRINGS = {
  zh: {
    open: "打开 MarioCode",
    quit: "退出 MarioCode",
    hintTitle: "MarioCode 仍在后台运行",
    hintBody: "窗口已收到系统托盘,运行中的任务会继续。点击托盘图标重新打开,右键可退出。",
  },
  en: {
    open: "Open MarioCode",
    quit: "Quit MarioCode",
    hintTitle: "MarioCode is still running",
    hintBody: "The window went to the system tray and running work continues. Click the tray icon to reopen it, or right-click to quit.",
  },
} as const;

let tray: Tray | null = null;
let hintChecked = false;

function strings(): (typeof STRINGS)["zh"] | (typeof STRINGS)["en"] {
  try {
    return SettingRepo.get(UI_LOCALE_SETTING_KEY) === "en" ? STRINGS.en : STRINGS.zh;
  } catch {
    // DB not open yet — the menu is rebuilt once it is (initTray).
    return STRINGS.zh;
  }
}

/** Packaged: resources/tray-icon.* (electron-builder extraResources).
 *  Dev: the build/ tree two levels above out/main. .ico on Windows so the
 *  shell picks a crisp 16 / 20 / 24px frame for the current DPI. */
function trayIcon(): NativeImage {
  const ext = process.platform === "win32" ? "ico" : "png";
  const candidates = [
    join(process.resourcesPath, `tray-icon.${ext}`),
    join(__dirname, `../../build/icon.${ext}`),
  ];
  for (const path of candidates) {
    if (!existsSync(path)) continue;
    const img = nativeImage.createFromPath(path);
    if (!img.isEmpty()) return img;
  }
  return nativeImage.createEmpty();
}

function showMainWindow(): void {
  const win = getMainWindow();
  if (!win || win.isDestroyed()) return;
  if (win.isMinimized()) win.restore();
  win.show();
  win.focus();
}

/** (Re)build the tray menu in the current UI language. Cheap; safe to call
 *  before the tray exists (no-op). */
export function refreshTrayMenu(): void {
  if (!tray) return;
  const s = strings();
  tray.setContextMenu(
    Menu.buildFromTemplate([
      { label: s.open, click: showMainWindow },
      { type: "separator" },
      {
        label: s.quit,
        click: () => {
          markQuitting();
          app.quit();
        },
      },
    ]),
  );
}

/** One-time "it's in the tray now" balloon (Windows; a no-op elsewhere). */
function maybeShowHint(): void {
  if (hintChecked) return;
  hintChecked = true;
  try {
    if (SettingRepo.get(TRAY_HINT_SETTING_KEY) === "1") return;
    SettingRepo.set(TRAY_HINT_SETTING_KEY, "1");
  } catch {
    // DB unavailable — skip the hint rather than risk showing it every time.
    return;
  }
  if (process.platform !== "win32" || !tray) return;
  const s = strings();
  tray.displayBalloon({ title: s.hintTitle, content: s.hintBody, iconType: "info" });
}

/** Create the tray and switch the main window's ✕ to hide-to-tray. Call once,
 *  right after createMainWindow(). */
export function initTray(): void {
  if (process.platform === "darwin" || tray) return;
  const win = getMainWindow();
  if (!win) return;
  try {
    const icon = trayIcon();
    if (icon.isEmpty()) {
      log.warn("tray: icon not found — close-to-tray disabled, ✕ quits the app");
      return;
    }
    tray = new Tray(icon);
  } catch (err) {
    log.warn(`tray: creation failed (${(err as Error).message}) — close-to-tray disabled`);
    tray = null;
    return;
  }
  tray.setToolTip("MarioCode");
  tray.on("click", showMainWindow);
  tray.on("double-click", showMainWindow);
  refreshTrayMenu();
  // The first build ran before SQLite opened (Chinese default); redo it in
  // the saved language.
  void awaitDb().then(refreshTrayMenu, () => {});

  win.on("close", (event) => {
    if (isQuitting() || !tray) return;
    event.preventDefault();
    win.hide();
    maybeShowHint();
  });
  // Windows shutdown / restart / log-off: never hold the session open by
  // swallowing the close.
  win.on("session-end", () => markQuitting());
}

/** Remove the icon during teardown so Windows doesn't leave a ghost icon in
 *  the notification area until the mouse passes over it. */
export function destroyTray(): void {
  tray?.destroy();
  tray = null;
}

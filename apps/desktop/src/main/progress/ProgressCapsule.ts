import { BrowserWindow, ipcMain, screen, type IpcMainInvokeEvent, type Rectangle } from "electron";
import { z } from "zod";
import { IPC, UI_LOCALE_SETTING_KEY, ProgressCapsuleReadSchema, ProgressCapsuleOpenSchema, type ProgressCapsuleState, type ProgressCapsuleSession } from "@contracts/ipc";
import type { RuntimeEvent } from "@contracts/runtime";
import { SessionRepo, SettingRepo } from "@main/store/repositories.js";
import { log } from "@main/lib/logger.js";

const POSITION_KEY = "ui.progressCapsule.position";
const PositionSchema = z.object({ x: z.number().int().min(-1_000_000).max(1_000_000), y: z.number().int().min(-1_000_000).max(1_000_000) });
const WIDTH = 370;
const HEIGHT = 94;

export interface CapsuleRuntime {
  runningSessionIds(): string[];
  runningSessionStartedAt(sessionId: string): number | null;
  addObserver(fn: (event: RuntimeEvent) => void): () => void;
}
interface CapsuleOptions {
  preloadPath: string;
  rendererFile: string;
  devUrl?: string;
  focusSession(sessionId: string): void;
}
interface TurnState {
  startedAt: number;
  pending: Map<string, ProgressCapsuleSession["phase"]>;
}

/** Actual active turns drive visibility. Persisted session.status can be stale. */
export class ProgressCapsule {
  private window: BrowserWindow | null = null;
  private turns = new Map<string, TurnState>();
  private state: ProgressCapsuleState = { locale: "zh", sessions: [] };
  private timer: ReturnType<typeof setInterval> | null = null;
  private updateTimer: ReturnType<typeof setTimeout> | null = null;
  private moveTimer: ReturnType<typeof setTimeout> | null = null;
  private unsubscribe: (() => void) | null = null;
  private loaded = false;

  constructor(private runtime: CapsuleRuntime, private options: CapsuleOptions) {}

  start(): void {
    if (this.timer) return;
    ipcMain.handle(IPC.PROGRESS_CAPSULE_READ, (event, raw: unknown) => {
      this.checkSender(event);
      ProgressCapsuleReadSchema.parse(raw);
      return this.state;
    });
    ipcMain.handle(IPC.PROGRESS_CAPSULE_OPEN, (event, raw: unknown) => {
      this.checkSender(event);
      const { sessionId } = ProgressCapsuleOpenSchema.parse(raw);
      if (this.state.sessions.some(s => s.sessionId === sessionId) && SessionRepo.get(sessionId)) this.options.focusSession(sessionId);
    });
    this.unsubscribe = this.runtime.addObserver(event => this.observe(event));
    screen.on("display-removed", this.reposition);
    screen.on("display-metrics-changed", this.reposition);
    this.timer = setInterval(() => this.sync(), 1000);
    this.timer.unref();
    this.sync();
  }

  stop(): void {
    if (!this.timer) return;
    clearInterval(this.timer);
    this.timer = null;
    if (this.updateTimer) clearTimeout(this.updateTimer);
    if (this.moveTimer) clearTimeout(this.moveTimer);
    this.updateTimer = this.moveTimer = null;
    this.unsubscribe?.();
    this.unsubscribe = null;
    screen.removeListener("display-removed", this.reposition);
    screen.removeListener("display-metrics-changed", this.reposition);
    ipcMain.removeHandler(IPC.PROGRESS_CAPSULE_READ);
    ipcMain.removeHandler(IPC.PROGRESS_CAPSULE_OPEN);
    this.savePosition();
    this.window?.destroy();
    this.window = null;
    this.loaded = false;
    this.turns.clear();
    this.state = { locale: "zh", sessions: [] };
  }

  private checkSender(event: IpcMainInvokeEvent): void {
    if (!this.window || event.sender !== this.window.webContents || event.senderFrame !== this.window.webContents.mainFrame) throw new Error("Invalid progress window sender");
  }

  private observe(event: RuntimeEvent): void {
    if (!("sessionId" in event)) return;
    // Make the turn available before the first request arrives.
    const id = event.sessionId;
    let turn = this.turns.get(id);
    const startedAt = this.runtime.runningSessionStartedAt(id);
    if (!turn || (startedAt && turn.startedAt !== startedAt)) {
      turn = { startedAt: startedAt ?? Date.now(), pending: new Map() };
      this.turns.set(id, turn);
    }
    if (event.type === "approval.request") turn.pending.set(event.requestId, "approval");
    else if (event.type === "question.ask") turn.pending.set(event.requestId ?? "legacy-question", "question");
    else if (event.type === "plan.approval_request") turn.pending.set(event.requestId, "plan");
    else if (event.type === "request.resolved") turn.pending.delete(event.requestId);
    else if (event.type === "turn.done") turn.pending.clear();
    // Avoid a DB read for every streamed token.
    if (!this.updateTimer) this.updateTimer = setTimeout(() => { this.updateTimer = null; this.sync(); }, 100);
  }

  private sync(): void {
    try {
      const active = this.runtime.runningSessionIds();
      const sessions: ProgressCapsuleSession[] = [];
      for (const id of active) {
        const session = SessionRepo.get(id);
        if (!session) continue;
        let turn = this.turns.get(id);
        const startedAt = this.runtime.runningSessionStartedAt(id);
        if (!turn || (startedAt && startedAt !== turn.startedAt)) {
          turn = { startedAt: startedAt ?? Date.now(), pending: new Map() };
          this.turns.set(id, turn);
        }
        const todos = session.todos ?? [];
        sessions.push({ sessionId: id, title: session.title, model: session.lastUsedModel ?? null, startedAt: turn.startedAt,
          phase: [...turn.pending.values()].at(-1) ?? "running", completed: todos.filter(t => t.status === "completed").length,
          total: todos.length, task: todos.find(t => t.status === "in_progress")?.content ?? null });
      }
      for (const id of this.turns.keys()) if (!active.includes(id)) this.turns.delete(id);
      const next: ProgressCapsuleState = { locale: SettingRepo.get(UI_LOCALE_SETTING_KEY) === "en" ? "en" : "zh", sessions };
      const changed = JSON.stringify(next) !== JSON.stringify(this.state);
      this.state = next;
      if (!sessions.length) { this.window?.hide(); return; }
      if (!this.window) this.createWindow();
      if (this.loaded && this.window) {
        if (changed || !this.window.isVisible()) this.window.webContents.send(IPC.PROGRESS_CAPSULE_STATE, this.state);
        if (!this.window.isVisible()) this.window.showInactive();
      }
    } catch (error) { log.warn(`Progress capsule update failed: ${String(error)}`); }
  }

  private createWindow(): void {
    const area = screen.getPrimaryDisplay().workArea;
    let position = { x: area.x + Math.round((area.width - WIDTH) / 2), y: area.y + 18 };
    try { position = PositionSchema.parse(JSON.parse(SettingRepo.get(POSITION_KEY) ?? "null")); } catch { /* first use */ }
    const bounds = this.clamp({ ...position, width: WIDTH, height: HEIGHT });
    const win = new BrowserWindow({ ...bounds, title: "MarioCode", show: false, frame: false, transparent: true, resizable: false,
      maximizable: false, minimizable: false, fullscreenable: false, skipTaskbar: true, alwaysOnTop: true, hasShadow: false,
      // ESM preload uses the same isolated bridge configuration as the main window.
      webPreferences: { preload: this.options.preloadPath, contextIsolation: true, nodeIntegration: false, sandbox: false, backgroundThrottling: false } });
    this.window = win;
    this.loaded = false;
    win.setAlwaysOnTop(true, "floating");
    if (process.platform === "darwin") win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
    win.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
    win.webContents.on("will-navigate", event => event.preventDefault());
    win.on("move", () => {
      if (this.moveTimer) clearTimeout(this.moveTimer);
      this.moveTimer = setTimeout(() => { this.moveTimer = null; this.reposition(); this.savePosition(); }, 300);
    });
    win.on("closed", () => { if (this.window === win) { this.window = null; this.loaded = false; } });
    win.webContents.on("did-finish-load", () => {
      if (this.window !== win) return;
      this.loaded = true;
      win.webContents.send(IPC.PROGRESS_CAPSULE_STATE, this.state);
      if (this.state.sessions.length) win.showInactive();
    });
    const loading = this.options.devUrl ? win.loadURL(this.options.devUrl) : win.loadFile(this.options.rendererFile);
    void loading.catch(error => { log.warn(`Progress capsule load failed: ${String(error)}`); win.destroy(); });
  }

  private clamp(bounds: Rectangle): Rectangle {
    const area = screen.getDisplayMatching(bounds).workArea;
    return { ...bounds, x: Math.round(Math.min(Math.max(bounds.x, area.x), area.x + Math.max(0, area.width - bounds.width))),
      y: Math.round(Math.min(Math.max(bounds.y, area.y), area.y + Math.max(0, area.height - bounds.height))) };
  }

  private reposition = (): void => {
    if (!this.window) return;
    const bounds = this.window.getBounds();
    const clamped = this.clamp(bounds);
    if (bounds.x !== clamped.x || bounds.y !== clamped.y) this.window.setPosition(clamped.x, clamped.y);
  };

  private savePosition(): void {
    if (!this.window || this.window.isDestroyed()) return;
    const { x, y } = this.clamp(this.window.getBounds());
    SettingRepo.set(POSITION_KEY, JSON.stringify({ x, y }));
  }
}

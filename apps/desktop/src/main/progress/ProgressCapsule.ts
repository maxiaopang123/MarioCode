import { BrowserWindow, ipcMain, screen, type IpcMainInvokeEvent, type Rectangle } from "electron";
import { z } from "zod";
import { IPC, UI_LOCALE_SETTING_KEY, ProgressCapsuleReadSchema, ProgressCapsuleOpenSchema, ProgressCapsuleViewSchema, type ProgressCapsuleState, type ProgressCapsuleSession } from "@contracts/ipc";
import type { RuntimeEvent } from "@contracts/runtime";
import { SessionRepo, SettingRepo } from "@main/store/repositories.js";
import { log } from "@main/lib/logger.js";

const POSITION_KEY = "ui.progressCapsule.position";
const PositionSchema = z.object({ x: z.number().int().min(-1_000_000).max(1_000_000), y: z.number().int().min(-1_000_000).max(1_000_000) });
const DOCK_KEY = "ui.progressCapsule.dock";
const DockSchema = z.object({ displayId: z.number().int(), centerX: z.number().int().min(-1_000_000).max(1_000_000) });
// Windows enforces a caption-sized minimum even on frameless windows (#32302).
// Clip its drawable/input region to the rail instead of leaving an invisible blocker.
const COLLAPSED = { width: 176, height: process.platform === "darwin" ? 16 : 48 };
const EXPANDED = { width: 304, height: 86 };

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
  pending: Map<string, { phase: "approval" | "question" | "plan"; toolName: string | null }>;
  activity: "running" | "thinking" | "output";
  tools: Map<string, string>;
}

/** Actual active turns drive visibility. Persisted session.status can be stale. */
export class ProgressCapsule {
  private window: BrowserWindow | null = null;
  private turns = new Map<string, TurnState>();
  private state: ProgressCapsuleState = { locale: "zh", expanded: false, sessions: [] };
  private dock: z.infer<typeof DockSchema> | null = null;
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
      if (this.state.sessions.some(s => s.sessionId === sessionId) && SessionRepo.get(sessionId)) {
        this.setExpanded(false);
        this.options.focusSession(sessionId);
      }
    });
    ipcMain.handle(IPC.PROGRESS_CAPSULE_VIEW, (event, raw: unknown) => {
      this.checkSender(event);
      const { expanded } = ProgressCapsuleViewSchema.parse(raw);
      this.setExpanded(expanded);
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
    ipcMain.removeHandler(IPC.PROGRESS_CAPSULE_VIEW);
    this.savePosition();
    this.window?.destroy();
    this.window = null;
    this.loaded = false;
    this.turns.clear();
    this.state = { locale: "zh", expanded: false, sessions: [] };
    this.dock = null;
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
      turn = { startedAt: startedAt ?? Date.now(), pending: new Map(), activity: "running", tools: new Map() };
      this.turns.set(id, turn);
    }
    if (event.type === "approval.request") turn.pending.set(event.requestId, { phase: "approval", toolName: event.toolName });
    else if (event.type === "question.ask") turn.pending.set(event.requestId ?? "legacy-question", { phase: "question", toolName: null });
    else if (event.type === "plan.approval_request") turn.pending.set(event.requestId, { phase: "plan", toolName: null });
    else if (event.type === "request.resolved") turn.pending.delete(event.requestId);
    else if (event.type === "thinking" && event.text) turn.activity = "thinking";
    else if (event.type === "text.delta" && event.text) turn.activity = "output";
    else if (event.type === "tool.use") turn.tools.set(event.toolCallId, event.toolName);
    else if (event.type === "tool.result") { turn.tools.delete(event.toolCallId); turn.activity = "running"; }
    else if (event.type === "message.complete") turn.activity = "running";
    else if (event.type === "turn.done") { turn.pending.clear(); turn.tools.clear(); turn.activity = "running"; }
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
          turn = { startedAt: startedAt ?? Date.now(), pending: new Map(), activity: "running", tools: new Map() };
          this.turns.set(id, turn);
        }
        const todos = session.todos ?? [];
        const pending = [...turn.pending.values()].at(-1);
        sessions.push({ sessionId: id, title: session.title, model: session.lastUsedModel ?? null, startedAt: turn.startedAt,
          phase: pending?.phase ?? (turn.tools.size ? "executing" : turn.activity),
          toolName: pending ? pending.toolName : [...turn.tools.values()].at(-1) ?? null, toolCount: turn.tools.size,
          completed: todos.filter(t => t.status === "completed").length,
          total: todos.length, task: todos.find(t => t.status === "in_progress")?.content ?? null });
      }
      for (const id of this.turns.keys()) if (!active.includes(id)) this.turns.delete(id);
      const next: ProgressCapsuleState = { locale: SettingRepo.get(UI_LOCALE_SETTING_KEY) === "en" ? "en" : "zh", expanded: sessions.length > 0 && this.state.expanded, sessions };
      const changed = JSON.stringify(next) !== JSON.stringify(this.state);
      this.state = next;
      if (!sessions.length) { this.window?.hide(); this.reposition(); return; }
      if (!this.window) this.createWindow();
      if (this.loaded && this.window) {
        if (changed || !this.window.isVisible()) this.window.webContents.send(IPC.PROGRESS_CAPSULE_STATE, this.state);
        if (!this.window.isVisible()) this.window.showInactive();
      }
    } catch (error) { log.warn(`Progress capsule update failed: ${String(error)}`); }
  }

  private createWindow(): void {
    const primary = screen.getPrimaryDisplay();
    this.dock = { displayId: primary.id, centerX: primary.bounds.x + Math.round(primary.bounds.width / 2) };
    try { this.dock = DockSchema.parse(JSON.parse(SettingRepo.get(DOCK_KEY) ?? "null")); }
    catch {
      // Migrate the free-floating position to the same horizontal screen edge.
      try {
        const old = PositionSchema.parse(JSON.parse(SettingRepo.get(POSITION_KEY) ?? "null"));
        const display = screen.getDisplayMatching({ ...old, width: 370, height: 94 });
        this.dock = { displayId: display.id, centerX: old.x + 185 };
      } catch { /* first use */ }
    }
    const bounds = this.dockBounds();
    const win = new BrowserWindow({ ...bounds, title: "MarioCode", show: false, frame: false, transparent: true, resizable: false,
      maximizable: false, minimizable: false, fullscreenable: false, skipTaskbar: true, alwaysOnTop: true, hasShadow: false,
      // ESM preload uses the same isolated bridge configuration as the main window.
      webPreferences: { preload: this.options.preloadPath, contextIsolation: true, nodeIntegration: false, sandbox: false, backgroundThrottling: false } });
    this.window = win;
    this.applyShape();
    this.loaded = false;
    win.setAlwaysOnTop(true, "floating");
    if (process.platform === "darwin") win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
    win.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
    win.webContents.on("will-navigate", event => event.preventDefault());
    win.on("move", () => {
      const current = win.getBounds();
      const expected = this.dockBounds();
      // Programmatic expansion keeps the saved center, including near an edge.
      if (current.x === expected.x && current.y === expected.y) return;
      if (this.moveTimer) clearTimeout(this.moveTimer);
      this.moveTimer = setTimeout(() => {
        this.moveTimer = null;
        if (win.isDestroyed()) return;
        const moved = win.getBounds();
        this.dock = { displayId: screen.getDisplayMatching(moved).id, centerX: moved.x + Math.round(moved.width / 2) };
        this.reposition(); this.savePosition();
      }, 300);
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

  private setExpanded(expanded: boolean): void {
    this.state = { ...this.state, expanded: expanded && this.state.sessions.length > 0 };
    this.reposition();
    if (this.loaded) this.window?.webContents.send(IPC.PROGRESS_CAPSULE_STATE, this.state);
  }

  private dockBounds(): Rectangle {
    const display = screen.getAllDisplays().find(d => d.id === this.dock?.displayId) ?? screen.getPrimaryDisplay();
    const area = display.bounds;
    if (this.dock?.displayId !== display.id) this.dock = { displayId: display.id, centerX: area.x + Math.round(area.width / 2) };
    const size = this.state.expanded ? EXPANDED : COLLAPSED;
    const width = Math.min(size.width, area.width);
    const centerX = Math.min(Math.max(this.dock!.centerX, area.x + COLLAPSED.width / 2), area.x + area.width - COLLAPSED.width / 2);
    this.dock = { displayId: display.id, centerX: Math.round(centerX) };
    return { width, height: Math.min(size.height, area.height),
      x: Math.round(Math.min(Math.max(centerX - width / 2, area.x), area.x + area.width - width)), y: area.y };
  }

  private reposition = (): void => {
    if (!this.window) return;
    const bounds = this.window.getBounds();
    const docked = this.dockBounds();
    if (bounds.x !== docked.x || bounds.y !== docked.y || bounds.width !== docked.width || bounds.height !== docked.height) this.window.setBounds(docked);
    this.applyShape();
  };

  private applyShape(): void {
    if (!this.window || process.platform === "darwin") return;
    const { width } = this.window.getBounds();
    this.window.setShape(this.state.expanded ? [] : [{ x: 8, y: 0, width: Math.max(1, width - 16), height: 12 }]);
  }

  private savePosition(): void {
    if (!this.window || this.window.isDestroyed()) return;
    this.dockBounds();
    SettingRepo.set(DOCK_KEY, JSON.stringify(this.dock));
  }
}

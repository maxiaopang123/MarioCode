import { app, BrowserWindow, screen } from "electron";
import { strict as assert } from "node:assert";
import { join } from "node:path";
import { writeFileSync } from "node:fs";
import { initDb, closeDb } from "@main/store/db.js";
import { ProjectRepo, SessionRepo, SettingRepo } from "@main/store/repositories.js";
import { ProgressCapsule, type CapsuleRuntime } from "@main/progress/ProgressCapsule.js";
import type { RuntimeEvent } from "@contracts/runtime";
import type { Session } from "@contracts/session";
import type { ProgressCapsuleState } from "@contracts/ipc";

async function waitFor(test: () => boolean | Promise<boolean>): Promise<void> {
  const limit = Date.now() + 8000;
  while (!await test()) { if (Date.now() > limit) throw new Error("Capsule assertion timed out"); await new Promise(r => setTimeout(r, 100)); }
}

async function main(): Promise<void> {
  app.setPath("userData", process.env.MARIOCODE_SMOKE_DATA!);
  // Window destruction is part of this test; keep the test host alive between instances.
  app.on("window-all-closed", () => {});
  await app.whenReady();
  let capsule: ProgressCapsule | null = null;
  try {
    await initDb();
    const desktop = process.env.MARIOCODE_SMOKE_DESKTOP!;
    ProjectRepo.create({ id: "project", name: "Test", path: app.getPath("userData"), archived: false, group: null, sortOrder: 0, pinnedAt: null, createdAt: 1, updatedAt: 1 });
    const session: Session = { id: "first", projectId: "project", providerId: "claude-sdk", claudeSessionId: null, kind: "chat", parentSessionId: null, title: "测试进度 · 中文", status: "running", model: "sonnet", effort: "default", permissionMode: "default", customModelId: null, archived: false, pinnedAt: null, contextSnapshot: null, todos: null, subagents: null, planDraft: null, usageHistory: null, turnFiles: null, bookmarks: null, subagentTranscripts: null, createdAt: 1, updatedAt: 1 };
    SessionRepo.create(session);
    SessionRepo.create({ ...session, id: "second", title: "另一个运行聊天" });
    SessionRepo.recordUsedModel("first", "claude-sonnet-4-6");
    SessionRepo.updateTodos("first", [{ content: "已经完成", status: "completed", priority: "medium" }, { content: "当前任务", status: "in_progress", priority: "high" }]);
    let observer: ((event: RuntimeEvent) => void) | null = null;
    let active: string[] = [];
    let startedAt = Date.now() - 65_000;
    const runtime: CapsuleRuntime = { runningSessionIds: () => active, runningSessionStartedAt: () => startedAt,
      addObserver: fn => { observer = fn; return () => { observer = null; }; } };
    let focused = "";
    const options = { preloadPath: join(desktop, "out/preload/progressCapsule.mjs"), rendererFile: join(desktop, "out/renderer/capsule.html"), focusSession: (id: string) => { focused = id; } };
    capsule = new ProgressCapsule(runtime, options);
    capsule.start();
    assert.equal(BrowserWindow.getAllWindows().length, 0, "stale database status cannot show the capsule");
    active = ["first"];
    await waitFor(() => BrowserWindow.getAllWindows()[0]?.isVisible() ?? false);
    let win = BrowserWindow.getAllWindows()[0]!;
    assert.ok(win.isAlwaysOnTop());
    const pref = win.webContents.getLastWebPreferences();
    assert.equal(pref.nodeIntegration, false); assert.equal(pref.contextIsolation, true);
    await waitFor(() => win.webContents.executeJavaScript('document.getElementById("title").textContent === "测试进度 · 中文"'));
    assert.equal(await win.webContents.executeJavaScript('document.getElementById("progress").textContent'), "任务 1/2");
    assert.equal(await win.webContents.executeJavaScript('getComputedStyle(document.getElementById("capsule")).webkitAppRegion'), "drag");
    assert.equal(await win.webContents.executeJavaScript('getComputedStyle(document.getElementById("open")).webkitAppRegion'), "no-drag");
    const emit = (event: RuntimeEvent) => { assert.ok(observer); (observer as (e: RuntimeEvent) => void)(event); };
    emit({ type: "approval.request", sessionId: "first", requestId: "r1", toolCallId: "t1", toolName: "Write", input: {} });
    await waitFor(() => win.webContents.executeJavaScript('document.getElementById("phase").textContent === "等待工具审批"'));
    const capture = await win.webContents.capturePage();
    writeFileSync(join(desktop, ".turbo/progress-capsule-check.png"), capture.toPNG());
    emit({ type: "request.resolved", sessionId: "first", requestId: "r1", kind: "approval" });
    await waitFor(() => win.webContents.executeJavaScript('document.getElementById("phase").textContent === "正在运行"'));
    active = ["first", "second"];
    await waitFor(() => win.webContents.executeJavaScript('!document.getElementById("others").hidden'));
    await win.webContents.executeJavaScript('document.getElementById("others").click(); document.getElementById("open").click()');
    await waitFor(() => focused === "second");
    const state = await win.webContents.executeJavaScript("window.api.getState()") as ProgressCapsuleState;
    assert.equal(state.sessions.length, 2); assert.equal(state.sessions[0]?.completed, 1);
    await win.webContents.executeJavaScript('window.api.openSession("unknown")'); assert.equal(focused, "second");
    const other = new BrowserWindow({ show: false, webPreferences: { preload: options.preloadPath, nodeIntegration: false, contextIsolation: true, sandbox: false } });
    await other.loadURL("data:text/html,<html></html>");
    assert.equal(await other.webContents.executeJavaScript('window.api.getState().then(() => false, () => true)'), true, "only the private capsule window can call its IPC");
    other.destroy();
    const area = screen.getPrimaryDisplay().workArea;
    win.setPosition(area.x + 40, area.y + 50);
    await waitFor(() => SettingRepo.get("ui.progressCapsule.position") === JSON.stringify({ x: area.x + 40, y: area.y + 50 }));
    active = [];
    await waitFor(() => !win.isVisible());
    capsule.stop();
    capsule = new ProgressCapsule(runtime, options); capsule.start();
    active = ["first"]; startedAt = Date.now();
    await waitFor(() => BrowserWindow.getAllWindows()[0]?.isVisible() ?? false);
    win = BrowserWindow.getAllWindows()[0]!;
    assert.equal(win.getBounds().x, area.x + 40); assert.equal(win.getBounds().y, area.y + 50);
    SettingRepo.set("ui.locale", "en");
    await waitFor(() => win.webContents.executeJavaScript('document.getElementById("phase").textContent === "Running"'));
    capsule.stop();
    SettingRepo.set("ui.progressCapsule.position", JSON.stringify({ x: 999999, y: 999999 }));
    capsule = new ProgressCapsule(runtime, options); capsule.start();
    await waitFor(() => BrowserWindow.getAllWindows()[0]?.isVisible() ?? false);
    const bounds = BrowserWindow.getAllWindows()[0]!.getBounds();
    const work = screen.getDisplayMatching(bounds).workArea;
    assert.ok(bounds.x >= work.x && bounds.y >= work.y && bounds.x + bounds.width <= work.x + work.width && bounds.y + bounds.height <= work.y + work.height);
    console.log("PASS: native always-on-top window, real tasks, waiting/resolved, multi-chat focus, private IPC, idle hiding, position persistence/clamping and bilingual renderer");
  } catch (error) { console.error(error); process.exitCode = 1; }
  finally { capsule?.stop(); closeDb(); app.exit(process.exitCode ?? 0); }
}
void main();

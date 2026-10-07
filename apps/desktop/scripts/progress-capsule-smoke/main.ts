import { app, BrowserWindow, screen } from "electron";
import { strict as assert } from "node:assert";
import { join } from "node:path";
import { writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { initDb, closeDb } from "@main/store/db.js";
import { ProjectRepo, SessionRepo, SettingRepo } from "@main/store/repositories.js";
import { ProgressCapsule, type CapsuleRuntime } from "@main/progress/ProgressCapsule.js";
import type { RuntimeEvent } from "@contracts/runtime";
import type { Session } from "@contracts/session";
import type { ProgressCapsuleState } from "@contracts/ipc";

async function waitFor(test: () => boolean | Promise<boolean>): Promise<void> {
  const limit = Date.now() + 8000;
  while (!await test()) { if (Date.now() > limit) throw new Error("Capsule assertion timed out: " + String(test)); await new Promise(r => setTimeout(r, 100)); }
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
    SessionRepo.create({ ...session, id: "third", title: "第三个任务 · 正在思考" });
    SessionRepo.recordUsedModel("first", "claude-sonnet-4-6");
    SessionRepo.updateTodos("first", [{ content: "已经完成", status: "completed", priority: "medium" }, { content: "当前任务", status: "in_progress", priority: "high" }]);
    let observer: ((event: RuntimeEvent) => void) | null = null;
    let active: string[] = [];
    let startedAt = Date.now() - 65_000;
    const runtime: CapsuleRuntime = { runningSessionIds: () => active, runningSessionStartedAt: () => startedAt,
      addObserver: fn => { observer = fn; return () => { observer = null; }; } };
    const legacyArea = screen.getPrimaryDisplay().bounds;
    const legacyCenter = legacyArea.x + Math.min(320, Math.round(legacyArea.width / 2));
    SettingRepo.set("ui.progressCapsule.position", JSON.stringify({ x: legacyCenter - 185, y: legacyArea.y + 100 }));
    let focused = "";
    const options = { preloadPath: join(desktop, "out/preload/progressCapsule.mjs"), rendererFile: process.env.MARIOCODE_SMOKE_CAPSULE_FILE ?? join(desktop, "out/renderer/capsule.html"), focusSession: (id: string) => { focused = id; } };
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
    const display = screen.getPrimaryDisplay();
    const initial = win.getBounds();
    const collapsedHeight = process.platform === "darwin" ? 16 : 48;
    assert.equal(initial.width, 176); assert.equal(initial.height, collapsedHeight); assert.equal(initial.y, display.bounds.y);
    assert.equal(initial.x + initial.width / 2, legacyCenter, "Legacy floating position migrates to the same horizontal center");
    if (process.platform === "win32") {
      const inside = screen.dipToScreenPoint({ x: initial.x + initial.width / 2, y: initial.y + 6 });
      const below = screen.dipToScreenPoint({ x: initial.x + initial.width / 2, y: initial.y + 24 });
      const nativeHandle = win.getNativeWindowHandle().readBigUInt64LE().toString();
      const lookup = `Add-Type @'
using System;
using System.Runtime.InteropServices;
public static class CapsuleHitTest {
  [StructLayout(LayoutKind.Sequential)] public struct Point { public int X; public int Y; }
  [DllImport("user32.dll")] static extern IntPtr WindowFromPoint(Point point);
  [DllImport("user32.dll")] static extern IntPtr GetAncestor(IntPtr hwnd, uint flags);
  [DllImport("user32.dll")] static extern IntPtr SetThreadDpiAwarenessContext(IntPtr context);
  public static long At(int x, int y) {
    var old = SetThreadDpiAwarenessContext(new IntPtr(-4));
    try { return GetAncestor(WindowFromPoint(new Point { X=x, Y=y }), 2).ToInt64(); }
    finally { SetThreadDpiAwarenessContext(old); }
  }
}
'@
[CapsuleHitTest]::At(${inside.x}, ${inside.y})
[CapsuleHitTest]::At(${below.x}, ${below.y})`;
      const handles = execFileSync("powershell.exe", ["-NoProfile", "-Command", lookup], { encoding: "utf8", windowsHide: true, timeout: 8000 }).trim().split(/\s+/);
      assert.equal(handles[0], nativeHandle, "Visible rail receives OS mouse hits");
      assert.notEqual(handles[1], nativeHandle, "Area below the rail passes through to the desktop");
    }
    await new Promise(r => setTimeout(r, 200));
    writeFileSync(join(desktop, ".turbo/progress-capsule-collapsed.png"), (await win.webContents.capturePage({ x: 8, y: 0, width: initial.width - 16, height: 12 })).toPNG());
    win.webContents.sendInputEvent({ type: "mouseMove", x: 70, y: 5 });
    await waitFor(() => win.getBounds().height === 86);
    assert.equal(win.getBounds().width, 304); assert.equal(win.getBounds().y, display.bounds.y);
    assert.equal(await win.webContents.executeJavaScript('getComputedStyle(document.getElementById("grip")).webkitAppRegion'), "drag");
    assert.equal(await win.webContents.executeJavaScript('getComputedStyle(document.getElementById("open")).webkitAppRegion'), "no-drag");
    const emit = (event: RuntimeEvent) => { assert.ok(observer); (observer as (e: RuntimeEvent) => void)(event); };
    emit({ type: "thinking", sessionId: "first", messageId: "m1", text: "reasoning" });
    await waitFor(() => win.webContents.executeJavaScript('document.getElementById("phase").textContent === "正在思考"'));
    emit({ type: "text.delta", sessionId: "first", messageId: "m1", text: "response" });
    await waitFor(() => win.webContents.executeJavaScript('document.getElementById("phase").textContent === "正在输出"'));
    emit({ type: "tool.use", sessionId: "first", toolCallId: "t1", toolName: "Read", input: {}, requiresApproval: false });
    emit({ type: "tool.use", sessionId: "first", toolCallId: "t2", toolName: "Bash", input: {}, requiresApproval: false });
    await waitFor(() => win.webContents.executeJavaScript('document.getElementById("phase").textContent === "执行工具" && document.getElementById("tool").textContent.includes("运行命令 · 2")'));
    emit({ type: "approval.request", sessionId: "first", requestId: "r1", toolCallId: "t1", toolName: "Write", input: {} });
    await waitFor(() => win.webContents.executeJavaScript('document.getElementById("phase").textContent === "等待工具审批"'));
    assert.equal(await win.webContents.executeJavaScript('document.getElementById("tool").textContent'), "写入文件", "Approval identifies the pending tool, not another running tool");
    emit({ type: "question.ask", sessionId: "first", requestId: "q1", questions: [] });
    await waitFor(() => win.webContents.executeJavaScript('document.getElementById("phase").textContent === "等待你的回答"'));
    emit({ type: "request.resolved", sessionId: "first", requestId: "q1", kind: "question" });
    await waitFor(() => win.webContents.executeJavaScript('document.getElementById("phase").textContent === "等待工具审批"'));
    emit({ type: "plan.approval_request", sessionId: "first", requestId: "p1", toolCallId: "p", plan: "test plan" });
    await waitFor(() => win.webContents.executeJavaScript('document.getElementById("phase").textContent === "等待计划审批"'));
    emit({ type: "request.resolved", sessionId: "first", requestId: "p1", kind: "plan" });
    await waitFor(() => win.webContents.executeJavaScript('document.getElementById("phase").textContent === "等待工具审批"'));
    const capture = await win.webContents.capturePage();
    writeFileSync(join(desktop, ".turbo/progress-capsule-expanded.png"), capture.toPNG());
    emit({ type: "request.resolved", sessionId: "first", requestId: "r1", kind: "approval" });
    await waitFor(() => win.webContents.executeJavaScript('document.getElementById("phase").textContent === "执行工具"'));
    emit({ type: "tool.result", sessionId: "first", toolCallId: "t1", isError: false, content: "done" });
    await waitFor(async () => (await win.webContents.executeJavaScript("window.api.getState()") as ProgressCapsuleState).sessions[0]?.toolCount === 1);
    assert.equal(await win.webContents.executeJavaScript('document.getElementById("tool").textContent'), "运行命令");
    emit({ type: "tool.result", sessionId: "first", toolCallId: "t2", isError: false, content: "done" });
    await waitFor(() => win.webContents.executeJavaScript('document.getElementById("phase").textContent === "等待响应"'));
    active = ["first", "second", "third"];
    await waitFor(() => win.webContents.executeJavaScript('!document.getElementById("navigation").hidden && document.getElementById("position").textContent === "1/3"'));
    emit({ type: "text.delta", sessionId: "second", messageId: "m2", text: "second response" });
    emit({ type: "thinking", sessionId: "third", messageId: "m3", text: "third reasoning" });
    await win.webContents.executeJavaScript('document.getElementById("next").click(); document.getElementById("previous").click()');
    assert.equal(await win.webContents.executeJavaScript('document.getElementById("title").textContent'), "测试进度 · 中文");
    // Native mouse drag changes the selected task without opening it.
    win.focus();
    win.webContents.sendInputEvent({ type: "mouseDown", x: 190, y: 24, button: "left", clickCount: 1 });
    win.webContents.sendInputEvent({ type: "mouseMove", x: 100, y: 24 });
    win.webContents.sendInputEvent({ type: "mouseUp", x: 100, y: 24, button: "left", clickCount: 1 });
    await waitFor(() => win.webContents.executeJavaScript('document.getElementById("position").textContent === "2/3" && document.getElementById("phase").textContent === "正在输出"'));
    assert.equal(focused, "", "Swipe must not open a chat");
    await new Promise(r => setTimeout(r, 400));
    await win.webContents.executeJavaScript('document.getElementById("open").click()');
    await waitFor(() => focused === "second");
    await waitFor(() => win.getBounds().height === collapsedHeight);
    assert.equal(win.getBounds().x + win.getBounds().width / 2, initial.x + initial.width / 2, "Expansion retains the dock center");
    await win.webContents.executeJavaScript("window.api.setExpanded(true)");
    await waitFor(() => win.getBounds().height === 86);
    // Electron's native wheel displacement has the opposite sign to DOM deltaX.
    win.webContents.sendInputEvent({ type: "mouseWheel", x: 100, y: 24, deltaX: -80, deltaY: 0 });
    await waitFor(() => win.webContents.executeJavaScript('document.getElementById("position").textContent === "3/3" && document.getElementById("phase").textContent === "正在思考"'));
    await new Promise(r => setTimeout(r, 250));
    writeFileSync(join(desktop, ".turbo/progress-capsule-multiple.png"), (await win.webContents.capturePage()).toPNG());
    await win.webContents.executeJavaScript('document.dispatchEvent(new KeyboardEvent("keydown", {key:"ArrowLeft"}))');
    assert.equal(await win.webContents.executeJavaScript('document.getElementById("position").textContent'), "2/3");
    await win.webContents.executeJavaScript('document.dispatchEvent(new KeyboardEvent("keydown", {key:"ArrowRight"}))');
    active = ["first", "second"];
    await waitFor(() => win.webContents.executeJavaScript('document.getElementById("position").textContent === "1/2"'));
    // Leaving after a mouse interaction still retracts; button focus is not a latch.
    await win.webContents.executeJavaScript('document.dispatchEvent(new PointerEvent("pointerdown")); document.body.dispatchEvent(new PointerEvent("pointerleave"))');
    await waitFor(() => win.getBounds().height === collapsedHeight);
    const state = await win.webContents.executeJavaScript("window.api.getState()") as ProgressCapsuleState;
    assert.equal(state.sessions.length, 2); assert.equal(state.sessions[0]?.completed, 1);
    assert.equal(await win.webContents.executeJavaScript('window.api.setExpanded("bad").then(() => false, () => true)'), true, "Malformed view requests are rejected");
    await win.webContents.executeJavaScript('window.api.openSession("unknown")'); assert.equal(focused, "second");
    const other = new BrowserWindow({ show: false, webPreferences: { preload: options.preloadPath, nodeIntegration: false, contextIsolation: true, sandbox: false } });
    await other.loadURL("data:text/html,<html></html>");
    assert.equal(await other.webContents.executeJavaScript('window.api.getState().then(() => false, () => true)'), true, "only the private capsule window can call its IPC");
    assert.equal(await other.webContents.executeJavaScript('window.api.setExpanded(true).then(() => false, () => true)'), true);
    other.destroy();
    const area = screen.getPrimaryDisplay().bounds;
    win.setPosition(area.x + 40, area.y + 50);
    await waitFor(() => SettingRepo.get("ui.progressCapsule.dock") === JSON.stringify({ displayId: display.id, centerX: area.x + 128 }));
    assert.equal(win.getBounds().y, area.y, "Dragging snaps back to the screen edge");
    active = [];
    await waitFor(() => !win.isVisible());
    capsule.stop();
    capsule = new ProgressCapsule(runtime, options); capsule.start();
    active = ["first"]; startedAt = Date.now();
    await waitFor(() => BrowserWindow.getAllWindows()[0]?.isVisible() ?? false);
    win = BrowserWindow.getAllWindows()[0]!;
    assert.equal(win.getBounds().x, area.x + 40); assert.equal(win.getBounds().y, area.y); assert.equal(win.getBounds().height, collapsedHeight);
    SettingRepo.set("ui.locale", "en");
    await waitFor(() => win.webContents.executeJavaScript('document.getElementById("phase").textContent === "Waiting for response"'));
    capsule.stop();
    SettingRepo.set("ui.progressCapsule.dock", JSON.stringify({ displayId: display.id, centerX: 999999 }));
    capsule = new ProgressCapsule(runtime, options); capsule.start();
    await waitFor(() => BrowserWindow.getAllWindows()[0]?.isVisible() ?? false);
    const bounds = BrowserWindow.getAllWindows()[0]!.getBounds();
    const work = screen.getDisplayMatching(bounds).bounds;
    assert.ok(bounds.x >= work.x && bounds.y >= work.y && bounds.x + bounds.width <= work.x + work.width && bounds.y + bounds.height <= work.y + work.height);
    console.log("PASS: native always-on-top window, top-edge retract/hover, actual thinking/output/parallel tools, approval priority, swipe/wheel task switching without accidental opening, focus, private IPC, idle hiding, dock persistence/clamping and bilingual renderer");
  } catch (error) { console.error(error); process.exitCode = 1; }
  finally { capsule?.stop(); closeDb(); app.exit(process.exitCode ?? 0); }
}
void main();

import type { ProgressCapsuleApi, ProgressCapsuleState } from "@contracts/ipc";
import { translate } from "@renderer/lib/i18n/core.js";
import { modelDisplayName } from "@renderer/lib/modelAvatar.js";
import { toolDisplayName } from "@renderer/lib/builtinToolNames.js";
import "./capsule.css";

const api = (window as unknown as { api: ProgressCapsuleApi }).api;
const el = (id: string) => document.getElementById(id)!;
let state: ProgressCapsuleState = { locale: "zh", expanded: false, sessions: [] };
let selected: string | null = null;
let collapseTimer: ReturnType<typeof setTimeout> | undefined;
let swipe: { x: number; y: number; pointerId: number } | null = null;
let suppressClickUntil = 0;
let wheelDistance = 0;
let lastWheelAt = 0;
let keyboardMode = false;
const t = (key: Parameters<typeof translate>[1], params?: Record<string, string | number>) => translate(state.locale, key, params);
const TOOL_ACTIONS: Partial<Record<string, Parameters<typeof translate>[1]>> = {
  read: "layout.progress.read", bash: "layout.progress.command", edit: "layout.progress.edit",
  multiedit: "layout.progress.edit", write: "layout.progress.write", grep: "layout.progress.search",
  glob: "layout.progress.find", find: "layout.progress.find", task: "layout.progress.delegate", agent: "layout.progress.delegate",
};

function render(): void {
  const session = state.sessions.find(s => s.sessionId === selected) ?? state.sessions[0];
  document.documentElement.classList.toggle("expanded", state.expanded);
  document.documentElement.classList.toggle("notch", !!state.notch);
  if (state.notch) document.documentElement.style.setProperty("--notch", state.notch.height + "px");
  el("capsule").inert = !state.expanded;
  el("peek").tabIndex = state.expanded ? -1 : 0;
  if (!session) { selected = null; return; }
  selected = session.sessionId;
  document.documentElement.lang = state.locale;
  document.body.dataset.phase = session.phase;
  el("title").textContent = session.title;
  const seconds = Math.max(0, Math.floor((Date.now() - session.startedAt) / 1000));
  el("elapsed").textContent = Math.floor(seconds / 60) + ":" + String(seconds % 60).padStart(2, "0");
  el("phase").textContent = t(`layout.progress.${session.phase}`);
  el("peek-phase").textContent = el("phase").textContent;
  el("peek-count").textContent = state.sessions.length > 1 ? String(state.sessions.length) : "";
  el("peek").title = t("layout.progress.expand", { count: state.sessions.length });
  el("peek").setAttribute("aria-label", el("peek").title);
  const action = TOOL_ACTIONS[session.toolName?.toLowerCase() ?? ""];
  const tool = action ? t(action) : session.toolName ? toolDisplayName(session.toolName) : "";
  el("tool").textContent = tool ? (session.phase === "executing" && session.toolCount > 1 ? t("layout.progress.tools", { tool, count: session.toolCount }) : tool) : "";
  el("tool").title = session.toolName ?? "";
  el("progress").textContent = session.total ? t("layout.progress.tasks", { done: session.completed, total: session.total }) : (modelDisplayName(session.model) ?? "MarioCode");
  el("progress").title = session.task ?? modelDisplayName(session.model) ?? "MarioCode";
  el("track").hidden = session.total === 0;
  el("fill").style.width = (session.total ? Math.min(100, session.completed / session.total * 100) : 0) + "%";
  el("grip").title = t("layout.progress.drag");
  el("navigation").hidden = state.sessions.length < 2;
  const index = state.sessions.findIndex(s => s.sessionId === selected) + 1;
  el("position").textContent = index + "/" + state.sessions.length;
  el("position").setAttribute("aria-label", t("layout.progress.position", { index, count: state.sessions.length }));
  for (const [id, key] of [["previous", "layout.progress.previous"], ["next", "layout.progress.following"], ["open", "layout.progress.open"]] as const) {
    el(id).title = t(key);
    el(id).setAttribute("aria-label", id === "open" ? t(key) + " · " + session.title + " · " + el("phase").textContent : t(key));
  }
}

function setExpanded(expanded: boolean): void {
  clearTimeout(collapseTimer);
  if (state.expanded === expanded) return;
  state = { ...state, expanded };
  render();
  void api.setExpanded(expanded).catch(() => void api.getState().then(update));
}
function collapseLater(): void {
  clearTimeout(collapseTimer);
  collapseTimer = setTimeout(() => {
    if (keyboardMode && document.hasFocus() && document.activeElement instanceof HTMLButtonElement) return;
    setExpanded(false);
  }, 500);
}
function switchTask(direction: number): void {
  if (state.sessions.length < 2) return;
  const index = state.sessions.findIndex(s => s.sessionId === selected);
  selected = state.sessions[(index + direction + state.sessions.length) % state.sessions.length]!.sessionId;
  render();
  if (!matchMedia("(prefers-reduced-motion: reduce)").matches) {
    el("open").animate([{ opacity: .35, transform: "translateX(" + direction * 8 + "px)" }, { opacity: 1, transform: "translateX(0)" }], { duration: 180, easing: "ease-out" });
  }
}
function update(next: ProgressCapsuleState): void { state = next; render(); }
api.onState(update);
void api.getState().then(update);
document.body.addEventListener("pointerenter", () => setExpanded(true));
document.body.addEventListener("pointerleave", collapseLater);
window.addEventListener("blur", collapseLater);
document.body.addEventListener("focusin", () => setExpanded(true));
document.body.addEventListener("focusout", collapseLater);
document.addEventListener("pointerdown", () => { keyboardMode = false; });
el("peek").addEventListener("click", () => setExpanded(true));
el("open").addEventListener("click", () => { if (selected && Date.now() > suppressClickUntil) void api.openSession(selected); });
el("previous").addEventListener("click", () => switchTask(-1));
el("next").addEventListener("click", () => switchTask(1));
document.addEventListener("keydown", event => {
  keyboardMode = true;
  if (event.key === "ArrowLeft" || event.key === "ArrowRight") { event.preventDefault(); switchTask(event.key === "ArrowLeft" ? -1 : 1); }
  else if (event.key === "Escape") { (document.activeElement as HTMLElement | null)?.blur(); setExpanded(false); }
});
el("open").addEventListener("pointerdown", event => {
  if (event.button !== 0) return;
  swipe = { x: event.clientX, y: event.clientY, pointerId: event.pointerId };
  el("open").setPointerCapture(event.pointerId);
});
el("open").addEventListener("pointerup", event => {
  if (!swipe || swipe.pointerId !== event.pointerId) return;
  const dx = event.clientX - swipe.x;
  if (Math.abs(dx) >= 28 && Math.abs(dx) > Math.abs(event.clientY - swipe.y) && state.sessions.length > 1) {
    suppressClickUntil = Date.now() + 350;
    switchTask(dx < 0 ? 1 : -1);
  }
  swipe = null;
});
el("open").addEventListener("pointercancel", () => { swipe = null; });
document.addEventListener("wheel", event => {
  if (state.sessions.length < 2) return;
  event.preventDefault();
  const now = Date.now();
  if (now - lastWheelAt < 320) return;
  const delta = Math.abs(event.deltaX) > Math.abs(event.deltaY) ? event.deltaX : event.deltaY;
  wheelDistance += delta * (event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? 80 : 1);
  if (Math.abs(wheelDistance) >= 28) { switchTask(wheelDistance > 0 ? 1 : -1); wheelDistance = 0; lastWheelAt = now; }
}, { passive: false });
setInterval(render, 1000);

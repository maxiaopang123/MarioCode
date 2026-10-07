import type { ProgressCapsuleApi, ProgressCapsuleState } from "@contracts/ipc";
import { translate } from "@renderer/lib/i18n/core.js";
import { modelDisplayName } from "@renderer/lib/modelAvatar.js";
import "./capsule.css";

const api = (window as unknown as { api: ProgressCapsuleApi }).api;
const el = (id: string) => document.getElementById(id)!;
let state: ProgressCapsuleState = { locale: "zh", sessions: [] };
let selected: string | null = null;
function render(): void {
  const session = state.sessions.find(s => s.sessionId === selected) ?? state.sessions[0];
  if (!session) return;
  selected = session.sessionId;
  document.documentElement.lang = state.locale;
  const t = (key: Parameters<typeof translate>[1], params?: Record<string, string | number>) => translate(state.locale, key, params);
  el("title").textContent = session.title;
  el("title").title = [session.title, modelDisplayName(session.model ?? "")].filter(Boolean).join(" · ");
  const seconds = Math.max(0, Math.floor((Date.now() - session.startedAt) / 1000));
  el("elapsed").textContent = `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`;
  el("phase").textContent = t(`layout.progress.${session.phase}`);
  el("capsule").classList.toggle("waiting", session.phase !== "running");
  el("progress").textContent = session.total ? t("layout.progress.tasks", { done: session.completed, total: session.total }) : (modelDisplayName(session.model ?? "") ?? "MarioCode");
  el("capsule").title = session.task ?? t("layout.progress.drag");
  el("track").hidden = session.total === 0;
  el("fill").style.width = `${session.total ? session.completed / session.total * 100 : 0}%`;
  el("others").hidden = state.sessions.length < 2;
  el("others").textContent = `+${state.sessions.length - 1}`;
  el("others").title = t("layout.progress.next", { count: state.sessions.length });
  el("others").setAttribute("aria-label", el("others").title);
  el("open").title = t("layout.progress.open");
  el("open").setAttribute("aria-label", el("open").title);
}
function update(next: ProgressCapsuleState): void { state = next; render(); }
api.onState(update);
void api.getState().then(update);
el("open").addEventListener("click", () => { if (selected) void api.openSession(selected); });
el("others").addEventListener("click", () => {
  const index = state.sessions.findIndex(s => s.sessionId === selected);
  selected = state.sessions[(index + 1) % state.sessions.length]?.sessionId ?? null;
  render();
});
setInterval(render, 1000);

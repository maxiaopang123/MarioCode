import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { ScheduledTask, ScheduledTaskCreateInput } from "@contracts/ipc";
import { api } from "@renderer/lib/api.js";
import { useI18n } from "@renderer/lib/i18n/index.js";
import { useSessionStore } from "@renderer/stores/sessionStore.js";
import {
  IconCalendar,
  IconEdit,
  IconLoader2,
  IconPlayerPlay,
  IconPlus,
  IconTrash,
} from "@renderer/lib/icons.js";
import { Button, ConfirmDialog, Dialog, Input, Switch } from "@renderer/components/ui/index.js";
import { PanelHeader } from "./PanelHeader.js";

type FormState = {
  name: string;
  projectId: string;
  providerId: string;
  prompt: string;
  scheduleKind: ScheduledTask["scheduleKind"];
  runAtLocal: string;
  timeOfDay: string;
  weekdays: number[];
  enabled: boolean;
  pushEnabled: boolean;
};

const WEEKDAYS = [1, 2, 3, 4, 5, 6, 7] as const;

function localDateTimeValue(iso: string | null): string {
  if (!iso) return "";
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "";
  const local = new Date(date.getTime() - date.getTimezoneOffset() * 60_000);
  return local.toISOString().slice(0, 16);
}

function emptyForm(projectId = "", providerId = "claude-sdk"): FormState {
  const nextHour = new Date(Date.now() + 60 * 60_000);
  nextHour.setMinutes(0, 0, 0);
  return {
    name: "",
    projectId,
    providerId,
    prompt: "",
    scheduleKind: "daily",
    runAtLocal: localDateTimeValue(nextHour.toISOString()),
    timeOfDay: `${String(nextHour.getHours()).padStart(2, "0")}:00`,
    weekdays: [1, 2, 3, 4, 5],
    enabled: true,
    pushEnabled: false,
  };
}

function formFromTask(task: ScheduledTask): FormState {
  return {
    name: task.name,
    projectId: task.projectId,
    providerId: task.providerId,
    prompt: task.prompt,
    scheduleKind: task.scheduleKind,
    runAtLocal: localDateTimeValue(task.runAt),
    timeOfDay: task.timeOfDay ?? "09:00",
    weekdays: task.weekdays,
    enabled: task.enabled,
    pushEnabled: task.pushEnabled,
  };
}

function toCreateInput(form: FormState): ScheduledTaskCreateInput {
  return {
    name: form.name.trim(),
    projectId: form.projectId,
    providerId: form.providerId,
    prompt: form.prompt.trim(),
    scheduleKind: form.scheduleKind,
    runAt: form.scheduleKind === "one-time" ? new Date(form.runAtLocal).toISOString() : null,
    timeOfDay: form.scheduleKind === "one-time" ? null : form.timeOfDay,
    weekdays: form.scheduleKind === "weekly" ? form.weekdays : [],
    enabled: form.enabled,
    pushEnabled: form.pushEnabled,
  };
}

export function ScheduledTasksPanel() {
  const { t, locale } = useI18n();
  const projects = useSessionStore((s) => s.projects).filter((p) => !p.archived);
  const registeredProviders = useSessionStore((s) => s.providers);
  const providers = useMemo(() => {
    const canonical = registeredProviders.filter((p) =>
      ["claude-sdk", "codex-sdk", "pi-sdk"].includes(p.id),
    );
    return canonical.length > 0
      ? canonical
      : [
          { id: "claude-sdk", displayName: "Claude" },
          { id: "codex-sdk", displayName: "Codex" },
          { id: "pi-sdk", displayName: "Pi" },
        ];
  }, [registeredProviders]);

  const [tasks, setTasks] = useState<ScheduledTask[]>([]);
  const [loading, setLoading] = useState(true);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [dialogOpen, setDialogOpen] = useState(false);
  const [editing, setEditing] = useState<ScheduledTask | null>(null);
  const [pendingDelete, setPendingDelete] = useState<ScheduledTask | null>(null);
  const [form, setForm] = useState<FormState>(() => emptyForm());
  const [error, setError] = useState<string | null>(null);
  // Every list request and mutation advances this epoch. A response may only
  // update the view while it is still the newest operation, preventing a slow
  // polling response from restoring state captured before a user action.
  const responseEpoch = useRef(0);

  const load = useCallback(async (silent = false) => {
    const epoch = ++responseEpoch.current;
    if (!silent) {
      setLoading(true);
      setError(null);
    }
    try {
      const result = await api.scheduler.list();
      if (epoch === responseEpoch.current) setTasks(result.tasks);
    } catch (err) {
      if (!silent && epoch === responseEpoch.current) {
        setError(t("settings.scheduledTasks.loadFailed", { error: (err as Error).message }));
      }
    } finally {
      if (epoch === responseEpoch.current) setLoading(false);
    }
  }, [t]);

  useEffect(() => {
    void load();
    const timer = window.setInterval(() => {
      void load(true);
    }, 12_000);
    return () => window.clearInterval(timer);
  }, [load]);

  const openCreate = () => {
    setEditing(null);
    setForm(emptyForm(projects[0]?.id, providers[0]?.id));
    setError(null);
    setDialogOpen(true);
  };

  const openEdit = (task: ScheduledTask) => {
    setEditing(task);
    setForm(formFromTask(task));
    setError(null);
    setDialogOpen(true);
  };

  const validate = (): string | null => {
    if (!form.name.trim()) return t("settings.scheduledTasks.validationName");
    if (!form.projectId) return t("settings.scheduledTasks.validationProject");
    if (!form.providerId) return t("settings.scheduledTasks.validationAgent");
    if (!form.prompt.trim()) return t("settings.scheduledTasks.validationPrompt");
    if (form.scheduleKind === "one-time") {
      const at = new Date(form.runAtLocal).getTime();
      if (!form.runAtLocal || Number.isNaN(at) || at <= Date.now()) {
        return t("settings.scheduledTasks.validationRunAt");
      }
    }
    if (form.scheduleKind !== "one-time" && !/^([01]\d|2[0-3]):[0-5]\d$/.test(form.timeOfDay)) {
      return t("settings.scheduledTasks.validationTime");
    }
    if (form.scheduleKind === "weekly" && form.weekdays.length === 0) {
      return t("settings.scheduledTasks.validationWeekday");
    }
    return null;
  };

  const save = async () => {
    const validation = validate();
    if (validation) return setError(validation);
    setBusyId(editing?.id ?? "new");
    setError(null);
    ++responseEpoch.current;
    try {
      const input = toCreateInput(form);
      const result = editing
        ? await api.scheduler.update({ id: editing.id, ...input })
        : await api.scheduler.create(input);
      ++responseEpoch.current;
      setTasks((current) => {
        const found = current.some((task) => task.id === result.task.id);
        return found
          ? current.map((task) => (task.id === result.task.id ? result.task : task))
          : [result.task, ...current];
      });
      setDialogOpen(false);
    } catch (err) {
      ++responseEpoch.current;
      setError(t("settings.scheduledTasks.saveFailed", { error: (err as Error).message }));
    } finally {
      setBusyId(null);
    }
  };

  const replaceTask = (next: ScheduledTask) =>
    setTasks((current) => current.map((task) => (task.id === next.id ? next : task)));

  const setEnabled = async (task: ScheduledTask, enabled: boolean) => {
    setBusyId(task.id);
    ++responseEpoch.current;
    try {
      const result = await api.scheduler.setEnabled({ id: task.id, enabled });
      ++responseEpoch.current;
      replaceTask(result.task);
    } catch (err) {
      ++responseEpoch.current;
      setError(t("settings.scheduledTasks.actionFailed", { error: (err as Error).message }));
    } finally {
      setBusyId(null);
    }
  };

  const runNow = async (task: ScheduledTask) => {
    setBusyId(task.id);
    ++responseEpoch.current;
    try {
      const result = await api.scheduler.runNow({ id: task.id });
      ++responseEpoch.current;
      replaceTask(result.task);
    } catch (err) {
      ++responseEpoch.current;
      setError(t("settings.scheduledTasks.actionFailed", { error: (err as Error).message }));
    } finally {
      setBusyId(null);
    }
  };

  const remove = async (task: ScheduledTask) => {
    setBusyId(task.id);
    ++responseEpoch.current;
    try {
      await api.scheduler.delete({ id: task.id });
      ++responseEpoch.current;
      setTasks((current) => current.filter((item) => item.id !== task.id));
    } catch (err) {
      ++responseEpoch.current;
      setError(t("settings.scheduledTasks.actionFailed", { error: (err as Error).message }));
    } finally {
      setBusyId(null);
    }
  };

  const projectName = (id: string) => projects.find((p) => p.id === id)?.name ?? id;
  const providerName = (id: string) => providers.find((p) => p.id === id)?.displayName ?? id;
  const dateTime = (value: number | null) =>
    value == null ? t("settings.scheduledTasks.never") : new Intl.DateTimeFormat(locale, {
      dateStyle: "medium",
      timeStyle: "short",
    }).format(new Date(value));
  const scheduleText = (task: ScheduledTask) => {
    if (task.scheduleKind === "one-time") {
      const configuredAt = task.runAt ? Date.parse(task.runAt) : null;
      return t("settings.scheduledTasks.scheduleOnce", { time: dateTime(configuredAt) });
    }
    if (task.scheduleKind === "daily") {
      return t("settings.scheduledTasks.scheduleDaily", { time: task.timeOfDay ?? "" });
    }
    const days = task.weekdays
      .map((day) => t(`settings.scheduledTasks.weekday.${day}` as never))
      .join(locale === "zh" ? "、" : ", ");
    return t("settings.scheduledTasks.scheduleWeekly", { days, time: task.timeOfDay ?? "" });
  };

  return (
    <section className="mx-auto w-full max-w-4xl space-y-4">
      <PanelHeader
        title={t("settings.scheduledTasks.title")}
        icon={IconCalendar}
        action={
          <Button variant="primary" size="md" onClick={openCreate} disabled={projects.length === 0}>
            <IconPlus size={15} />
            {t("settings.scheduledTasks.create")}
          </Button>
        }
      />

      <p className="px-1 text-xs leading-relaxed text-content-muted">
        {t("settings.scheduledTasks.description")}
      </p>
      {projects.length === 0 && (
        <div className="rounded-lg border border-warning/30 bg-warning/5 px-4 py-3 text-xs text-content-muted">
          {t("settings.scheduledTasks.noProjects")}
        </div>
      )}
      {error && !dialogOpen && (
        <div className="rounded-lg border border-danger/30 bg-danger/5 px-4 py-3 text-xs text-danger">{error}</div>
      )}

      {loading ? (
        <div className="flex min-h-48 items-center justify-center text-content-subtle">
          <IconLoader2 size={20} className="animate-spin" />
        </div>
      ) : tasks.length === 0 ? (
        <div className="flex min-h-56 flex-col items-center justify-center rounded-lg border border-dashed border-edge px-6 text-center">
          <span className="mb-3 flex h-10 w-10 items-center justify-center rounded-full bg-surface-muted text-content-subtle">
            <IconCalendar size={20} />
          </span>
          <div className="text-sm font-medium text-content">{t("settings.scheduledTasks.emptyTitle")}</div>
          <p className="mt-1 max-w-md text-xs leading-relaxed text-content-subtle">
            {t("settings.scheduledTasks.emptyDescription")}
          </p>
          {projects.length > 0 && (
            <Button className="mt-4" variant="primary" size="md" onClick={openCreate}>
              <IconPlus size={15} /> {t("settings.scheduledTasks.createFirst")}
            </Button>
          )}
        </div>
      ) : (
        <div className="space-y-2">
          {tasks.map((task) => {
            const busy = busyId === task.id;
            const oneTimeExpired =
              task.scheduleKind === "one-time" &&
              task.runAt !== null &&
              Date.parse(task.runAt) <= Date.now();
            const cannotReenable = !task.enabled && oneTimeExpired;
            return (
              <article key={task.id} className="rounded-lg border border-edge bg-surface-raised px-4 py-3">
                <div className="flex items-start gap-4">
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2">
                      <h3 className="truncate text-sm font-semibold text-content">{task.name}</h3>
                      <span className={`rounded-full px-2 py-0.5 text-[11px] ${statusClass(task.lastStatus)}`}>
                        {t(`settings.scheduledTasks.status.${task.lastStatus}` as never)}
                      </span>
                    </div>
                    <p className="mt-1 truncate text-xs text-content-muted">
                      {projectName(task.projectId)} · {providerName(task.providerId)}
                    </p>
                    <p className="mt-2 text-xs text-content-subtle">{scheduleText(task)}</p>
                    <div className="mt-2 grid gap-x-6 gap-y-1 text-[11px] text-content-subtle sm:grid-cols-2">
                      <span>{t("settings.scheduledTasks.nextRun")}: {dateTime(task.nextRunAt)}</span>
                      <span>{t("settings.scheduledTasks.lastRun")}: {dateTime(task.lastRunAt)}</span>
                    </div>
                    {task.pushEnabled && (
                      <div className="mt-2 flex flex-wrap items-center gap-2 text-[11px]">
                        <span className="text-content-subtle">{t("settings.scheduledTasks.wechatPush")}:</span>
                        <span className={`rounded-full px-2 py-0.5 ${pushStatusClass(task.lastPushStatus)}`}>
                          {t(`settings.scheduledTasks.pushStatus.${task.lastPushStatus}` as never)}
                        </span>
                        {task.lastPushAt !== null && <span className="text-content-subtle">{dateTime(task.lastPushAt)}</span>}
                        {task.lastPushStatus === "accepted" && (
                          <span className="text-content-subtle">{t("settings.scheduledTasks.acceptedNotDelivered")}</span>
                        )}
                      </div>
                    )}
                    {task.lastPushError && <p className="mt-1 line-clamp-2 text-[11px] text-danger">{task.lastPushError}</p>}
                    {task.lastError && <p className="mt-2 line-clamp-2 text-[11px] text-danger">{task.lastError}</p>}
                    {cannotReenable && (
                      <p className="mt-2 text-[11px] text-warning">
                        {t("settings.scheduledTasks.expiredOneTimeHint")}
                      </p>
                    )}
                  </div>
                  <div className="flex shrink-0 items-center gap-1">
                    <span title={cannotReenable ? t("settings.scheduledTasks.expiredOneTimeTooltip") : undefined}>
                      <Switch
                        checked={task.enabled}
                        disabled={busy || cannotReenable}
                        onCheckedChange={(enabled) => void setEnabled(task, enabled)}
                        label={task.enabled ? t("settings.on") : t("settings.off")}
                      />
                    </span>
                    <Button size="icon" variant="ghost" title={t("settings.scheduledTasks.runNow")} disabled={busy || task.lastStatus === "running"} onClick={() => void runNow(task)}>
                      {busy ? <IconLoader2 size={15} className="animate-spin" /> : <IconPlayerPlay size={15} />}
                    </Button>
                    <Button size="icon" variant="ghost" title={t("settings.scheduledTasks.edit")} disabled={busy} onClick={() => openEdit(task)}>
                      <IconEdit size={15} />
                    </Button>
                    <Button size="icon" variant="danger" title={t("settings.scheduledTasks.delete")} disabled={busy} onClick={() => setPendingDelete(task)}>
                      <IconTrash size={15} />
                    </Button>
                  </div>
                </div>
              </article>
            );
          })}
        </div>
      )}

      <TaskDialog
        open={dialogOpen}
        editing={editing}
        form={form}
        projects={projects}
        providers={providers}
        saving={busyId === (editing?.id ?? "new")}
        error={dialogOpen ? error : null}
        onOpenChange={setDialogOpen}
        onChange={setForm}
        onSave={() => void save()}
      />
      <ConfirmDialog
        open={pendingDelete !== null}
        title={t("settings.scheduledTasks.deleteTitle")}
        description={t("settings.scheduledTasks.deleteDescription", { name: pendingDelete?.name ?? "" })}
        confirmText={t("settings.scheduledTasks.delete")}
        danger
        onOpenChange={(open) => { if (!open) setPendingDelete(null); }}
        onConfirm={() => { if (pendingDelete) void remove(pendingDelete); }}
      />
    </section>
  );
}

function statusClass(status: ScheduledTask["lastStatus"]): string {
  if (status === "running") return "bg-accent/10 text-accent";
  if (status === "succeeded") return "bg-success/10 text-success";
  if (status === "failed") return "bg-danger/10 text-danger";
  if (status === "skipped") return "bg-warning/10 text-warning";
  return "bg-surface-muted text-content-subtle";
}

function pushStatusClass(status: ScheduledTask["lastPushStatus"]): string {
  if (status === "pending") return "bg-accent/10 text-accent";
  if (status === "accepted") return "bg-success/10 text-success";
  if (status === "failed") return "bg-danger/10 text-danger";
  if (status === "needs-interaction") return "bg-warning/10 text-warning";
  return "bg-surface-muted text-content-subtle";
}

function TaskDialog({ open, editing, form, projects, providers, saving, error, onOpenChange, onChange, onSave }: {
  open: boolean;
  editing: ScheduledTask | null;
  form: FormState;
  projects: Array<{ id: string; name: string }>;
  providers: Array<{ id: string; displayName: string }>;
  saving: boolean;
  error: string | null;
  onOpenChange: (open: boolean) => void;
  onChange: (form: FormState) => void;
  onSave: () => void;
}) {
  const { t } = useI18n();
  const fieldClass = "h-8 w-full rounded border border-edge bg-surface px-2 text-xs text-content outline-none focus:border-accent";
  return (
    <Dialog.Root open={open} onOpenChange={onOpenChange}>
      <Dialog.Portal>
        <Dialog.Backdrop />
        <Dialog.Popup className="max-h-[calc(100vh-72px)] w-[560px] max-w-[92vw] overflow-y-auto p-5">
          <Dialog.Title>{editing ? t("settings.scheduledTasks.editTitle") : t("settings.scheduledTasks.createTitle")}</Dialog.Title>
          <Dialog.Description className="mt-1">{t("settings.scheduledTasks.dialogDescription")}</Dialog.Description>
          <div className="mt-4 grid gap-3">
            <Field label={t("settings.scheduledTasks.name")}>
              <Input value={form.name} onChange={(e) => onChange({ ...form, name: e.target.value })} autoFocus />
            </Field>
            <div className="grid grid-cols-2 gap-3">
              <Field label={t("settings.scheduledTasks.project")}>
                <select className={fieldClass} value={form.projectId} onChange={(e) => onChange({ ...form, projectId: e.target.value })}>
                  <option value="">{t("settings.scheduledTasks.chooseProject")}</option>
                  {projects.map((project) => <option key={project.id} value={project.id}>{project.name}</option>)}
                </select>
              </Field>
              <Field label={t("settings.scheduledTasks.agent")}>
                <select className={fieldClass} value={form.providerId} onChange={(e) => onChange({ ...form, providerId: e.target.value })}>
                  {providers.map((provider) => <option key={provider.id} value={provider.id}>{provider.displayName}</option>)}
                </select>
              </Field>
            </div>
            <Field label={t("settings.scheduledTasks.prompt")}>
              <textarea className="min-h-28 w-full resize-y rounded border border-edge bg-surface px-3 py-2 text-xs leading-relaxed text-content outline-none focus:border-accent" value={form.prompt} onChange={(e) => onChange({ ...form, prompt: e.target.value })} />
            </Field>
            <Field label={t("settings.scheduledTasks.scheduleKind")}>
              <div className="grid grid-cols-3 gap-2">
                {(["one-time", "daily", "weekly"] as const).map((kind) => (
                  <button key={kind} type="button" onClick={() => onChange({ ...form, scheduleKind: kind })} className={`rounded border px-3 py-2 text-xs transition-colors ${form.scheduleKind === kind ? "border-accent bg-accent/10 text-accent" : "border-edge text-content-muted hover:bg-surface-muted"}`}>
                    {t(`settings.scheduledTasks.kind.${kind}` as never)}
                  </button>
                ))}
              </div>
            </Field>
            {form.scheduleKind === "one-time" ? (
              <Field label={t("settings.scheduledTasks.runAt")}>
                <input type="datetime-local" className={fieldClass} value={form.runAtLocal} onChange={(e) => onChange({ ...form, runAtLocal: e.target.value })} />
              </Field>
            ) : (
              <Field label={t("settings.scheduledTasks.timeOfDay")}>
                <input type="time" className={fieldClass} value={form.timeOfDay} onChange={(e) => onChange({ ...form, timeOfDay: e.target.value })} />
              </Field>
            )}
            {form.scheduleKind === "weekly" && (
              <Field label={t("settings.scheduledTasks.weekdays")}>
                <div className="grid grid-cols-7 gap-1.5">
                  {WEEKDAYS.map((day) => {
                    const selected = form.weekdays.includes(day);
                    return <button key={day} type="button" onClick={() => onChange({ ...form, weekdays: selected ? form.weekdays.filter((item) => item !== day) : [...form.weekdays, day].sort() })} className={`rounded border py-2 text-xs ${selected ? "border-accent bg-accent/10 text-accent" : "border-edge text-content-muted hover:bg-surface-muted"}`}>{t(`settings.scheduledTasks.weekdayShort.${day}` as never)}</button>;
                  })}
                </div>
              </Field>
            )}
            <div className="flex items-center justify-between rounded border border-edge px-3 py-2.5">
              <div><div className="text-xs font-medium text-content">{t("settings.scheduledTasks.enabled")}</div><div className="mt-0.5 text-[11px] text-content-subtle">{t("settings.scheduledTasks.enabledHint")}</div></div>
              <Switch checked={form.enabled} onCheckedChange={(enabled) => onChange({ ...form, enabled })} label={form.enabled ? t("settings.on") : t("settings.off")} />
            </div>
            <div className="flex items-center justify-between rounded border border-edge px-3 py-2.5">
              <div className="pr-4">
                <div className="text-xs font-medium text-content">{t("settings.scheduledTasks.pushToWechat")}</div>
                <div className="mt-0.5 text-[11px] leading-relaxed text-content-subtle">{t("settings.scheduledTasks.pushToWechatHint")}</div>
              </div>
              <Switch checked={form.pushEnabled} onCheckedChange={(pushEnabled) => onChange({ ...form, pushEnabled })} label={form.pushEnabled ? t("settings.on") : t("settings.off")} />
            </div>
            {form.pushEnabled && (
              <div className="rounded border border-warning/30 bg-warning/5 px-3 py-2 text-[11px] leading-relaxed text-content-muted">
                {t("settings.scheduledTasks.pushBindingHint")}
              </div>
            )}
            {error && <div className="rounded border border-danger/30 bg-danger/5 px-3 py-2 text-xs text-danger">{error}</div>}
          </div>
          <div className="mt-5 flex justify-end gap-2">
            <Button variant="ghost" size="md" onClick={() => onOpenChange(false)}>{t("common.cancel")}</Button>
            <Button variant="primary" size="md" disabled={saving} onClick={onSave}>{saving && <IconLoader2 size={14} className="animate-spin" />}{t("settings.scheduledTasks.save")}</Button>
          </div>
          <Dialog.Close />
        </Dialog.Popup>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return <label className="grid gap-1.5"><span className="text-[11px] font-medium text-content-muted">{label}</span>{children}</label>;
}

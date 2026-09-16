const settings = new Map<string, string>();
const sessions: Array<{ id: string; customModelId: string | null; model: string }> = [];
export function rawSettings(): string { return JSON.stringify([...settings]); }
export function addSession(id: string, customModelId: string | null, model: string): void { sessions.push({ id, customModelId, model }); }
export function corruptSharedKey(id: string): void {
  const keys = JSON.parse(settings.get("sharedProviders.keys") ?? "{}") as Record<string, string>;
  keys[id] = Buffer.from("corrupt-ciphertext", "utf8").toString("base64");
  settings.set("sharedProviders.keys", JSON.stringify(keys));
}
export function getDb() {
  return {
    prepare(sql: string) {
      return {
        get(...args: string[]) {
          if (sql.startsWith("SELECT value FROM settings")) return settings.has(args[0]!) ? { value: settings.get(args[0]!) } : undefined;
          if (sql.startsWith("SELECT id FROM sessions")) return sessions.find((s) =>
            s.customModelId === args[0] || s.model === args[1] || s.model.startsWith(args[3]!),
          );
          return undefined;
        },
        run(key: string, value: string) { settings.set(key, value); },
      };
    },
    transaction<T extends () => unknown>(fn: T): T { return fn; },
  };
}
export async function awaitDb(): Promise<ReturnType<typeof getDb>> { return getDb(); }
export const SettingRepo = {
  get: (key: string): string | null => settings.get(key) ?? null,
  set: (key: string, value: string): void => { settings.set(key, value); },
};

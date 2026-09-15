const values = new Map<string, string>();
export const SettingRepo = {
  get: (key: string): string | null => values.get(key) ?? null,
  set: (key: string, value: string): void => { values.set(key, value); },
};
export function snapshotSettings(): Map<string, string> { return new Map(values); }

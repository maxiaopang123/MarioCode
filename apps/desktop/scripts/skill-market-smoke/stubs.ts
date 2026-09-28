/**
 * Stand-ins for the Electron / SQLite modules skillMarket.ts touches, so the
 * smoke can bundle the real module with esbuild and run it under plain node.
 * Wired by run.mjs via an esbuild onResolve plugin.
 */
const settings = new Map<string, string>();

export const SettingRepo = {
  get: (key: string): string | undefined => settings.get(key),
  set: (key: string, value: string): void => {
    settings.set(key, value);
  },
};

export async function awaitDb(): Promise<void> {
  // in-memory: always ready
}

export const log = {
  info: (msg: string) => process.stderr.write(`[smoke] [INFO] ${msg}\n`),
  warn: (msg: string) => process.stderr.write(`[smoke] [WARN] ${msg}\n`),
  error: (msg: string) => process.stderr.write(`[smoke] [ERROR] ${msg}\n`),
};

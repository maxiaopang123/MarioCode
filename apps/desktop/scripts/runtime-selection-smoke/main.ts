import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { discoverExternalRuntimes, selectRuntime } from "@main/runtimes/runtimeSelection.js";
import { setManagedRuntimeRoot } from "@main/runtimes/managedRuntimeRoots.js";
import { removeRuntime } from "@main/runtimes/runtimeInstaller.js";
import { isRuntimeMutationActive, withRuntimeMutation } from "@main/runtimes/runtimeMutation.js";
import { snapshotSettings } from "./stub-repositories.js";

let checks = 0;
function check(name: string, condition: boolean): void {
  checks++;
  if (!condition) throw new Error(`FAILED: ${name}`);
  process.stdout.write(`  ✓ ${name}\n`);
}

for (const agent of ["claude", "codex", "pi"] as const) {
  const candidates = await discoverExternalRuntimes(agent);
  process.stdout.write(`  • ${agent}: ${candidates.map((c) => `${c.version ?? "?"} ${c.path}`).join(", ") || "none"}\n`);
  check(`${agent} discovery returns only probed candidates`, candidates.every((c) => c.diagnostic.length > 0));
  try {
    const locator = process.platform === "win32" ? "where.exe" : "which";
    execFileSync(locator, [agent], { stdio: "ignore", windowsHide: true });
    check(`${agent} PATH installation is not silently missed`, candidates.some((c) => c.available));
  } catch { /* no PATH installation on this machine */ }
}

const before = snapshotSettings();
const invalid = await selectRuntime("claude", "external", join(tmpdir(), "definitely-missing-claude"));
check("invalid external selection is rejected", !invalid.ok);
check("invalid external selection does not persist", snapshotSettings().size === before.size);

const pi = (await discoverExternalRuntimes("pi")).find((candidate) => candidate.available);
if (pi) {
  const badNode = await selectRuntime("pi", "external", pi.path, join(tmpdir(), "missing-node"));
  check("explicit invalid Pi Node is rejected without system fallback", !badNode.ok);
  check("failed Pi Node selection does not persist", snapshotSettings().size === before.size);
  const validPi = await selectRuntime("pi", "external", pi.path);
  check("Pi SDK imports in a real Node process and exposes its minimum API", validPi.ok);
}

const root = mkdtempSync(join(tmpdir(), "mcode-runtime-selection-"));
const external = join(root, "external-claude.exe");
writeFileSync(external, "external owner sentinel");
const managedRoot = join(root, "managed");
mkdirSync(join(managedRoot, "claude", "1.0.0"), { recursive: true });
writeFileSync(join(managedRoot, "claude", "1.0.0", "claude.exe"), "managed sentinel");
setManagedRuntimeRoot(managedRoot);
await removeRuntime("claude");
check("managed removal never deletes an external-owned program", existsSync(external));

let release!: () => void;
const held = withRuntimeMutation("claude", async () => await new Promise<void>((resolve) => { release = resolve; }));
check("runtime mutation lock is visible before its first await", isRuntimeMutationActive());
let concurrentRejected = false;
try { await withRuntimeMutation("codex", async () => undefined); } catch { concurrentRejected = true; }
check("concurrent runtime mutation is rejected", concurrentRejected);
release();
await held;
check("runtime mutation lock clears after settlement", !isRuntimeMutationActive());

process.stdout.write(`runtime-selection smoke passed (${checks} checks)\n`);

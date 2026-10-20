import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RUNTIME_MIN_LOCAL_VERSIONS } from "@contracts/ipc";
import {
  compareCoreVersions,
  discoverExternalRuntimes,
  getRuntimeSelection,
  newestTooOld,
  selectRuntime,
  validateExternalSelection,
} from "@main/runtimes/runtimeSelection.js";
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

check("compareCoreVersions orders numerically", compareCoreVersions("2.1.238", "2.1.99") > 0 && compareCoreVersions("0.153.4", "0.153.10") < 0);
check("compareCoreVersions ignores prerelease suffix", compareCoreVersions("2.1.238-beta.1", "2.1.238") === 0 && compareCoreVersions("v0.83.0", "0.83.0") === 0);
check("newestTooOld picks the newest known version", newestTooOld([
  { path: "a", version: null, available: false, compatibility: "incompatible", diagnostic: "x", tooOld: true, minVersion: "2.1.238" },
  { path: "b", version: "2.1.100", available: false, compatibility: "incompatible", diagnostic: "x", tooOld: true, minVersion: "2.1.238" },
  { path: "c", version: "2.1.200", available: false, compatibility: "incompatible", diagnostic: "x", tooOld: true, minVersion: "2.1.238" },
  { path: "d", version: "9.9.9", available: false, compatibility: "incompatible", diagnostic: "x" },
])?.path === "c");

// TODO-057: discovery still probes local installations, but they are info
// display only — the engines never load from them (resolvers were reduced to
// managed → dev/bundled). These checks pin the probing behavior.
for (const agent of ["claude", "codex", "pi"] as const) {
  const candidates = await discoverExternalRuntimes(agent);
  process.stdout.write(`  • ${agent}: ${candidates.map((c) => `${c.version ?? "?"}${c.tooOld ? " (too old)" : ""} ${c.path}`).join(", ") || "none"}\n`);
  check(`${agent} discovery returns only probed candidates`, candidates.every((c) => c.diagnostic.length > 0));
  check(`${agent} available candidates meet the minimum version`, candidates.every((c) =>
    !c.available || (c.version !== null && compareCoreVersions(c.version, RUNTIME_MIN_LOCAL_VERSIONS[agent]) >= 0)));
  check(`${agent} too-old candidates are never available`, candidates.every((c) => !c.tooOld || (!c.available && c.minVersion === RUNTIME_MIN_LOCAL_VERSIONS[agent])));
  try {
    const locator = process.platform === "win32" ? "where.exe" : "which";
    execFileSync(locator, [agent], { stdio: "ignore", windowsHide: true });
    // Found on PATH → it must surface either as usable or as an explained too-old entry.
    check(`${agent} PATH installation is not silently missed`, candidates.some((c) => c.available || c.tooOld === true));
  } catch { /* no PATH installation on this machine */ }
}

// Fake Pi packages exercise the minimum-version gate without real installs.
const fakeRoot = mkdtempSync(join(tmpdir(), "mariocode-runtime-minver-"));
function fakePi(version: string): string {
  const dir = join(fakeRoot, `pi-${version}`);
  mkdirSync(join(dir, "dist"), { recursive: true });
  writeFileSync(join(dir, "dist", "index.js"), "export const createAgentSession = () => undefined;\n");
  writeFileSync(join(dir, "package.json"), JSON.stringify({ name: "@earendil-works/pi-coding-agent", version, exports: { ".": { import: "./dist/index.js" } } }));
  return join(dir, "package.json");
}
const oldPi = await validateExternalSelection("pi", fakePi("0.1.0"));
check("too-old Pi package is marked tooOld + unavailable", oldPi.tooOld === true && !oldPi.available && oldPi.minVersion === RUNTIME_MIN_LOCAL_VERSIONS.pi);
check("too-old diagnostic names version and minimum", oldPi.diagnostic.includes("0.1.0") && oldPi.diagnostic.includes(RUNTIME_MIN_LOCAL_VERSIONS.pi));
const newPi = await validateExternalSelection("pi", fakePi("99.0.0"));
check("new-enough Pi package passes the gate", newPi.available && !newPi.tooOld);
rmSync(fakeRoot, { recursive: true, force: true });

// TODO-057: external mode was removed. A legacy "external" row in settings
// must read as AUTO (graceful degradation), and both current modes persist.
const before = snapshotSettings();
check("managed mode persists", (await selectRuntime("claude", "managed")).ok);
check("managed mode reads back", getRuntimeSelection("claude").mode === "managed");
check("auto mode persists", (await selectRuntime("claude", "auto")).ok);
check("auto mode reads back", getRuntimeSelection("claude").mode === "auto");
writeFileSync(join(tmpdir(), `mariocode-legacy-external-${Date.now()}`), "");
// Seed a legacy external selection the way pre-TODO-057 builds stored it.
const { SettingRepo } = await import("@main/store/repositories.js");
SettingRepo.set("runtime.selection.claude", JSON.stringify({
  mode: "external",
  path: "C:\\legacy\\claude.exe",
  nodePath: null,
  verifiedVersion: "2.1.0",
  payloadFingerprint: "deadbeef",
  nodeFingerprint: null,
}));
check("legacy external selection degrades to auto", getRuntimeSelection("claude").mode === "auto");
await selectRuntime("claude", "auto"); // overwrite the legacy row
check("legacy external selection is overwritten by a mode save", (JSON.parse(SettingRepo.get("runtime.selection.claude") ?? "{}") as { mode?: string }).mode === "auto");
check("mode saves leave exactly one row for the agent", [...snapshotSettings().keys()].filter((key) => key === "runtime.selection.claude").length === 1);

const root = mkdtempSync(join(tmpdir(), "mariocode-runtime-selection-"));
const external = join(root, "external-claude.exe");
writeFileSync(external, "external owner sentinel");
const managedRoot = join(root, "managed");
mkdirSync(join(managedRoot, "claude", "1.0.0"), { recursive: true });
writeFileSync(join(managedRoot, "claude", "1.0.0", "claude.exe"), "managed sentinel");
setManagedRuntimeRoot(managedRoot);
await removeRuntime("claude");
check("managed removal never deletes a user-owned program", existsSync(external));

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

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
function check(name: string, condition: boolean, detail?: string): void {
  checks++;
  if (!condition) throw new Error(`FAILED: ${name}${detail === undefined ? "" : `\n  got: ${detail}`}`);
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

// ── TODO-064 hardening: version validation, leftovers, guarded pruning ──────
const { isReleaseVersion, sweepManagedRuntimes } = await import("@main/runtimes/runtimeInstaller.js");
const { listManagedVersions } = await import("@main/runtimes/managedRuntimeRoots.js");
const { setRuntimeTurnProbe, hasRunningTurn } = await import("@main/runtimes/runtimeMutation.js");

check("plain and prerelease versions are accepted", ["1.2.3", "0.153.4", "1.0.0-rc.1", "1.0.0+build.5"].every(isReleaseVersion));
check("path-like or malformed versions are rejected", ["9.9.9/../../x", "..\\1.0.0", "1.0", "latest", "", "1.0.0 ", "1.0.0\n"].every((v) => !isReleaseVersion(v)));

// Crash leftovers sit next to the real version dirs. The backup name sorts
// NEWER than the real version in compareVersions, so it must never be listed.
const sweepRoot = join(root, "sweep");
setManagedRuntimeRoot(sweepRoot);
const agentDir = join(sweepRoot, "claude");
for (const name of ["0.3.250", "0.3.258", "0.3.258.backup-1700000000000-42", ".0.3.259.staging-1700000000001"]) {
  mkdirSync(join(agentDir, name), { recursive: true });
  writeFileSync(join(agentDir, name, "claude.exe"), name);
}
writeFileSync(join(agentDir, "stray-file.txt"), "not a directory");
check("only release directories are listed, newest first", JSON.stringify(listManagedVersions("claude")) === JSON.stringify(["0.3.258", "0.3.250"]), listManagedVersions("claude"));

setRuntimeTurnProbe(() => true);
check("turn probe is visible", hasRunningTurn());
sweepManagedRuntimes();
check("sweep is a no-op while a turn is running", existsSync(join(agentDir, "0.3.250")) && existsSync(join(agentDir, "0.3.258.backup-1700000000000-42")));

setRuntimeTurnProbe(() => false);
sweepManagedRuntimes();
check("idle sweep keeps the newest release", existsSync(join(agentDir, "0.3.258", "claude.exe")));
check("idle sweep prunes superseded releases", !existsSync(join(agentDir, "0.3.250")));
check("idle sweep clears backup and staging leftovers", !existsSync(join(agentDir, "0.3.258.backup-1700000000000-42")) && !existsSync(join(agentDir, ".0.3.259.staging-1700000000001")));
check("sweep never touches files it does not own", existsSync(join(agentDir, "stray-file.txt")));
check("sweep ignores the user-owned program", existsSync(external));

// ── torn payloads (interrupted install) must never count as installed ───────
// An app quit / kill mid-extract can leave `<version>/claude` PRESENT but
// truncated. existsSync used to say "fine", the resolver handed the path to
// the SDK, and spawn failed with its misleading "binary does not match this
// system's libc" message. See payloadGuard.ts.
const { installedManagedPayload, dropBrokenManagedVersions, brokenManagedPayloads } = await import(
  "@main/runtimes/runtimeAvailability.js"
);
const guardRoot = join(root, "guard");
setManagedRuntimeRoot(guardRoot);
const guardAgentDir = join(guardRoot, "claude");
const claudeName = process.platform === "win32" ? "claude.exe" : "claude";

/** A plausible 2MB "binary" whose container matches the host OS, so the guard
 *  accepts it (payloadGuard also rejects foreign-platform payloads). */
function fakeBinary(): Buffer {
  const buf = Buffer.alloc(2_000_000);
  if (process.platform === "win32") buf.write("MZ", 0, "latin1");
  else if (process.platform === "linux") buf.set([0x7f, 0x45, 0x4c, 0x46], 0);
  else buf.set([0xcf, 0xfa, 0xed, 0xfe], 0); // Mach-O 64, little endian
  return buf;
}

mkdirSync(join(guardAgentDir, "0.3.306"), { recursive: true });
writeFileSync(join(guardAgentDir, "0.3.306", claudeName), "truncated");
check("a truncated managed binary is not reported as installed", installedManagedPayload("claude") === null);
check(
  "the panel can name the incomplete payload instead of \"nothing available\"",
  brokenManagedPayloads("claude").length === 1 &&
    brokenManagedPayloads("claude")[0].version === "0.3.306" &&
    brokenManagedPayloads("claude")[0].size === "truncated".length,
  JSON.stringify(brokenManagedPayloads("claude")),
);

mkdirSync(join(guardAgentDir, "0.3.258"), { recursive: true });
writeFileSync(join(guardAgentDir, "0.3.258", claudeName), fakeBinary());
check(
  "a torn newer version is skipped in favour of a healthy older one",
  installedManagedPayload("claude")?.version === "0.3.258",
  installedManagedPayload("claude")?.version,
);
check(
  "broken version dirs are dropped so the panel offers a reinstall",
  dropBrokenManagedVersions("claude").join(",") === "0.3.306" && !existsSync(join(guardAgentDir, "0.3.306")),
);
check("dropping broken dirs keeps the healthy version", existsSync(join(guardAgentDir, "0.3.258", claudeName)));

// A complete binary for ANOTHER OS (e.g. a Linux ELF inside the macOS
// package) spawns with ENOEXEC and the SDK blames the libc — reject it here.
if (process.platform !== "linux") {
  mkdirSync(join(guardAgentDir, "0.3.400"), { recursive: true });
  const elf = Buffer.alloc(2_000_000);
  elf.set([0x7f, 0x45, 0x4c, 0x46], 0);
  writeFileSync(join(guardAgentDir, "0.3.400", claudeName), elf);
  check(
    "a foreign-platform payload is never offered as installed",
    installedManagedPayload("claude")?.version === "0.3.258",
    installedManagedPayload("claude")?.version,
  );
  check(
    "the foreign-platform version dir is dropped",
    dropBrokenManagedVersions("claude").join(",") === "0.3.400" && !existsSync(join(guardAgentDir, "0.3.400")),
  );
}

// pi is a JS library — its payload marker is a legitimately tiny package.json.
mkdirSync(join(guardRoot, "pi", "0.83.0", "node_modules", "@earendil-works", "pi-coding-agent"), {
  recursive: true,
});
writeFileSync(
  join(guardRoot, "pi", "0.83.0", "node_modules", "@earendil-works", "pi-coding-agent", "package.json"),
  '{"version":"0.83.0"}',
);
check("a tiny library payload is still usable (pi)", installedManagedPayload("pi")?.version === "0.83.0");
check("the pi payload is never dropped by the size guard", dropBrokenManagedVersions("pi").length === 0);

// ── the SDK's launch-failure text is a Linux-only guess ─────────────────────
// Whenever existsSync accepts the path but spawn fails, the Agent SDK answers
// with one hardcoded explanation: "the binary does not match this system's
// libc — e.g. spawning a musl-linked binary on a glibc Linux host". macOS and
// Windows have neither, so that "clue" is impossible there while the real
// cause (torn install, payload for another OS/arch, quarantined file) goes
// unmentioned. We must never relay it. See launchFailure.ts.
const { humanizeLaunchFailure, launchFailureCauses } = await import("@main/providers/claude-sdk/launchFailure.js");
const sdkLaunchText = (path: string): string =>
  `Claude Code native binary at ${path} exists but failed to launch. This usually means the binary does not match this system's libc — e.g. spawning a musl-linked binary on a glibc Linux host fails because the musl dynamic loader (/lib/ld-musl-*) is missing. Specify a matching binary with options.pathToClaudeCodeExecutable.`;

const msgRoot = join(root, "launch-guard");
setManagedRuntimeRoot(msgRoot);
const deadVersion = "9.9.9";
const deadDir = join(msgRoot, "claude", deadVersion);
mkdirSync(deadDir, { recursive: true });
const deadBinary = join(deadDir, claudeName);
writeFileSync(deadBinary, "truncated payload, exists but cannot exec");
const dropped = humanizeLaunchFailure(sdkLaunchText(deadBinary));
check("the SDK's libc guess is never relayed to the user", !/libc|musl/i.test(dropped), dropped);
check(
  "an unlaunchable managed copy is removed so the panel can reinstall",
  dropped.includes(`已移除损坏的副本 ${deadVersion}`) && !existsSync(deadDir),
  dropped,
);
check("…and the user is pointed at the install button", dropped.includes("设置 → Agent"), dropped);

const notManagedPath = join(root, "elsewhere", claudeName);
const notManaged = humanizeLaunchFailure(sdkLaunchText(notManagedPath));
check(
  "a binary outside the managed root still gets an actionable message",
  notManaged.includes(notManagedPath) && notManaged.includes("设置 → Agent"),
  notManaged,
);
check(
  "…and never repeats the impossible explanation",
  !/does not match this system's libc|musl dynamic loader/i.test(notManaged),
  notManaged,
);
if (process.platform !== "linux") {
  // The one platform where musl is real is Linux; nowhere else may we claim it.
  check("no libc/musl claim on a platform that has neither", !/musl|glibc/i.test(notManaged), notManaged);
}

// No parsable path (an error class or a reworded message) must not fall back to
// the guess either — that is exactly the macOS case.
const pathless = humanizeLaunchFailure("Claude Code native binary exists but failed to launch (executable_launch_failed).");
check(
  "a pathless launch failure does not fall back to the guess",
  !/does not match this system's libc/i.test(pathless) && pathless.includes("设置 → Agent"),
  pathless,
);
check("ordinary errors pass through untouched", humanizeLaunchFailure("fetch failed: ECONNRESET") === "fetch failed: ECONNRESET");

// Every platform's wording is asserted here, from one machine: the macOS branch
// can otherwise ship untested and it is the one this bug was reported on.
const darwinCauses = launchFailureCauses("darwin");
const winCauses = launchFailureCauses("win32");
const linuxCauses = launchFailureCauses("linux");
check("macOS wording never blames the libc/musl", !/libc|musl|glibc/i.test(darwinCauses), darwinCauses);
check("Windows wording never blames the libc/musl", !/libc|musl|glibc/i.test(winCauses), winCauses);
check("macOS wording names the real candidates (arch / exec bit)", /架构|Rosetta/.test(darwinCauses) && /执行权限/.test(darwinCauses), darwinCauses);
check("Linux keeps the libc hint, where it can actually be true", /libc/.test(linuxCauses), linuxCauses);

process.stdout.write(`runtime-selection smoke passed (${checks} checks)\n`);

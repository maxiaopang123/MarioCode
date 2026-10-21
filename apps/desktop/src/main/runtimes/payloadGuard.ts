/**
 * Physical sanity checks for managed runtime payloads.
 *
 * WHY THIS EXISTS
 * `existsSync` is not enough to decide that a managed runtime is usable. An
 * install that was interrupted (app quit / kill / crash / power loss) can
 * leave a version directory whose payload file EXISTS but is truncated. Every
 * layer then believes the runtime is ready — the resolver returns the path,
 * the settings panel reports "installed", and `spawn` fails. The Claude Agent
 * SDK turns that failure into:
 *
 *   "Claude Code native binary at <path> exists but failed to launch. This
 *    usually means the binary does not match this system's libc — e.g.
 *    spawning a musl-linked binary on a glibc Linux host…"
 *
 * which is a Linux-musl guess. On macOS/Windows the real cause was a torn
 * install, and the message sends users (and support) down the wrong path
 * entirely.
 *
 * Two guards, both cheap (one statSync):
 *   - the payload file must be non-trivially sized  → `binaryEntryUsable`
 *   - a version dir whose payload exists but is unusable is DELETED before a
 *     resolver can pick it                       → `dropUnusableManagedVersions`
 * The delete also repairs the panel: with the dir gone, the version reads as
 * not-installed and the install button performs a real reinstall instead of a
 * silent same-version no-op.
 *
 * This module is deliberately PURE node and imports no resolver: it sits
 * below runtimeAvailability.ts / sdkBinaryPath.ts / codexBinaryResolve.ts in
 * the graph, because those two resolvers must not import each other.
 */
import { closeSync, existsSync, openSync, readSync, rmSync, statSync } from "node:fs";
import { isAbsolute, join, relative, sep } from "node:path";
import type { RuntimeAgentId } from "@contracts/ipc";
import { getManagedRuntimeRoot, listManagedVersions } from "./managedRuntimeRoots.js";

/** Real agent binaries are tens to hundreds of MB (claude ≈ 100–200MB,
 *  codex ≈ 100–380MB). Anything smaller than this is a truncated payload, not
 *  a legitimately tiny executable. */
export const MIN_PLAUSIBLE_BINARY_BYTES = 1_000_000;

/** Is this file's container the one the current OS can load? Reads 4 bytes.
 *
 *  This is the other half of the SDK's misleading message: a payload can be a
 *  perfect, complete binary for the WRONG system (a Linux ELF inside the
 *  macOS package, a macOS Mach-O on Windows). spawn then fails with ENOEXEC/
 *  EBADARCH and the SDK reports it as a "libc mismatch", which is impossible
 *  to act on for a desktop user.
 *
 *  Deliberately conservative: only positive, unambiguous mismatches are
 *  rejected (wrong container for this OS). Anything unreadable or
 *  unrecognized passes, so this can never reject a working install. It does
 *  NOT try to tell arm64 from x64 within Mach-O/ELF — under Rosetta 2
 *  `process.arch` reports x64 on an arm64 Mac, so an arch verdict here would
 *  produce false negatives. */
export function payloadPlatformMatches(entry: string): boolean {
  let magic: Buffer;
  try {
    const fd = openSync(entry, "r");
    try {
      magic = Buffer.alloc(4);
      const read = readSync(fd, magic, 0, 4, 0);
      if (read < 4) return true;
    } finally {
      closeSync(fd);
    }
  } catch {
    return true; // can't read → let the spawn attempt decide
  }
  const be = magic.readUInt32BE(0);
  // Mach-O thin 32/64 (both endiannesses) and universal/fat (both byte orders).
  const isMachO =
    be === 0xfeedface || be === 0xfeedfacf || be === 0xcefaedfe ||
    be === 0xcffaedfe || be === 0xcafebabe || be === 0xbebafeca;
  const isElf = magic[0] === 0x7f && magic[1] === 0x45 && magic[2] === 0x4c && magic[3] === 0x46;
  const isPe = magic[0] === 0x4d && magic[1] === 0x5a; // "MZ"
  switch (process.platform) {
    case "darwin":
      return isMachO;
    case "linux":
      return isElf;
    case "win32":
      return isPe;
    default:
      return true;
  }
}

/** A payload entry that is a BINARY is usable when it exists as a regular
 *  file of plausible size AND is a binary for this OS. Returns false for null
 *  / missing / directory / truncated / foreign-platform. */
export function binaryEntryUsable(entry: string | null): boolean {
  if (!entry) return false;
  try {
    if (!existsSync(entry)) return false;
    const st = statSync(entry);
    if (!st.isFile() || st.size < MIN_PLAUSIBLE_BINARY_BYTES) return false;
    return payloadPlatformMatches(entry);
  } catch {
    return false;
  }
}

/** Locate the payload of one managed version dir. Binaries → their path and a
 *  size check; library payloads (pi) → any existing marker file, no size
 *  check, since a package.json is legitimately tiny. */
export type PayloadProbe = (
  dir: string,
) => { entry: string; isBinary: boolean } | null;

/** True when the probed payload exists and passes the size check (when it is
 *  a binary). */
export function payloadUsable(probe: PayloadProbe, dir: string): boolean {
  const found = probe(dir);
  if (!found) return false;
  if (!found.isBinary) return existsSync(found.entry);
  return binaryEntryUsable(found.entry);
}

/** Newest managed version dir whose payload is usable, or null. */
export function newestUsableManagedVersion(
  agent: RuntimeAgentId,
  probe: PayloadProbe,
): { version: string; dir: string; entry: string } | null {
  const root = getManagedRuntimeRoot();
  if (!root) return null;
  for (const version of listManagedVersions(agent)) {
    const dir = join(root, agent, version);
    const found = probe(dir);
    if (found && payloadUsable(probe, dir)) {
      return { version, dir, entry: found.entry };
    }
  }
  return null;
}

/** Delete managed version dirs whose payload EXISTS but is unusable (torn
 *  install). Returns the versions dropped. Directories with no payload at all
 *  are left alone: they may be mid-install, and sweepManagedRuntimes() deals
 *  with real leftovers. */
export function dropUnusableManagedVersions(
  agent: RuntimeAgentId,
  probe: PayloadProbe,
): string[] {
  const root = getManagedRuntimeRoot();
  if (!root) return [];
  const dropped: string[] = [];
  for (const version of listManagedVersions(agent)) {
    const dir = join(root, agent, version);
    const found = probe(dir);
    // No entry at all → not ours to judge here.
    if (!found || !existsSync(found.entry)) continue;
    if (payloadUsable(probe, dir)) continue;
    try {
      rmSync(dir, { recursive: true, force: true });
      dropped.push(version);
    } catch {
      // best-effort: an undeletable dir (Windows lock) is re-checked next time
    }
  }
  return dropped;
}

/** Delete the managed version dir that CONTAINS `binaryPath`. Used when a spawn
 *  of exactly that binary failed: the copy just proved it cannot launch even
 *  though it passed the cheap size/format checks, so only the OS could tell.
 *  Removing it lets the next Settings → Agent install be a real reinstall.
 *  Returns the version dropped, or null when the path isn't a managed one. */
export function dropManagedVersionContaining(
  agent: RuntimeAgentId,
  binaryPath: string,
): string | null {
  const root = getManagedRuntimeRoot();
  if (!root) return null;
  const rel = relative(root, binaryPath);
  if (!rel || rel.startsWith("..") || isAbsolute(rel)) return null;
  const [agentSeg, version] = rel.split(sep);
  if (agentSeg !== agent || !version) return null;
  if (!listManagedVersions(agent).includes(version)) return null;
  try {
    rmSync(join(root, agent, version), { recursive: true, force: true });
    return version;
  } catch {
    return null;
  }
}

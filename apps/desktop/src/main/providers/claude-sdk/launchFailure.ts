/**
 * Turn the Claude Agent SDK's launch-failure text into a message that is true
 * on the machine the user is actually sitting at.
 *
 * WHY THIS EXISTS
 * When the SDK's `spawn` fails for a binary whose path `existsSync` accepts, it
 * emits ONE hardcoded explanation (sdk.mjs, `executable_launch_failed`):
 *
 *   "Claude Code native binary at <path> exists but failed to launch. This
 *    usually means the binary does not match this system's libc — e.g.
 *    spawning a musl-linked binary on a glibc Linux host fails because the
 *    musl dynamic loader (/lib/ld-musl-*) is missing."
 *
 * That is a Linux-only guess applied to every platform. macOS has no musl and
 * no glibc, and Windows has neither — so for those users the console's one and
 * only clue is *impossible*, and it sends them (and support) hunting a libc
 * that does not exist while the real cause is a torn download, a payload built
 * for another OS/arch, or a quarantined file.
 *
 * So: recognize that message, drop the managed copy that just proved it cannot
 * launch (the panel can then reinstall it for real), and state the causes that
 * ARE possible on this OS instead of relaying the guess. Pure node + the
 * payload guard so it can be exercised by the runtime smoke test.
 */
import { dropManagedVersionContaining } from "@main/runtimes/payloadGuard.js";

/** Every shape the SDK's launch failure can reach us in: the human text, the
 *  libc sentence alone, or the error class it tags the error with. */
const LAUNCH_FAILURE_RE = /exists but failed to launch|does not match this system's libc|executable_launch_failed/i;

/** The path the SDK blamed, e.g. "Claude Code native binary at /x/y/claude
 *  exists but failed to launch". */
function failedLaunchPath(message: string): string | null {
  const m = / at (.+?) exists but failed to launch/i.exec(message);
  return m ? m[1] : null;
}

/** Plausible reasons a binary that EXISTS cannot be executed on THIS system.
 *  Deliberately physical: what the OS can actually refuse. The SDK's libc
 *  sentence is only ever one of these, and only on Linux. `platform` is a
 *  parameter so every branch can be asserted from one machine (a macOS-only
 *  string is otherwise never executed by CI or by a Windows dev box). */
export function launchFailureCauses(platform: NodeJS.Platform = process.platform): string {
  switch (platform) {
    case "darwin":
      return "常见原因:下载或安装不完整、副本架构与本机不符(Intel / Apple 芯片,或未安装 Rosetta),或文件缺少执行权限";
    case "win32":
      return "常见原因:下载或安装不完整,或文件被杀毒/安全软件隔离";
    case "linux":
      return "常见原因:下载或安装不完整,或该二进制与本机 libc 不匹配(musl / glibc)";
    default:
      return "常见原因:下载或安装不完整";
  }
}

/** Rewrite an SDK launch failure into an actionable message. Any other error
 *  is returned untouched (this must never swallow real diagnostics). */
export function humanizeLaunchFailure(message: string): string {
  if (!LAUNCH_FAILURE_RE.test(message)) return message;
  const path = failedLaunchPath(message);
  const dropped = path ? dropManagedVersionContaining("claude", path) : null;
  // The SDK's own explanation is dropped in every branch below — including when
  // the path cannot be parsed, where returning `message` would hand the libc
  // guess straight back to a macOS user.
  if (dropped) {
    return (
      `Claude 运行时无法启动 —— 已移除损坏的副本 ${dropped}。` +
      `请到 设置 → Agent 点击"安装"重新下载,然后重试。\n` +
      `(The Claude runtime could not launch; the broken copy (${dropped}) was removed. ` +
      `Open Settings → Agent and install it again, then retry.)`
    );
  }
  const where = path ? `:${path}` : "";
  return (
    `Claude 运行时无法启动${where}。${launchFailureCauses()}。` +
    `请到 设置 → Agent 重新安装运行时,然后重试。\n` +
    `(The Claude runtime could not launch${where}. Open Settings → Agent, ` +
    `reinstall the runtime, then retry.)`
  );
}

/** A real Node process cannot read Electron's virtual ASAR filesystem. The
 * host bundle is shipped in asarUnpack and must be launched from that tree.
 * Match an entire path segment, also when dev Electron loads a packaged app. */
export function unpackPiHostPath(entry: string): string {
  return entry.replace(/([\\/])([^\\/]+\.asar)(?=[\\/])/, "$1$2.unpacked");
}

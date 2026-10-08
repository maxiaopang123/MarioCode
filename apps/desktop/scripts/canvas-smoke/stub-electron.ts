/**
 * Stand-in for the `electron` module in the canvas smoke. canvasStore uses
 * app.getPath("pictures") for the default gallery dir and nativeImage for
 * image dimensions / crop / resize. The mock parses PNG IHDR for sizes and
 * returns buffers unchanged for toPNG — logic under test (repo writes, scope
 * filtering, trash moves) never depends on real pixels.
 */
import { readFileSync } from "node:fs";

function readPngSize(buf: Buffer): { width: number; height: number } {
  if (buf.length >= 24 && buf[0] === 0x89 && buf[1] === 0x50 /* P */) {
    return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) };
  }
  return { width: 0, height: 0 };
}

class MockNativeImage {
  constructor(
    private buf: Buffer,
    private w: number,
    private h: number,
  ) {}
  isEmpty(): boolean {
    return this.buf.length === 0;
  }
  getSize(): { width: number; height: number } {
    return { width: this.w, height: this.h };
  }
  toPNG(): Buffer {
    return this.buf;
  }
  crop(rect: { width: number; height: number }): MockNativeImage {
    return new MockNativeImage(this.buf, rect.width, rect.height);
  }
  resize(opts: { width: number; height: number }): MockNativeImage {
    return new MockNativeImage(this.buf, opts.width, opts.height);
  }
}

export const nativeImage = {
  createFromBuffer(buf: Buffer): MockNativeImage {
    const { width, height } = readPngSize(buf);
    return new MockNativeImage(buf, width, height);
  },
  createFromPath(path: string): MockNativeImage {
    return nativeImage.createFromBuffer(readFileSync(path));
  },
};

export const app = {
  getPath(name: string): string {
    if (name === "userData") {
      const dir = process.env.SMOKE_USER_DATA;
      if (!dir) throw new Error("SMOKE_USER_DATA is not set");
      return dir;
    }
    if (name === "pictures") {
      const dir = process.env.SMOKE_PICTURES;
      if (!dir) throw new Error("SMOKE_PICTURES is not set");
      return dir;
    }
    throw new Error(`stub-electron: getPath(${name}) is not supported`);
  },
};

export default { app, nativeImage };

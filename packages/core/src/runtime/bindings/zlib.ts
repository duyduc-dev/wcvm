// internalBinding('zlib'): backs Node's real vendored zlib.js. Real Node's binding is a native
// handle wrapping zlib's own C streaming API (avail_in/avail_out, many small write() calls each
// draining a bounded output buffer) - not reproducible against the Compression Streams API, whose
// only primitives are "write bytes in" / "read whatever's ready" / "close to finish", with no
// per-call bounded output and no forced mid-stream flush.
//
// Key simplification (see PLAN.md): every real caller this sandbox needs to satisfy - a piped
// Transform (`createGzip()` etc.) and the `*Sync` convenience functions - only truly needs output
// once the whole input is known (`.end()`/finish). So this binding accumulates every input chunk
// across calls, and only actually runs CompressionStream/DecompressionStream ONCE, on a
// finish-flagged call: write the whole thing, close, drain the reader fully. That single result is
// then handed out across possibly-multiple write()/writeSync() calls, bounded by each call's own
// out_len - exactly the "not done, call me again" loop the UNMODIFIED vendored zlib.js
// (`processCallback` for async, `processChunkSync` for sync) already drives; this binding only has
// to report state[0]/state[1] (availOutAfter/availInAfter) honestly each call and, for the async
// path, invoke the real `processCallback` function captured at init() time - same "implement the
// low-level step, let vendored JS own the state machine" split this repo already used for
// httpParser.ts.
//
// A non-finish flush (Z_SYNC_FLUSH/Z_PARTIAL_FLUSH/Z_FULL_FLUSH - zlib's own `.flush()`) is
// accepted but a no-op: the Compression Streams API has no "flush what you have, stay open"
// primitive, only close() (which ends the stream for good), so mid-stream flush cannot force early
// output here. Real npm/tar-style whole-buffer gzip/gunzip never needs it.
//
// Brotli/Zstd aren't implemented: the Compression Streams API doesn't support either format, so
// `binding.BrotliEncoder`/`BrotliDecoder`/`ZstdCompress`/`ZstdDecompress` are simply absent from
// this binding's return value - `new zlib.BrotliCompress()` fails with a plain, honest
// `TypeError: binding.BrotliEncoder is not a constructor`, the same shape of failure as any other
// not-yet-implemented handle class in this codebase. `windowBits`/`memLevel`/`strategy`/
// `dictionary` are accepted but ignored - no equivalent control surface exists either.

import { OP_ZLIB_SYNC, encodeRequest, encodeString, type ISyscallClient } from "../../protocols/syscall";
import type { EventLoop } from "../eventLoop";

export type ZlibFormat = "gzip" | "deflate" | "deflate-raw";
export type ZlibDirection = "compress" | "decompress";

// Node's internal zlib mode numbers (internalBinding('constants').zlib, mirrored in
// bindings/constants.ts's ZLIB_CONSTANTS).
const DEFLATE = 1;
const INFLATE = 2;
const GZIP = 3;
const GUNZIP = 4;
const DEFLATERAW = 5;
const INFLATERAW = 6;
const UNZIP = 7;

const MODE_INFO: Record<number, { format: ZlibFormat | "auto"; direction: ZlibDirection }> = {
  [DEFLATE]: { format: "deflate", direction: "compress" },
  [INFLATE]: { format: "deflate", direction: "decompress" },
  [GZIP]: { format: "gzip", direction: "compress" },
  [GUNZIP]: { format: "gzip", direction: "decompress" },
  [DEFLATERAW]: { format: "deflate-raw", direction: "compress" },
  [INFLATERAW]: { format: "deflate-raw", direction: "decompress" },
  [UNZIP]: { format: "auto", direction: "decompress" },
};

/** Sniffs gzip vs. zlib-wrapped deflate by magic byte (0x1f 0x8b), matching UNZIP mode's real
 *  auto-detect behavior; anything else is treated as zlib-wrapped deflate. */
const sniffFormat = (bytes: Uint8Array): ZlibFormat => (bytes[0] === 0x1f && bytes[1] === 0x8b ? "gzip" : "deflate");

const concatBytes = (parts: Uint8Array[]): Uint8Array => {
  if (parts.length === 1) return parts[0];
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
};

/** The shared codec core: runs a whole buffer through a real CompressionStream/
 *  DecompressionStream once, collecting every output chunk. Used directly (async, in-process) by
 *  this binding's `write()`, and by the kernel's OP_ZLIB_SYNC servicer (kernel/
 *  kernelSyncServer.ts) for the blocking `*Sync` path - the same "share a stateless codec core
 *  across the kernel and the guest runtime" shape kernel/previewRelay.ts already uses for
 *  HttpMessageParser (runtime/bindings/httpParser.ts). */
export const runZlibOnce = async (format: ZlibFormat, direction: ZlibDirection, input: Uint8Array): Promise<Uint8Array> => {
  const stream = direction === "compress" ? new CompressionStream(format) : new DecompressionStream(format);
  const writer = stream.writable.getWriter();
  const reader = stream.readable.getReader();
  const chunks: Uint8Array[] = [];
  const pump = (async () => {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) return;
      chunks.push(value);
    }
  })();
  // A malformed stream can reject `pump` before control reaches `await pump` below (observed
  // running this under plain Node/Vitest, whose global DecompressionStream is itself a shim over
  // Node's own zlib - not present in a real browser's native implementation); attach a no-op
  // handler right away so it's never reported as an unhandled rejection. `await pump` further
  // down still independently observes and propagates the same rejection.
  pump.catch(() => {});
  // Cast: `Uint8Array`'s generic type param defaults to `ArrayBufferLike` (which includes
  // `SharedArrayBuffer`), which the DOM's `BufferSource` doesn't structurally accept - same
  // generic-TypedArray friction httpParser.ts's own `buffer` field already hit. `input` is
  // always a freshly-copied, non-shared array by the time it reaches here.
  await writer.write(input as BufferSource);
  await writer.close();
  await pump;
  return concatBytes(chunks);
};

// Z_FINISH's real numeric value (bindings/constants.ts's ZLIB_CONSTANTS.Z_FINISH) - the only
// flush flag that actually ends the stream; every other flag is accepted but a no-op (see file
// header).
const Z_FINISH = 4;

export interface IZlibBindingContext {
  /** Backs the blocking `*Sync` convenience functions; without it, they throw. Real process
   *  workers always wire this (same as execSync/spawnSync). */
  spawnSync?: ISyscallClient;
  loop: EventLoop;
}

export const createZlibBinding = (ctx: IZlibBindingContext) => {
  /** One "generic zlib" handle: DEFLATE/INFLATE/GZIP/GUNZIP/DEFLATERAW/INFLATERAW/UNZIP. */
  class Zlib {
    // Plain settable field real vendored ZlibBase's constructor assigns after construction
    // (`handle.onerror = zlibOnError`); also picks up arbitrary extra properties
    // (`buffer`/`cb`/`availOutBefore`/.../the owner_symbol) vendored code stashes directly on the
    // handle instance - nothing to do here beyond not interfering with them.
    onerror: ((message: string, errno: number, code: string) => void) | null = null;

    // Not `private`: this class is returned from an exported factory (createZlibBinding), and TS
    // can't emit a declaration type for an exported anonymous class with private members - same
    // reason childProcess.ts's own Pipe class avoids `private` on its fields.
    readonly mode: number;
    writeState: Uint32Array | null = null;
    processCallback: (() => void) | null = null;

    inputChunks: Uint8Array[] = [];
    resolvedFormat: ZlibFormat | null = null;
    pendingOutput: Uint8Array | null = null;
    closed = false;

    constructor(mode: number) {
      this.mode = mode;
    }

    init(
      _windowBits: number,
      _level: number,
      _memLevel: number,
      _strategy: number,
      writeState: Uint32Array,
      processCallback: () => void,
      _dictionary?: Uint8Array,
    ) {
      this.writeState = writeState;
      this.processCallback = processCallback;
    }

    direction(): ZlibDirection {
      return MODE_INFO[this.mode].direction;
    }

    formatFor(wholeInput: Uint8Array): ZlibFormat {
      if (this.resolvedFormat) return this.resolvedFormat;
      const declared = MODE_INFO[this.mode].format;
      this.resolvedFormat = declared === "auto" ? sniffFormat(wholeInput) : declared;
      return this.resolvedFormat;
    }

    drain(out: Uint8Array, outOff: number, outLen: number): number {
      // Must leave a null pendingOutput null (not turn it into an empty-but-non-null array):
      // null vs. "computed, possibly empty" is exactly the signal write()/writeSync() use to
      // decide whether the whole-buffer compression has run yet.
      if (!this.pendingOutput) return 0;
      const n = Math.min(this.pendingOutput.length, outLen);
      out.set(this.pendingOutput.subarray(0, n), outOff);
      this.pendingOutput = this.pendingOutput.subarray(n);
      return n;
    }

    reportState(availOut: number, availIn: number) {
      if (!this.writeState) return;
      this.writeState[0] = availOut;
      this.writeState[1] = availIn;
    }

    fail(error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      // Z_DATA_ERROR (-3): the closest real zlib return code for "malformed compressed input",
      // the overwhelming majority of what can actually go wrong here.
      this.onerror?.(message, -3, "Z_DATA_ERROR");
    }

    defer(fn: () => void) {
      const release = ctx.loop.ref();
      ctx.loop.post(() => {
        try {
          fn();
        } finally {
          release();
        }
      });
    }

    takeInput(inBuf: Uint8Array, inOff: number, inLen: number) {
      // A Buffer's own slice() returns a VIEW, not a copy; force a real copy since this chunk
      // must outlive the caller's own buffer reuse.
      if (inLen > 0) this.inputChunks.push(Uint8Array.prototype.slice.call(inBuf, inOff, inOff + inLen));
    }

    write(flushFlag: number, inBuf: Uint8Array, inOff: number, inLen: number, outBuf: Uint8Array, outOff: number, outLen: number) {
      if (this.closed) return;
      this.takeInput(inBuf, inOff, inLen);

      if (flushFlag !== Z_FINISH || this.pendingOutput !== null) {
        // Buffering only (not finished yet), or draining an already-computed result.
        const produced = this.drain(outBuf, outOff, outLen);
        this.reportState(outLen - produced, 0);
        this.defer(() => this.processCallback?.call(this));
        return;
      }

      const whole = concatBytes(this.inputChunks.length ? this.inputChunks : [new Uint8Array(0)]);
      this.inputChunks = [];
      const format = this.formatFor(whole);
      const release = ctx.loop.ref();
      // Success and failure are mutually exclusive outcomes here, exactly like the real native
      // binding: on error, only `onerror` fires (self.destroy(error), routed to the stream's own
      // 'error' event) - processCallback must NOT also run, or the stream gets told "there's an
      // error, destroy yourself" and "here's more output, keep going" for the same failed op.
      runZlibOnce(format, this.direction(), whole).then(
        (result) => {
          this.pendingOutput = result;
          const produced = this.drain(outBuf, outOff, outLen);
          this.reportState(outLen - produced, 0);
          ctx.loop.post(() => {
            try {
              this.processCallback?.call(this);
            } finally {
              release();
            }
          });
        },
        (error) => {
          ctx.loop.post(() => {
            try {
              this.fail(error);
            } finally {
              release();
            }
          });
        },
      );
    }

    writeSync(flushFlag: number, inBuf: Uint8Array, inOff: number, inLen: number, outBuf: Uint8Array, outOff: number, outLen: number) {
      if (this.closed) return;
      this.takeInput(inBuf, inOff, inLen);

      if (flushFlag === Z_FINISH && this.pendingOutput === null) {
        const whole = concatBytes(this.inputChunks.length ? this.inputChunks : [new Uint8Array(0)]);
        this.inputChunks = [];
        const format = this.formatFor(whole);
        if (!ctx.spawnSync) throw new Error("zlib sync operations need a spawnSync client");
        try {
          const request = encodeRequest([encodeString(format), encodeString(this.direction()), whole]);
          this.pendingOutput = ctx.spawnSync.call(OP_ZLIB_SYNC, request);
        } catch (error) {
          this.pendingOutput = new Uint8Array(0);
          this.fail(error);
        }
      }

      const produced = this.drain(outBuf, outOff, outLen);
      this.reportState(outLen - produced, 0);
    }

    params(_level: number, _strategy: number) {
      // No equivalent in the Compression Streams API - ignored (see init()).
    }

    reset() {
      this.inputChunks = [];
      this.pendingOutput = null;
      this.resolvedFormat = null;
    }

    close() {
      this.closed = true;
      this.inputChunks = [];
      this.pendingOutput = null;
    }
  }

  return { Zlib, crc32: crc32Native };
};

// ---- crc32 ------------------------------------------------------------------------------------
// Standard table-driven CRC-32 (IEEE 802.3, the same polynomial gzip/zlib use). `value` is a prior
// CRC to continue from (real zlib.crc32(data, value)'s own contract: crc32(b, crc32(a)) ===
// crc32(concat(a, b))) - cross-checked byte-for-byte against local Node 24's own zlib.crc32() in
// this binding's test.
const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

const crc32Native = (data: Uint8Array | string, value = 0): number => {
  const bytes = typeof data === "string" ? new TextEncoder().encode(data) : data;
  let crc = (value ^ 0xffffffff) >>> 0;
  for (let i = 0; i < bytes.length; i++) {
    crc = (CRC_TABLE[(crc ^ bytes[i]) & 0xff] ^ (crc >>> 8)) >>> 0;
  }
  return (crc ^ 0xffffffff) >>> 0;
};

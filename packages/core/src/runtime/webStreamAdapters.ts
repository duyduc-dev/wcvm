// `internal/webstreams/adapters` - what `Readable.fromWeb/toWeb`, `Writable.fromWeb/toWeb` and
// `Duplex.fromWeb/toWeb` call (lazily, on first use) to convert between Node streams and WHATWG streams.
//
// Node's own module is the tip of `internal/webstreams/*`: a second, parallel implementation of the
// whole WHATWG streams API in JS (plus worker-transfer plumbing in `internal/worker/io`). This sandbox
// runs in a browser that already ships the real thing, so vendoring that would duplicate it and make
// `Readable.toWeb(x) instanceof ReadableStream` false. These adapters are written over the platform's
// own classes instead. Found for real with Next.js: it calls `Readable.toWeb(req)` for every request,
// and the missing module destroyed every page response before a byte was written.

import type { BuiltinFactory } from "./node/types";

interface IWebStreamClasses {
  ReadableStream: typeof ReadableStream;
  WritableStream: typeof WritableStream;
}

export const createWebStreamAdaptersShim = (
  web: IWebStreamClasses,
  requireBuiltin: (id: string) => any,
): BuiltinFactory => (_exports, _require, module) => {
  const { Readable, Writable, Duplex } = requireBuiltin("stream");
  const { Buffer } = requireBuiltin("buffer");
  const { ReadableStream, WritableStream } = web;

  /** A web stream's chunks are arbitrary (`Uint8Array`s for byte streams); a non-object-mode Node stream wants Buffers. */
  const toNodeChunk = (chunk: unknown, objectMode: boolean): unknown => {
    if (objectMode || chunk === null || chunk === undefined) return chunk;
    if (Buffer.isBuffer(chunk)) return chunk;
    if (chunk instanceof Uint8Array) return Buffer.from(chunk.buffer, chunk.byteOffset, chunk.byteLength);
    if (ArrayBuffer.isView(chunk)) return Buffer.from(chunk.buffer, chunk.byteOffset, chunk.byteLength);
    if (chunk instanceof ArrayBuffer) return Buffer.from(chunk);
    return chunk; // a string: Node decodes it with the stream's encoding
  };

  /** What goes into a web stream from a Node one: bytes as a plain `Uint8Array` (a Buffer's pooled
   *  backing store must not be handed on as if it were this chunk's alone). */
  const toWebChunk = (chunk: unknown, objectMode: boolean): unknown => {
    if (objectMode) return chunk;
    if (typeof chunk === "string") return new TextEncoder().encode(chunk);
    if (ArrayBuffer.isView(chunk)) return new Uint8Array(chunk.buffer.slice(chunk.byteOffset, chunk.byteOffset + chunk.byteLength));
    return chunk;
  };

  // ---- web ReadableStream -> Node Readable ---------------------------------------------------

  const newStreamReadableFromReadableStream = (
    readableStream: ReadableStream,
    options: { objectMode?: boolean; highWaterMark?: number; encoding?: string; signal?: AbortSignal } = {},
  ) => {
    if (!(readableStream instanceof ReadableStream)) {
      throw Object.assign(new TypeError('The "readableStream" argument must be an instance of ReadableStream.'), { code: "ERR_INVALID_ARG_TYPE" });
    }
    const { objectMode = false, highWaterMark, encoding, signal } = options;
    const reader = readableStream.getReader();
    let closed = false;
    // Surface a stream that errors while nobody is reading it (read() only runs on demand).
    reader.closed.then(
      () => {},
      () => {},
    );
    const readable = new Readable({
      objectMode,
      highWaterMark,
      encoding,
      signal,
      read() {
        reader.read().then(
          ({ value, done }: ReadableStreamReadResult<unknown>) => {
            if (done) {
              closed = true;
              this.push(null);
            } else {
              this.push(toNodeChunk(value, objectMode));
            }
          },
          (error: unknown) => this.destroy(error),
        );
      },
      destroy(error: Error | null, callback: (error?: Error | null) => void) {
        if (closed) return callback(error);
        reader.cancel(error ?? undefined).then(
          () => callback(error),
          (cancelError: Error) => callback(error ?? cancelError),
        );
      },
    });
    return readable;
  };

  // ---- Node Readable -> web ReadableStream ---------------------------------------------------

  const newReadableStreamFromStreamReadable = (streamReadable: any, options: { strategy?: QueuingStrategy } = {}) => {
    const objectMode = Boolean(streamReadable.readableObjectMode);
    const strategy = options.strategy ?? { highWaterMark: objectMode ? (streamReadable.readableHighWaterMark ?? 16) : 1 };
    if (streamReadable.destroyed || streamReadable.readableEnded) {
      return new ReadableStream({
        start(controller) {
          if (streamReadable.errored) controller.error(streamReadable.errored);
          else controller.close();
        },
      });
    }
    let controller!: ReadableStreamDefaultController;
    let finished = false;
    const finish = (error?: unknown): void => {
      if (finished) return;
      finished = true;
      try {
        if (error) controller.error(error);
        else controller.close();
      } catch {
        /* already closed/errored by cancel() */
      }
    };
    return new ReadableStream(
      {
        start(c) {
          controller = c;
          streamReadable.pause();
          streamReadable.on("data", (chunk: unknown) => {
            if (finished) return;
            controller.enqueue(toWebChunk(chunk, objectMode) as never);
            if ((controller.desiredSize ?? 1) <= 0) streamReadable.pause();
          });
          streamReadable.on("end", () => finish());
          streamReadable.on("error", (error: unknown) => finish(error));
          streamReadable.on("close", () => finish(streamReadable.errored ?? undefined));
        },
        pull() {
          streamReadable.resume();
        },
        cancel(reason: unknown) {
          finished = true;
          streamReadable.destroy(reason instanceof Error ? reason : undefined);
        },
      },
      strategy,
    );
  };

  // ---- web WritableStream -> Node Writable ---------------------------------------------------

  const newStreamWritableFromWritableStream = (
    writableStream: WritableStream,
    options: { decodeStrings?: boolean; highWaterMark?: number; objectMode?: boolean; signal?: AbortSignal } = {},
  ) => {
    if (!(writableStream instanceof WritableStream)) {
      throw Object.assign(new TypeError('The "writableStream" argument must be an instance of WritableStream.'), { code: "ERR_INVALID_ARG_TYPE" });
    }
    const { decodeStrings = true, highWaterMark, objectMode = false, signal } = options;
    const writer = writableStream.getWriter();
    let ended = false;
    writer.closed.then(
      () => {},
      () => {},
    );
    return new Writable({
      decodeStrings,
      highWaterMark,
      objectMode,
      signal,
      write(chunk: unknown, _encoding: string, callback: (error?: Error | null) => void) {
        writer.write(chunk as never).then(() => callback(), callback);
      },
      final(callback: (error?: Error | null) => void) {
        ended = true;
        writer.close().then(() => callback(), callback);
      },
      destroy(error: Error | null, callback: (error?: Error | null) => void) {
        if (ended) return callback(error);
        writer.abort(error ?? undefined).then(
          () => callback(error),
          (abortError: Error) => callback(error ?? abortError),
        );
      },
    });
  };

  // ---- Node Writable -> web WritableStream ---------------------------------------------------

  const newWritableStreamFromStreamWritable = (streamWritable: any) => {
    const objectMode = Boolean(streamWritable.writableObjectMode);
    return new WritableStream(
      {
        write(chunk: unknown) {
          return new Promise<void>((resolve, reject) => {
            streamWritable.write(objectMode ? chunk : toNodeChunk(chunk, false), (error?: Error | null) => (error ? reject(error) : resolve()));
          });
        },
        close() {
          return new Promise<void>((resolve, reject) => {
            if (streamWritable.writableFinished) return resolve();
            streamWritable.end((error?: Error | null) => (error ? reject(error) : resolve()));
          });
        },
        abort(reason: unknown) {
          streamWritable.destroy(reason instanceof Error ? reason : undefined);
        },
      },
      { highWaterMark: Math.max(1, streamWritable.writableHighWaterMark ?? 1), size: () => 1 },
    );
  };

  // ---- pairs / duplex ------------------------------------------------------------------------

  const newStreamDuplexFromReadableWritablePair = (
    pair: { readable: ReadableStream; writable: WritableStream },
    options: { allowHalfOpen?: boolean; decodeStrings?: boolean; encoding?: string; highWaterMark?: number; objectMode?: boolean; signal?: AbortSignal } = {},
  ) => {
    const reader = pair.readable.getReader();
    const writer = pair.writable.getWriter();
    const { objectMode = false } = options;
    reader.closed.then(() => {}, () => {});
    writer.closed.then(() => {}, () => {});
    return new Duplex({
      ...options,
      read() {
        reader.read().then(
          ({ value, done }: ReadableStreamReadResult<unknown>) => (done ? this.push(null) : this.push(toNodeChunk(value, objectMode))),
          (error: unknown) => this.destroy(error),
        );
      },
      write(chunk: unknown, _encoding: string, callback: (error?: Error | null) => void) {
        writer.write(chunk as never).then(() => callback(), callback);
      },
      final(callback: (error?: Error | null) => void) {
        writer.close().then(() => callback(), callback);
      },
      destroy(error: Error | null, callback: (error?: Error | null) => void) {
        Promise.allSettled([reader.cancel(error ?? undefined), writer.abort(error ?? undefined)]).then(() => callback(error));
      },
    });
  };

  const newReadableWritablePairFromDuplex = (duplex: any) => ({
    readable: newReadableStreamFromStreamReadable(duplex),
    writable: newWritableStreamFromStreamWritable(duplex),
  });

  module.exports = {
    newStreamReadableFromReadableStream,
    newReadableStreamFromStreamReadable,
    newStreamWritableFromWritableStream,
    newWritableStreamFromStreamWritable,
    newStreamDuplexFromReadableWritablePair,
    newReadableWritablePairFromDuplex,
  };
};

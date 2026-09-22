// internalBinding('stream_wrap')'s shared scratch buffer: real Node's C++ layer writes a
// synchronous read/write completion here for whichever handle type (pipe_wrap, tcp_wrap, ...)
// just finished an operation, and internal/stream_base_commons.js reads it straight back - ONE
// array per realm, since only one stream operation is ever "in flight" synchronously at a time.
// Every wrap binding that shares a realm (identified by `ctx` object identity) must use the
// SAME instance - a different one would silently disconnect a handle's writes/reads from what
// net.js/child_process.js actually observe. Values must round-trip negative uv codes, hence
// Int32, not Uint32.

export const K_READ_BYTES_OR_ERROR = 0;
export const K_ARRAY_BUFFER_OFFSET = 1;
export const K_BYTES_WRITTEN = 2;
export const K_LAST_WRITE_WAS_ASYNC = 3;

const states = new WeakMap<object, Int32Array>();

export const streamBaseStateFor = (ctx: object): Int32Array => {
  let state = states.get(ctx);
  if (!state) {
    state = new Int32Array(4);
    states.set(ctx, state);
  }
  return state;
};

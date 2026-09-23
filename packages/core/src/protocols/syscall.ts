// Synchronous syscall ABI between a process worker (caller) and whatever
// services it (the kernel or the file system worker).
//
// Guest code needs calls that LOOK synchronous (`readFileSync`), but browsers
// never let a thread block on async work - except a Worker, where
// `Atomics.wait` genuinely parks the thread. So a request is written into a
// SharedArrayBuffer, the worker parks, the servicer answers into the same
// buffer and wakes it.
//
// Kept dependency-free and limited to erasable TypeScript syntax (no enums, no
// parameter properties) so it can be imported as-is from Node worker_threads
// in tests, with no build step.
//
// Memory layout of one SharedArrayBuffer (one per client/process):
//
//   [ control: 6 x Int32 = 24 bytes ][ data region: DATA_BYTES ]
//
//   control[0] STATE   the word we Atomics.wait / Atomics.notify on
//   control[1] OPCODE  which syscall
//   control[2] REQ_LEN request bytes in the data region
//   control[3] RES_LEN response bytes in the data region
//   control[4] SIGNAL  reserved: pending-signal bitmask, servicer -> caller
//   control[5] -       reserved: keeps the data region 8-byte aligned
//
// Request frame (data region):
//   [ flags: u32 ][ fieldCount: u32 ]( [ len: u32 ][ bytes ] )*
//
// Response:
//   STATE_RESPONSE_OK  -> raw bytes, meaning is opcode-specific
//   STATE_RESPONSE_ERR -> UTF-8 errno code ("ENOENT", ...)
//
// INVARIANT: every request and response must fit in DATA_BYTES. Large payloads
// are the caller's job to chunk; an oversize request throws EMSGSIZE, and an
// oversize response is answered with EMSGSIZE rather than left hanging.

export const CTRL_SLOTS = 6;
export const CTRL_BYTES = CTRL_SLOTS * 4;
export const DATA_BYTES = 1 << 20;
export const SAB_BYTES = CTRL_BYTES + DATA_BYTES;

export const I_STATE = 0;
export const I_OPCODE = 1;
export const I_REQ_LEN = 2;
export const I_RES_LEN = 3;
export const I_SIGNAL = 4;

export const STATE_IDLE = 0;
export const STATE_REQUEST = 1;
export const STATE_RESPONSE_OK = 2;
export const STATE_RESPONSE_ERR = 3;

export const FLAG_NONE = 0;
export const FLAG_RECURSIVE = 1;
export const FLAG_NO_FOLLOW = 2;

export const ERR_MSG_SIZE = "EMSGSIZE";

const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder();

export class SyscallError extends Error {
  readonly code: string;

  constructor(code: string, options?: ErrorOptions) {
    super(code, options);
    this.name = "SyscallError";
    this.code = code;
  }
}

export interface ISyscallViews {
  ctrl: Int32Array;
  data: Uint8Array;
}

export interface ISyscallRequest {
  opcode: number;
  flags: number;
  /** Views into the shared data region: copy them if they must outlive the response. */
  fields: Uint8Array[];
}

export const createSyscallBuffer = (): SharedArrayBuffer =>
  new SharedArrayBuffer(SAB_BYTES);

export const makeViews = (sab: SharedArrayBuffer): ISyscallViews => ({
  ctrl: new Int32Array(sab, 0, CTRL_SLOTS),
  data: new Uint8Array(sab, CTRL_BYTES, sab.byteLength - CTRL_BYTES),
});

// ---- scalar / string helpers ---------------------------------------------

export const encodeString = (value: string): Uint8Array =>
  textEncoder.encode(value);

// Browsers reject TextDecoder.decode() on a view over a SharedArrayBuffer
// ("must not be shared"), though Node accepts it. Every request field is such
// a view, so copy first (slice() always yields a non-shared buffer).
export const decodeBytes = (bytes: Uint8Array): string =>
  textDecoder.decode(
    bytes.buffer instanceof SharedArrayBuffer ? bytes.slice() : bytes,
  );

export const u32ToBytes = (value: number): Uint8Array => {
  const bytes = new Uint8Array(4);
  new DataView(bytes.buffer).setUint32(0, value, true);
  return bytes;
};

export const bytesToU32 = (bytes: Uint8Array): number =>
  new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getUint32(
    0,
    true,
  );

export const f64ToBytes = (value: number): Uint8Array => {
  const bytes = new Uint8Array(8);
  new DataView(bytes.buffer).setFloat64(0, value, true);
  return bytes;
};

export const bytesToF64 = (bytes: Uint8Array): number =>
  new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getFloat64(
    0,
    true,
  );

// ---- request framing ------------------------------------------------------

export const encodeRequest = (
  fields: Uint8Array[],
  flags: number = FLAG_NONE,
): Uint8Array => {
  let size = 8;
  for (const field of fields) size += 4 + field.length;

  const out = new Uint8Array(size);
  const view = new DataView(out.buffer);
  view.setUint32(0, flags, true);
  view.setUint32(4, fields.length, true);

  let offset = 8;
  for (const field of fields) {
    view.setUint32(offset, field.length, true);
    out.set(field, offset + 4);
    offset += 4 + field.length;
  }
  return out;
};

export const decodeRequest = (
  bytes: Uint8Array,
): { flags: number; fields: Uint8Array[] } => {
  if (bytes.length < 8) throw new SyscallError("EPROTO");
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const flags = view.getUint32(0, true);
  const count = view.getUint32(4, true);

  const fields: Uint8Array[] = [];
  let offset = 8;
  for (let i = 0; i < count; i++) {
    if (offset + 4 > bytes.length) throw new SyscallError("EPROTO");
    const len = view.getUint32(offset, true);
    offset += 4;
    if (offset + len > bytes.length) throw new SyscallError("EPROTO");
    fields.push(bytes.subarray(offset, offset + len));
    offset += len;
  }
  return { flags, fields };
};

// ---- caller side ----------------------------------------------------------

export interface ISyscallClientParams extends ISyscallViews {
  /**
   * Wakes whoever services `opcode` (typically a postMessage doorbell to the
   * kernel or the fs worker). Called after the request is published.
   */
  notify: (opcode: number) => void;
}

export interface ISyscallClient {
  /**
   * Issues one syscall and blocks until it is answered. Returns a copy of the
   * response bytes; throws SyscallError carrying the servicer's errno.
   * Must only be called from a Worker (the main thread cannot block).
   */
  call: (opcode: number, request: Uint8Array) => Uint8Array;
}

export const createSyscallClient = ({
  ctrl,
  data,
  notify,
}: ISyscallClientParams): ISyscallClient => {
  const call = (opcode: number, request: Uint8Array): Uint8Array => {
    if (request.length > data.length) throw new SyscallError(ERR_MSG_SIZE);

    data.set(request, 0);
    Atomics.store(ctrl, I_OPCODE, opcode);
    Atomics.store(ctrl, I_REQ_LEN, request.length);
    Atomics.store(ctrl, I_STATE, STATE_REQUEST);

    notify(opcode);

    // Re-check on every wake: a wake is not proof of an answer.
    while (Atomics.load(ctrl, I_STATE) === STATE_REQUEST) {
      Atomics.wait(ctrl, I_STATE, STATE_REQUEST);
    }

    const state = Atomics.load(ctrl, I_STATE);
    const payload = data.slice(0, Atomics.load(ctrl, I_RES_LEN));
    Atomics.store(ctrl, I_STATE, STATE_IDLE);

    if (state === STATE_RESPONSE_ERR) {
      throw new SyscallError(decodeBytes(payload));
    }
    return payload;
  };

  return { call };
};

// ---- servicer side --------------------------------------------------------

/** True when the caller has published a request that has not been answered. */
export const hasPendingRequest = ({ ctrl }: ISyscallViews): boolean =>
  Atomics.load(ctrl, I_STATE) === STATE_REQUEST;

export const readRequest = ({ ctrl, data }: ISyscallViews): ISyscallRequest => {
  const opcode = Atomics.load(ctrl, I_OPCODE);
  const length = Atomics.load(ctrl, I_REQ_LEN);
  const { flags, fields } = decodeRequest(data.subarray(0, length));
  return { opcode, flags, fields };
};

const finish = (
  { ctrl, data }: ISyscallViews,
  state: number,
  payload: Uint8Array,
): void => {
  data.set(payload, 0);
  Atomics.store(ctrl, I_RES_LEN, payload.length);
  Atomics.store(ctrl, I_STATE, state);
  Atomics.notify(ctrl, I_STATE);
};

export const respondErr = (views: ISyscallViews, code: string): void => {
  finish(views, STATE_RESPONSE_ERR, encodeString(code));
};

export const respondOk = (
  views: ISyscallViews,
  payload: Uint8Array = new Uint8Array(0),
): void => {
  if (payload.length > views.data.length) {
    respondErr(views, ERR_MSG_SIZE);
    return;
  }
  finish(views, STATE_RESPONSE_OK, payload);
};

// ---- opcodes ----------------------------------------------------------------
//
// Opcodes 1..FS_OPCODE_MAX are file system calls, serviced by the File System
// Worker. Everything from KERNEL_OPCODE_MIN up (spawn, kill, listen, fetch, ...)
// is serviced by the kernel. Field layouts, all little-endian:
//
//   OP_READ_FILE  path                          -> raw bytes (EMSGSIZE if too big)
//   OP_WRITE_FILE path, bytes                   -> empty
//   OP_EXISTS     path                          -> 1 byte: 0 | 1
//   OP_READDIR    path                          -> JSON string[]
//   OP_MKDIR      path            [FLAG_RECURSIVE] -> empty
//   OP_STAT/LSTAT path                          -> JSON IStat
//   OP_UNLINK / OP_RMDIR path                   -> empty
//   OP_RM         path            [FLAG_RECURSIVE] -> empty
//   OP_RENAME     from, to                      -> empty
//   OP_SYMLINK    target, path                  -> empty
//   OP_READLINK   path                          -> UTF-8 target
//   OP_REALPATH   path                          -> UTF-8 path
//   OP_CHMOD      path, u32 mode                -> empty
//   OP_OPEN       path, u32 flags, u32 mode     -> u32 fd
//   OP_CLOSE      u32 fd                        -> empty
//   OP_FD_READ    u32 fd, u32 len, f64 pos      -> raw bytes   (pos < 0: use cursor)
//   OP_FD_WRITE   u32 fd, f64 pos, bytes        -> u32 written (pos < 0: use cursor)
//   OP_FSTAT      u32 fd                        -> JSON IStat
//   OP_FTRUNCATE  u32 fd, f64 length            -> empty
//   OP_LINK       existing, path                -> empty
//   OP_UTIMES     path, f64 atimeMs, f64 mtimeMs [FLAG_NO_FOLLOW] -> empty
//   OP_FUTIMES    u32 fd, f64 atimeMs, f64 mtimeMs -> empty
//   OP_READDIR_KINDS path                       -> JSON [name, "file"|"dir"|"symlink"][]
//   OP_WATCH_START path            [FLAG_RECURSIVE] -> u32 watchId (ENOENT if path doesn't exist)
//   OP_WATCH_STOP  u32 watchId                  -> empty (unknown/already-stopped id: also empty)
export const OP_READ_FILE = 1;
export const OP_WRITE_FILE = 2;
export const OP_EXISTS = 3;
export const OP_READDIR = 4;
export const OP_MKDIR = 5;
export const OP_STAT = 6;
export const OP_LSTAT = 7;
export const OP_UNLINK = 8;
export const OP_RMDIR = 9;
export const OP_RENAME = 10;
export const OP_SYMLINK = 11;
export const OP_READLINK = 12;
export const OP_OPEN = 13;
export const OP_CLOSE = 14;
export const OP_FD_READ = 15;
export const OP_FD_WRITE = 16;
export const OP_FSTAT = 17;
export const OP_FTRUNCATE = 18;
export const OP_REALPATH = 19;
export const OP_RM = 20;
export const OP_CHMOD = 21;
export const OP_LINK = 22;
export const OP_UTIMES = 23;
export const OP_FUTIMES = 24;
export const OP_READDIR_KINDS = 25;
export const OP_WATCH_START = 26;
export const OP_WATCH_STOP = 27;

export const FS_OPCODE_MAX = 63;
export const KERNEL_OPCODE_MIN = 64;

// Opcodes >= KERNEL_OPCODE_MIN are serviced by the Kernel Worker directly (a
// second SAB per process, doorbell straight to the kernel - see
// kernel/kernelSyncServer.ts), not the File System Worker.
//
//   OP_SPAWN_SYNC command, argsJson, cwd, envJson, input, u32 timeoutMs
//     -> u32 pid, status (u32, 0xFFFFFFFF = null/killed-by-signal), signal
//        (UTF-8, empty = none), stdout bytes, stderr bytes - same
//        encodeRequest/decodeRequest field framing as a request, reused for
//        the response.
//     Combined stdout+stderr must fit in one DATA_BYTES window (EMSGSIZE
//     otherwise) - unlike fs, large output isn't chunked across calls.
export const OP_SPAWN_SYNC = KERNEL_OPCODE_MIN;

/** Sentinel for spawnSync's `status: null` (the child was killed by a signal). */
export const SPAWN_SYNC_NO_STATUS = 0xffffffff;

// A THIRD per-process SAB (kernel/netServer.ts), separate from spawnSync's: net.Server.listen()
// needs a globally-coordinated, synchronous answer (port 0 -> the actual assigned port; an
// explicit port already taken -> EADDRINUSE), matching real net.js's own contract (it emits
// 'listening' right after handle.listen() returns 0, with no further async confirmation
// awaited) - the only net operation that genuinely needs this. connect()/data/close are all
// naturally async (kernel/processes.ts's ordinary postMessage routing, like child_process).
//
//   OP_NET_LISTEN u32 port (0 = auto-assign), u32 backlog -> u32 assignedPort (EADDRINUSE if taken)
export const OP_NET_LISTEN = KERNEL_OPCODE_MIN + 1;

// zlib's `*Sync` functions (gzipSync/gunzipSync/deflateSync/inflateSync/...) genuinely block,
// like execSync/spawnSync - but unlike net.listen(), there's no cross-process/global state to
// coordinate, so this reuses spawnSync's own per-process SAB (kernel/kernelSyncServer.ts's
// `service()` dispatches on opcode) rather than adding a fourth one.
//
//   OP_ZLIB_SYNC format (UTF-8: "gzip"|"deflate"|"deflate-raw"),
//     direction (UTF-8: "compress"|"decompress"), input bytes
//     -> output bytes (EMSGSIZE if the whole result doesn't fit one DATA_BYTES window - same
//        documented limit OP_SPAWN_SYNC already has for its own combined stdout+stderr)
export const OP_ZLIB_SYNC = KERNEL_OPCODE_MIN + 2;

export const isFsOpcode = (opcode: number): boolean =>
  opcode >= 1 && opcode <= FS_OPCODE_MAX;

/** Max bytes per fd read/write, so each frame stays inside the data window. */
export const FD_CHUNK = 512 * 1024;

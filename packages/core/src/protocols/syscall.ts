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

export const decodeBytes = (bytes: Uint8Array): string =>
  textDecoder.decode(bytes);

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

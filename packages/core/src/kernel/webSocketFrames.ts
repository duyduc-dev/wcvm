// RFC 6455 framing, client side only: the kernel is always the CLIENT end of a preview WebSocket
// tunnel (kernel/previewWebSocket.ts) - the server end is a guest script's own real
// `http.Server` 'upgrade' handler (`ws`, Vite's HMR server, or hand-rolled), which already speaks
// the server side itself. So this only ever encodes masked frames (a client MUST mask - RFC 6455
// 5.3) and decodes the server's unmasked ones. No extensions are ever negotiated (the handshake
// never offers permessage-deflate), so any RSV bit set is a protocol error.

export const OPCODE_CONTINUATION = 0x0;
export const OPCODE_TEXT = 0x1;
export const OPCODE_BINARY = 0x2;
export const OPCODE_CLOSE = 0x8;
export const OPCODE_PING = 0x9;
export const OPCODE_PONG = 0xa;

/** A close status code: 1005 is "no status received" - never sent on the wire, only reported
 *  when a close frame arrives with an empty payload (RFC 6455 7.1.5). */
export const CLOSE_NO_STATUS = 1005;
/** Reported (never sent) when the connection dropped without a close frame at all. */
export const CLOSE_ABNORMAL = 1006;
export const CLOSE_PROTOCOL_ERROR = 1002;
export const CLOSE_INVALID_PAYLOAD = 1007;

export class WebSocketProtocolError extends Error {
  readonly closeCode: number;
  constructor(message: string, closeCode = CLOSE_PROTOCOL_ERROR) {
    super(message);
    this.name = "WebSocketProtocolError";
    this.closeCode = closeCode;
  }
}

const randomMask = (): Uint8Array => crypto.getRandomValues(new Uint8Array(4));

const TWO_POW_32 = 2 ** 32;

/** How many extended-length bytes a payload of `length` needs after the 7-bit length field. */
const extendedLengthBytes = (length: number): number => {
  if (length < 126) return 0;
  return length < 0x10000 ? 2 : 8;
};

/** One complete, masked client frame (always FIN - this side never fragments what it sends). */
export const encodeClientFrame = (opcode: number, payload: Uint8Array, mask: Uint8Array = randomMask()): Uint8Array => {
  const length = payload.length;
  const extended = extendedLengthBytes(length);
  const out = new Uint8Array(2 + extended + 4 + length);
  out[0] = 0x80 | opcode;
  if (extended === 0) {
    out[1] = 0x80 | length;
  } else if (extended === 2) {
    out[1] = 0x80 | 126;
    out[2] = length >>> 8;
    out[3] = length & 0xff;
  } else {
    out[1] = 0x80 | 127;
    const view = new DataView(out.buffer);
    view.setUint32(2, Math.floor(length / TWO_POW_32));
    view.setUint32(6, length >>> 0);
  }
  const maskOffset = 2 + extended;
  out.set(mask, maskOffset);
  const payloadOffset = maskOffset + 4;
  for (let i = 0; i < length; i++) out[payloadOffset + i] = payload[i] ^ mask[i & 3];
  return out;
};

/** A close frame's payload: a 2-byte status code, then an optional UTF-8 reason. No code at all
 *  means an empty payload (a valid close with no status - reported to the peer as 1005). */
export const encodeClosePayload = (code?: number, reason = ""): Uint8Array => {
  if (code === undefined) return new Uint8Array(0);
  const reasonBytes = new TextEncoder().encode(reason);
  const out = new Uint8Array(2 + reasonBytes.length);
  out[0] = code >>> 8;
  out[1] = code & 0xff;
  out.set(reasonBytes, 2);
  return out;
};

export const decodeClosePayload = (payload: Uint8Array): { code: number; reason: string } => {
  if (payload.length === 0) return { code: CLOSE_NO_STATUS, reason: "" };
  if (payload.length === 1) throw new WebSocketProtocolError("Close frame payload of 1 byte");
  const code = (payload[0] << 8) | payload[1];
  let reason: string;
  try {
    reason = new TextDecoder("utf-8", { fatal: true }).decode(payload.subarray(2));
  } catch {
    throw new WebSocketProtocolError("Close reason is not valid UTF-8", CLOSE_INVALID_PAYLOAD);
  }
  return { code, reason };
};

export interface IWebSocketReaderHandlers {
  /** A whole (reassembled, if it was fragmented) data message. */
  onMessage(opcode: typeof OPCODE_TEXT | typeof OPCODE_BINARY, payload: Uint8Array): void;
  /** A control frame (close/ping/pong) - always whole, never fragmented (RFC 6455 5.5). */
  onControl(opcode: typeof OPCODE_CLOSE | typeof OPCODE_PING | typeof OPCODE_PONG, payload: Uint8Array): void;
}

const concat = (a: Uint8Array, b: Uint8Array): Uint8Array => {
  if (a.length === 0) return b;
  const out = new Uint8Array(a.length + b.length);
  out.set(a, 0);
  out.set(b, a.length);
  return out;
};

/**
 * Incremental decoder for the server->client byte stream: feed it whatever chunks the virtual
 * TCP connection delivers (arbitrary boundaries, possibly several frames or half of one), and it
 * calls back once per complete message/control frame. Throws WebSocketProtocolError on anything
 * RFC 6455 says must fail the connection; the caller stops feeding after that.
 */
export class WebSocketReader {
  private buffer: Uint8Array = new Uint8Array(0);
  private fragmentOpcode: number | null = null;
  private fragments: Uint8Array[] = [];
  private readonly handlers: IWebSocketReaderHandlers;

  constructor(handlers: IWebSocketReaderHandlers) {
    this.handlers = handlers;
  }

  feed(chunk: Uint8Array): void {
    this.buffer = concat(this.buffer, chunk);
    for (;;) {
      const consumed = this.readFrame();
      if (consumed === 0) return;
      this.buffer = this.buffer.subarray(consumed);
    }
  }

  /** Parses (and dispatches) one frame off the front of the buffer; 0 if it isn't complete yet. */
  private readFrame(): number {
    const buf = this.buffer;
    if (buf.length < 2) return 0;
    const fin = (buf[0] & 0x80) !== 0;
    if ((buf[0] & 0x70) !== 0) throw new WebSocketProtocolError("Reserved bits set with no extension negotiated");
    const opcode = buf[0] & 0x0f;
    const masked = (buf[1] & 0x80) !== 0;
    let length = buf[1] & 0x7f;
    let offset = 2;
    if (length === 126) {
      if (buf.length < 4) return 0;
      length = (buf[2] << 8) | buf[3];
      offset = 4;
    } else if (length === 127) {
      if (buf.length < 10) return 0;
      const view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
      const high = view.getUint32(2);
      if (high > 0x1fffff) throw new WebSocketProtocolError("Frame length exceeds 2^53 - 1");
      length = high * TWO_POW_32 + view.getUint32(6);
      offset = 10;
    }
    const maskOffset = offset;
    if (masked) offset += 4;
    if (buf.length < offset + length) return 0;

    // A server MUST NOT mask (RFC 6455 5.1) - but unmasking costs nothing and the peer is always
    // a guest script in this same sandbox, so be lenient rather than fail a real dev server over it.
    const payload = buf.slice(offset, offset + length);
    if (masked) for (let i = 0; i < length; i++) payload[i] ^= buf[maskOffset + (i & 3)];

    this.dispatch(fin, opcode, payload);
    return offset + length;
  }

  private dispatch(fin: boolean, opcode: number, payload: Uint8Array) {
    if (opcode === OPCODE_CLOSE || opcode === OPCODE_PING || opcode === OPCODE_PONG) {
      if (!fin) throw new WebSocketProtocolError("Fragmented control frame");
      if (payload.length > 125) throw new WebSocketProtocolError("Control frame payload over 125 bytes");
      this.handlers.onControl(opcode, payload);
      return;
    }
    if (opcode === OPCODE_TEXT || opcode === OPCODE_BINARY) {
      if (this.fragmentOpcode !== null) throw new WebSocketProtocolError("New data frame before the previous message finished");
      if (fin) {
        this.handlers.onMessage(opcode, payload);
        return;
      }
      this.fragmentOpcode = opcode;
      this.fragments = [payload];
      return;
    }
    if (opcode === OPCODE_CONTINUATION) {
      if (this.fragmentOpcode === null) throw new WebSocketProtocolError("Continuation frame with no message in progress");
      this.fragments.push(payload);
      if (!fin) return;
      const whole = this.fragments.reduce((acc, part) => concat(acc, part), new Uint8Array(0));
      const messageOpcode = this.fragmentOpcode as typeof OPCODE_TEXT | typeof OPCODE_BINARY;
      this.fragmentOpcode = null;
      this.fragments = [];
      this.handlers.onMessage(messageOpcode, whole);
      return;
    }
    throw new WebSocketProtocolError(`Unknown opcode 0x${opcode.toString(16)}`);
  }
}

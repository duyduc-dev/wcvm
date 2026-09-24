// The SERVER side of RFC 6455 framing, for tests only: kernel/webSocketFrames.ts only ever needs
// the client side (the kernel is always the client of a preview WebSocket tunnel), but its tests
// need to play the server - send it unmasked frames and read back its masked ones.

/** An unmasked server->client frame, the shape a real server (e.g. the `ws` package) sends. */
export const serverFrame = (opcode: number, payload: Uint8Array, fin = true): Uint8Array => {
  const length = payload.length;
  let header: number[];
  if (length < 126) header = [length];
  else if (length < 0x10000) header = [126, length >>> 8, length & 0xff];
  else header = [127, 0, 0, 0, 0, (length >>> 24) & 0xff, (length >>> 16) & 0xff, (length >>> 8) & 0xff, length & 0xff];
  return new Uint8Array([(fin ? 0x80 : 0) | opcode, ...header, ...payload]);
};

export interface IDecodedClientFrame {
  fin: boolean;
  opcode: number;
  payload: Uint8Array;
}

/** Reads one masked client frame (the whole of `frame`), undoing the masking the way a real
 *  server would. Throws if it isn't masked or isn't exactly one frame long. */
export const decodeClientFrame = (frame: Uint8Array): IDecodedClientFrame => {
  if ((frame[1] & 0x80) === 0) throw new Error("client frame is not masked");
  let length = frame[1] & 0x7f;
  let offset = 2;
  if (length === 126) {
    length = (frame[2] << 8) | frame[3];
    offset = 4;
  } else if (length === 127) {
    length = new DataView(frame.buffer, frame.byteOffset).getUint32(6);
    offset = 10;
  }
  if (frame.length !== offset + 4 + length) throw new Error(`expected exactly one frame, got ${frame.length} bytes`);
  const mask = frame.subarray(offset, offset + 4);
  const payload = frame.slice(offset + 4).map((b, i) => b ^ mask[i & 3]);
  return { fin: (frame[0] & 0x80) !== 0, opcode: frame[0] & 0x0f, payload };
};

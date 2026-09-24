import { describe, expect, it } from "vitest";
import {
  CLOSE_NO_STATUS,
  OPCODE_BINARY,
  OPCODE_CLOSE,
  OPCODE_CONTINUATION,
  OPCODE_PING,
  OPCODE_TEXT,
  WebSocketProtocolError,
  WebSocketReader,
  decodeClosePayload,
  encodeClientFrame,
  encodeClosePayload,
} from "./webSocketFrames";
import { decodeClientFrame, serverFrame } from "../testing/webSocketServerFrames";

const text = (s: string) => new TextEncoder().encode(s);

const collect = () => {
  const messages: Array<{ opcode: number; payload: Uint8Array }> = [];
  const controls: Array<{ opcode: number; payload: Uint8Array }> = [];
  const reader = new WebSocketReader({
    onMessage: (opcode, payload) => messages.push({ opcode, payload }),
    onControl: (opcode, payload) => controls.push({ opcode, payload }),
  });
  return { reader, messages, controls };
};

describe("encodeClientFrame", () => {
  it("masks the payload with the given key and sets FIN", () => {
    const frame = encodeClientFrame(OPCODE_TEXT, text("Hello"), new Uint8Array([0x37, 0xfa, 0x21, 0x3d]));
    // RFC 6455 5.7's own example: a single-frame masked text message containing "Hello".
    expect([...frame]).toEqual([0x81, 0x85, 0x37, 0xfa, 0x21, 0x3d, 0x7f, 0x9f, 0x4d, 0x51, 0x58]);
  });

  it("uses a 16-bit extended length from 126 bytes and a 64-bit one from 64 KiB", () => {
    for (const size of [125, 126, 0xffff, 0x10000, 200_000]) {
      const payload = new Uint8Array(size).map((_, i) => i & 0xff);
      const decoded = decodeClientFrame(encodeClientFrame(OPCODE_BINARY, payload));
      expect(decoded).toEqual({ fin: true, opcode: OPCODE_BINARY, payload });
    }
  });

  it("picks a fresh random mask per frame by default", () => {
    const a = encodeClientFrame(OPCODE_TEXT, text("x"));
    const b = encodeClientFrame(OPCODE_TEXT, text("x"));
    const c = encodeClientFrame(OPCODE_TEXT, text("x"));
    const masks = new Set([a, b, c].map((f) => f.subarray(2, 6).join(",")));
    expect(masks.size).toBeGreaterThan(1);
  });
});

describe("close payloads", () => {
  it("round-trips a code and a UTF-8 reason", () => {
    expect(decodeClosePayload(encodeClosePayload(4001, "bye ✓"))).toEqual({ code: 4001, reason: "bye ✓" });
  });

  it("no code encodes as an empty payload, which decodes as 1005 (no status received)", () => {
    expect(encodeClosePayload().length).toBe(0);
    expect(decodeClosePayload(new Uint8Array(0))).toEqual({ code: CLOSE_NO_STATUS, reason: "" });
  });

  it("rejects a 1-byte payload and a reason that isn't valid UTF-8", () => {
    expect(() => decodeClosePayload(new Uint8Array([3]))).toThrow(WebSocketProtocolError);
    expect(() => decodeClosePayload(new Uint8Array([3, 232, 0xff]))).toThrow(expect.objectContaining({ closeCode: 1007 }));
  });
});

describe("WebSocketReader", () => {
  it("decodes several frames arriving in one chunk", () => {
    const { reader, messages, controls } = collect();
    reader.feed(new Uint8Array([...serverFrame(OPCODE_TEXT, text("a")), ...serverFrame(OPCODE_PING, text("p")), ...serverFrame(OPCODE_BINARY, new Uint8Array([1, 2]))]));
    expect(messages).toEqual([
      { opcode: OPCODE_TEXT, payload: text("a") },
      { opcode: OPCODE_BINARY, payload: new Uint8Array([1, 2]) },
    ]);
    expect(controls).toEqual([{ opcode: OPCODE_PING, payload: text("p") }]);
  });

  it("reassembles a frame split across arbitrary chunk boundaries, including mid-header", () => {
    const { reader, messages } = collect();
    const payload = new Uint8Array(70_000).map((_, i) => (i * 7) & 0xff);
    const frame = serverFrame(OPCODE_BINARY, payload);
    for (let i = 0; i < frame.length; i += 4099) reader.feed(frame.subarray(i, Math.min(frame.length, i + 4099)));
    reader.feed(new Uint8Array(0));
    expect(messages).toHaveLength(1);
    expect(messages[0].payload).toEqual(payload);
  });

  it("reassembles a fragmented message, with a control frame interleaved between fragments", () => {
    const { reader, messages, controls } = collect();
    reader.feed(serverFrame(OPCODE_TEXT, text("hel"), false));
    reader.feed(serverFrame(OPCODE_PING, new Uint8Array(0)));
    reader.feed(serverFrame(OPCODE_CONTINUATION, text("lo "), false));
    reader.feed(serverFrame(OPCODE_CONTINUATION, text("world")));
    expect(messages).toEqual([{ opcode: OPCODE_TEXT, payload: text("hello world") }]);
    expect(controls).toHaveLength(1);
  });

  it("unmasks a masked frame instead of rejecting it", () => {
    const { reader, messages } = collect();
    reader.feed(encodeClientFrame(OPCODE_TEXT, text("masked")));
    expect(messages).toEqual([{ opcode: OPCODE_TEXT, payload: text("masked") }]);
  });

  it("delivers a close frame's payload as a control frame", () => {
    const { reader, controls } = collect();
    reader.feed(serverFrame(OPCODE_CLOSE, encodeClosePayload(1000, "done")));
    expect(controls).toEqual([{ opcode: OPCODE_CLOSE, payload: encodeClosePayload(1000, "done") }]);
  });

  it.each([
    ["an RSV bit set", new Uint8Array([0x80 | 0x40 | OPCODE_TEXT, 0])],
    ["an unknown opcode", new Uint8Array([0x80 | 0x3, 0])],
    ["a fragmented control frame", new Uint8Array([OPCODE_PING, 0])],
    ["a control frame over 125 bytes", serverFrame(OPCODE_PING, new Uint8Array(126))],
    ["a continuation with no message in progress", serverFrame(OPCODE_CONTINUATION, text("x"))],
    ["a new data frame mid-message", new Uint8Array([...serverFrame(OPCODE_TEXT, text("a"), false), ...serverFrame(OPCODE_TEXT, text("b"))])],
  ])("rejects %s as a protocol error", (_name, bytes) => {
    const { reader } = collect();
    expect(() => reader.feed(bytes)).toThrow(WebSocketProtocolError);
  });
});

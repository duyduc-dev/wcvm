import { afterEach, describe, expect, it, vi } from "vitest";
import type { PreviewWebSocketEvent } from "../protocols/preview";
import { decodeClientFrame, serverFrame } from "../testing/webSocketServerFrames";
import { CLOSE_HANDSHAKE_TIMEOUT_MS, createPreviewWebSockets } from "./previewWebSocket";
import { OPCODE_BINARY, OPCODE_CLOSE, OPCODE_PING, OPCODE_PONG, OPCODE_TEXT, encodeClosePayload } from "./webSocketFrames";

const text = (s: string) => new TextEncoder().encode(s);
const decode = (b: Uint8Array) => new TextDecoder().decode(b);

const SWITCHING = "HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: x\r\n";

/** Plays kernel/netServer.ts (and the guest server behind it) for one tunnel module. */
const setup = () => {
  const connects: Array<{ ticket: number; port: number }> = [];
  const writes = new Map<number, Uint8Array[]>();
  const closed: number[] = [];
  const events: Array<{ id: number; event: PreviewWebSocketEvent }> = [];
  const ws = createPreviewWebSockets({
    connect: (ticket, port) => connects.push({ ticket, port }),
    writeData: (connId, chunk) => {
      if (!writes.has(connId)) writes.set(connId, []);
      writes.get(connId)!.push(chunk);
    },
    close: (connId) => closed.push(connId),
    emit: (id, event) => events.push({ id, event }),
  });
  /** Accepts the most recent connect() as `connId` and waits out the deferred handshake write. */
  const accept = async (connId: number) => {
    ws.onNetEvent({ type: "net:connectResult", ticket: connects.at(-1)!.ticket, ok: true, connId });
    await Promise.resolve();
  };
  const handshakeText = (connId: number) => decode(writes.get(connId)![0]);
  /** Every frame the client wrote after its handshake, unmasked. */
  const framesFrom = (connId: number) => writes.get(connId)!.slice(1).map(decodeClientFrame);
  const serverSends = (connId: number, bytes: Uint8Array | string) =>
    ws.onNetEvent({ type: "net:data", connId, chunk: typeof bytes === "string" ? text(bytes) : bytes });
  /** open() + accept + a 101, leaving socket `id` open on `connId`. */
  const openSocket = async (id: number, connId: number, protocols: string[] = []) => {
    ws.open({ id, port: 3000, path: "/ws", protocols });
    await accept(connId);
    serverSends(connId, `${SWITCHING}\r\n`);
  };
  return { ws, connects, writes, closed, events, accept, handshakeText, framesFrom, serverSends, openSocket };
};

afterEach(() => {
  vi.useRealTimers();
});

describe("preview WebSocket tunnel", () => {
  it("connects to the requested port and writes a real RFC 6455 upgrade request", async () => {
    const t = setup();
    t.ws.open({ id: 1, port: 5173, path: "/?token=abc", protocols: ["vite-hmr", "other"] });
    expect(t.connects).toEqual([{ ticket: expect.any(Number), port: 5173 }]);
    await t.accept(7);
    const request = t.handshakeText(7);
    expect(request).toMatch(/^GET \/\?token=abc HTTP\/1\.1\r\n/);
    expect(request).toContain("Host: localhost:5173\r\n");
    expect(request).toContain("Upgrade: websocket\r\n");
    expect(request).toContain("Connection: Upgrade\r\n");
    expect(request).toContain("Sec-WebSocket-Version: 13\r\n");
    expect(request).toMatch(/Sec-WebSocket-Key: [A-Za-z0-9+/]{22}==\r\n/);
    expect(request).toContain("Sec-WebSocket-Protocol: vite-hmr, other\r\n");
    expect(request.endsWith("\r\n\r\n")).toBe(true);
  });

  it("a 101 opens the socket, reporting the server's chosen subprotocol", async () => {
    const t = setup();
    t.ws.open({ id: 1, port: 3000, path: "/", protocols: ["vite-hmr"] });
    await t.accept(1);
    t.serverSends(1, `${SWITCHING}Sec-WebSocket-Protocol: vite-hmr\r\n\r\n`);
    expect(t.events).toEqual([{ id: 1, event: { kind: "open", protocol: "vite-hmr" } }]);
  });

  it("delivers a message that arrives in the same chunk as the 101", async () => {
    const t = setup();
    t.ws.open({ id: 1, port: 3000, path: "/", protocols: [] });
    await t.accept(1);
    t.serverSends(1, new Uint8Array([...text(`${SWITCHING}\r\n`), ...serverFrame(OPCODE_TEXT, text('{"type":"connected"}'))]));
    expect(t.events.map((e) => e.event)).toEqual([
      { kind: "open", protocol: "" },
      { kind: "message", data: '{"type":"connected"}' },
    ]);
  });

  it("delivers text as a string and binary as bytes", async () => {
    const t = setup();
    await t.openSocket(1, 1);
    t.serverSends(1, serverFrame(OPCODE_TEXT, text("héllo")));
    t.serverSends(1, serverFrame(OPCODE_BINARY, new Uint8Array([0, 255])));
    expect(t.events.slice(1).map((e) => e.event)).toEqual([
      { kind: "message", data: "héllo" },
      { kind: "message", data: new Uint8Array([0, 255]) },
    ]);
  });

  it("sends text and binary as masked frames of the right opcode", async () => {
    const t = setup();
    await t.openSocket(1, 1);
    t.ws.send(1, "hi");
    t.ws.send(1, new Uint8Array([1, 2, 3]));
    expect(t.framesFrom(1)).toEqual([
      { fin: true, opcode: OPCODE_TEXT, payload: text("hi") },
      { fin: true, opcode: OPCODE_BINARY, payload: new Uint8Array([1, 2, 3]) },
    ]);
  });

  it("answers a ping with a pong carrying the same payload", async () => {
    const t = setup();
    await t.openSocket(1, 1);
    t.serverSends(1, serverFrame(OPCODE_PING, text("beat")));
    expect(t.framesFrom(1)).toEqual([{ fin: true, opcode: OPCODE_PONG, payload: text("beat") }]);
    expect(t.events).toHaveLength(1); // just the open - a ping is never surfaced to the page
  });

  it("a server-initiated close is echoed back and reported as a clean close with its code and reason", async () => {
    const t = setup();
    await t.openSocket(1, 1);
    t.serverSends(1, serverFrame(OPCODE_CLOSE, encodeClosePayload(4000, "restarting")));
    expect(t.framesFrom(1)).toEqual([{ fin: true, opcode: OPCODE_CLOSE, payload: encodeClosePayload(4000) }]);
    expect(t.closed).toEqual([1]);
    expect(t.events.at(-1)).toEqual({ id: 1, event: { kind: "close", code: 4000, reason: "restarting", wasClean: true } });
  });

  it("a client-initiated close sends a close frame and finishes on the server's echo", async () => {
    const t = setup();
    await t.openSocket(1, 1);
    t.ws.close(1, 1000, "bye");
    expect(t.framesFrom(1)).toEqual([{ fin: true, opcode: OPCODE_CLOSE, payload: encodeClosePayload(1000, "bye") }]);
    expect(t.closed).toEqual([]); // still waiting for the server's side of the close handshake
    t.ws.send(1, "dropped"); // CLOSING: silently discarded
    t.serverSends(1, serverFrame(OPCODE_TEXT, text("also dropped")));
    t.serverSends(1, serverFrame(OPCODE_CLOSE, encodeClosePayload(1000, "bye")));
    expect(t.framesFrom(1)).toHaveLength(1);
    expect(t.closed).toEqual([1]);
    expect(t.events.slice(1)).toEqual([{ id: 1, event: { kind: "close", code: 1000, reason: "bye", wasClean: true } }]);
  });

  it("a client-initiated close gives up after a timeout if the server never answers", async () => {
    vi.useFakeTimers();
    const t = setup();
    await t.openSocket(1, 1);
    t.ws.close(1);
    vi.advanceTimersByTime(CLOSE_HANDSHAKE_TIMEOUT_MS);
    expect(t.closed).toEqual([1]);
    expect(t.events.at(-1)).toEqual({ id: 1, event: { kind: "close", code: 1006, reason: "", wasClean: false } });
  });

  it("the connection dropping without a close frame is an unclean 1006 close", async () => {
    const t = setup();
    await t.openSocket(1, 1);
    t.ws.onNetEvent({ type: "net:close", connId: 1 });
    expect(t.events.at(-1)).toEqual({ id: 1, event: { kind: "close", code: 1006, reason: "", wasClean: false } });
    t.ws.onNetEvent({ type: "net:close", connId: 1 });
    expect(t.events.filter((e) => e.event.kind === "close")).toHaveLength(1);
  });

  it("nobody listening on the port fails the socket without ever opening it", () => {
    const t = setup();
    t.ws.open({ id: 1, port: 1, path: "/", protocols: [] });
    t.ws.onNetEvent({ type: "net:connectResult", ticket: t.connects[0].ticket, ok: false, code: "ECONNREFUSED" });
    expect(t.events).toEqual([{ id: 1, event: { kind: "close", code: 1006, reason: "", wasClean: false } }]);
  });

  it.each([
    ["a plain 404", "HTTP/1.1 404 Not Found\r\nContent-Length: 0\r\n\r\n"],
    ["a 200 with no upgrade", "HTTP/1.1 200 OK\r\nContent-Length: 2\r\n\r\nok"],
    ["a 426 that merely mentions Upgrade", "HTTP/1.1 426 Upgrade Required\r\nUpgrade: websocket\r\nContent-Length: 0\r\n\r\n"],
    ["a subprotocol that was never offered", `${SWITCHING}Sec-WebSocket-Protocol: surprise\r\n\r\n`],
    ["a malformed status line", "garbage\r\n\r\n"],
  ])("rejects %s as a failed handshake", async (_name, response) => {
    const t = setup();
    t.ws.open({ id: 1, port: 3000, path: "/", protocols: ["mine"] });
    await t.accept(1);
    t.serverSends(1, response);
    expect(t.events).toEqual([{ id: 1, event: { kind: "close", code: 1006, reason: "", wasClean: false } }]);
    expect(t.closed).toEqual([1]);
  });

  it("a protocol violation from the server tells it why (1002) and fails the socket", async () => {
    const t = setup();
    await t.openSocket(1, 1);
    t.serverSends(1, new Uint8Array([0x80 | 0x3, 0])); // unknown opcode
    expect(t.framesFrom(1)).toEqual([{ fin: true, opcode: OPCODE_CLOSE, payload: encodeClosePayload(1002) }]);
    expect(t.events.at(-1)?.event).toEqual({ kind: "close", code: 1006, reason: "", wasClean: false });
  });

  it("invalid UTF-8 in a text message fails the socket", async () => {
    const t = setup();
    await t.openSocket(1, 1);
    t.serverSends(1, serverFrame(OPCODE_TEXT, new Uint8Array([0xc3, 0x28])));
    expect(t.events.at(-1)?.event).toEqual({ kind: "close", code: 1006, reason: "", wasClean: false });
  });

  it("closing while still connecting fails the socket and drops the connection once it arrives", async () => {
    const t = setup();
    t.ws.open({ id: 1, port: 3000, path: "/", protocols: [] });
    t.ws.close(1, 1000);
    expect(t.events).toEqual([{ id: 1, event: { kind: "close", code: 1006, reason: "", wasClean: false } }]);
    await t.accept(9);
    expect(t.closed).toEqual([9]);
    expect(t.writes.has(9)).toBe(false); // never sent a handshake on the late connection
  });

  it("sending before the socket is open is ignored rather than written mid-handshake", async () => {
    const t = setup();
    t.ws.open({ id: 1, port: 3000, path: "/", protocols: [] });
    await t.accept(1);
    t.ws.send(1, "too early");
    expect(t.writes.get(1)).toHaveLength(1); // just the handshake
  });

  it("keeps several sockets independent", async () => {
    const t = setup();
    await t.openSocket(1, 10);
    await t.openSocket(2, 20);
    t.serverSends(20, serverFrame(OPCODE_TEXT, text("for two")));
    t.ws.onNetEvent({ type: "net:close", connId: 10 });
    t.ws.send(2, "still open");
    expect(t.events.filter((e) => e.id === 2).map((e) => e.event.kind)).toEqual(["open", "message"]);
    expect(t.events.filter((e) => e.id === 1).map((e) => e.event.kind)).toEqual(["open", "close"]);
    expect(t.framesFrom(20)).toEqual([{ fin: true, opcode: OPCODE_TEXT, payload: text("still open") }]);
  });
});

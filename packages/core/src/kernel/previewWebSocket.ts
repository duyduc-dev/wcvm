// The kernel-side end of a preview page's WebSocket: one virtual TCP connection (through the same
// kernel/netServer.ts a real process's own net.connect() uses) to whatever real http.Server a
// guest script has listening on the requested port, speaking the CLIENT side of RFC 6455 over it -
// the upgrade handshake, then masked frames out and unmasked frames in (kernel/webSocketFrames.ts).
// The guest's own 'upgrade' handler (the `ws` package, Vite's HMR server, or hand-rolled) is the
// real server end; nothing here knows or cares which.
//
// Like kernel/previewRelay.ts, the "process" on this side isn't a real Process Worker - it's the
// reserved PREVIEW_WS_PID sentinel, whose net events kernel/index.ts routes straight back to
// `onNetEvent` here instead of postMessage-ing a worker that doesn't exist. It's a different
// sentinel from previewRelay's PREVIEW_PID only so each module gets exactly its own events, with
// no shared connection bookkeeping between one-shot fetches and long-lived sockets.
//
// Sockets are identified by the host-minted `id` (IPreviewWebSocketOpen), and every outcome -
// open, each message, close/failure - is one `emit(id, event)`, in order, on the kernel's single
// channel to the host. Deliberately no request/response for open(): a server that sends a message
// the instant the handshake completes (Vite's HMR server does exactly that) would otherwise race
// the open's own reply.
//
// Not implemented: Sec-WebSocket-Accept verification (the peer is always a guest server in this
// same sandbox, never a cache or proxy that could mistakenly answer 101 - checking the status and
// Upgrade header is enough), extensions (permessage-deflate is never offered), and cookies/custom
// handshake headers (a browser WebSocket can't set any either, beyond subprotocols).

import { HttpMessageParser, HttpParseError, type IParsedHeadersComplete } from "../runtime/bindings/httpParser";
import type { IPreviewWebSocketOpen, PreviewWebSocketEvent } from "../protocols/preview";
import type { NetKernelEvent } from "./netServer";
import {
  CLOSE_ABNORMAL,
  CLOSE_NO_STATUS,
  OPCODE_BINARY,
  OPCODE_CLOSE,
  OPCODE_PING,
  OPCODE_PONG,
  OPCODE_TEXT,
  WebSocketProtocolError,
  WebSocketReader,
  decodeClosePayload,
  encodeClientFrame,
  encodeClosePayload,
} from "./webSocketFrames";

/** Never a real pid (those start at 1) nor previewRelay.ts's PREVIEW_PID (0) - see the header. */
export const PREVIEW_WS_PID = -1;

/** How long a client-initiated close waits for the server's own close frame before giving up
 *  and dropping the connection anyway (browsers have a similar, unspecified timeout). */
export const CLOSE_HANDSHAKE_TIMEOUT_MS = 5000;

export interface IPreviewWebSocketsParams {
  connect: (ticket: number, port: number) => void;
  writeData: (connId: number, chunk: Uint8Array) => void;
  close: (connId: number) => void;
  emit: (id: number, event: PreviewWebSocketEvent) => void;
}

export interface IPreviewWebSockets {
  open(request: IPreviewWebSocketOpen): void;
  send(id: number, data: string | Uint8Array): void;
  close(id: number, code?: number, reason?: string): void;
  /** Feed this every NetKernelEvent kernel/index.ts's `notify` routed to PREVIEW_WS_PID. */
  onNetEvent(event: NetKernelEvent): void;
}

type TunnelState = "connecting" | "handshake" | "open" | "closing" | "closed";

interface ITunnel {
  id: number;
  request: IPreviewWebSocketOpen;
  state: TunnelState;
  connId?: number;
  parser?: HttpMessageParser;
  reader?: WebSocketReader;
  closeTimer?: ReturnType<typeof setTimeout>;
}

const randomKey = (): string => btoa(String.fromCodePoint(...crypto.getRandomValues(new Uint8Array(16))));

const encodeHandshake = ({ port, path, protocols }: IPreviewWebSocketOpen): Uint8Array => {
  const lines = [
    `GET ${path} HTTP/1.1`,
    `Host: localhost:${port}`,
    "Upgrade: websocket",
    "Connection: Upgrade",
    `Sec-WebSocket-Key: ${randomKey()}`,
    "Sec-WebSocket-Version: 13",
    // What a page served from the guest's own origin would send - a guest server checking Origin
    // against its own Host (as dev servers commonly do) should see a same-origin request.
    `Origin: http://localhost:${port}`,
  ];
  if (protocols.length) lines.push(`Sec-WebSocket-Protocol: ${protocols.join(", ")}`);
  return new TextEncoder().encode(`${lines.join("\r\n")}\r\n\r\n`);
};

const headerValue = (info: IParsedHeadersComplete, name: string): string | undefined => {
  for (let i = 0; i < info.headers.length; i += 2) {
    if (info.headers[i].toLowerCase() === name) return info.headers[i + 1];
  }
  return undefined;
};

const utf8 = new TextDecoder("utf-8", { fatal: true });

const createPreviewWebSockets = ({ connect, writeData, close, emit }: IPreviewWebSocketsParams): IPreviewWebSockets => {
  let nextTicket = 1;
  const tunnels = new Map<number, ITunnel>();
  const byTicket = new Map<number, ITunnel>();
  const byConn = new Map<number, ITunnel>();

  /** Ends a tunnel for good: exactly one close event per socket, whatever path got here. */
  const finish = (tunnel: ITunnel, code: number, reason: string, wasClean: boolean) => {
    if (tunnel.state === "closed") return;
    tunnel.state = "closed";
    if (tunnel.closeTimer !== undefined) clearTimeout(tunnel.closeTimer);
    tunnels.delete(tunnel.id);
    if (tunnel.connId !== undefined) {
      byConn.delete(tunnel.connId);
      close(tunnel.connId);
    }
    emit(tunnel.id, { kind: "close", code, reason, wasClean });
  };

  /** RFC 6455's "fail the WebSocket connection": drop it, report 1006 (never a clean close). */
  const fail = (tunnel: ITunnel) => finish(tunnel, CLOSE_ABNORMAL, "", false);

  const writeFrame = (tunnel: ITunnel, opcode: number, payload: Uint8Array) => {
    // A frame already queued behind a close (e.g. a ping later in the same chunk) has nowhere to go.
    if (tunnel.state !== "closed" && tunnel.connId !== undefined) writeData(tunnel.connId, encodeClientFrame(opcode, payload));
  };

  const onControl = (tunnel: ITunnel, opcode: number, payload: Uint8Array) => {
    if (opcode === OPCODE_PING) {
      writeFrame(tunnel, OPCODE_PONG, payload);
      return;
    }
    if (opcode !== OPCODE_CLOSE) return; // a pong: nothing to do, this side never pings
    const { code, reason } = decodeClosePayload(payload);
    // Server-initiated: echo its status code back (RFC 6455 5.5.1). Client-initiated (already
    // "closing"): this IS the echo of ours, so the handshake is complete either way.
    if (tunnel.state === "open") writeFrame(tunnel, OPCODE_CLOSE, encodeClosePayload(code === CLOSE_NO_STATUS ? undefined : code));
    finish(tunnel, code, reason, true);
  };

  const onMessage = (tunnel: ITunnel, opcode: number, payload: Uint8Array) => {
    // A message arriving after this side started closing is discarded, like a browser does
    // (readyState is no longer OPEN).
    if (tunnel.state !== "open") return;
    if (opcode === OPCODE_TEXT) {
      let text: string;
      try {
        text = utf8.decode(payload);
      } catch {
        throw new WebSocketProtocolError("Text message is not valid UTF-8");
      }
      emit(tunnel.id, { kind: "message", data: text });
    } else if (opcode === OPCODE_BINARY) {
      emit(tunnel.id, { kind: "message", data: payload });
    }
  };

  const onHeadersComplete = (tunnel: ITunnel, info: IParsedHeadersComplete) => {
    const accepted =
      info.upgrade && info.statusCode === 101 && headerValue(info, "upgrade")?.toLowerCase() === "websocket";
    const protocol = headerValue(info, "sec-websocket-protocol") ?? "";
    // A server may only pick one of the subprotocols actually offered (RFC 6455 4.1) - anything
    // else (a 404, a plain 200, a 426, an unrequested subprotocol) fails the connection, exactly
    // like a real browser WebSocket's own handshake validation would.
    if (!accepted || (protocol !== "" && !tunnel.request.protocols.includes(protocol))) {
      fail(tunnel);
      return;
    }
    tunnel.state = "open";
    tunnel.reader = new WebSocketReader({
      onMessage: (opcode, payload) => onMessage(tunnel, opcode, payload),
      onControl: (opcode, payload) => onControl(tunnel, opcode, payload),
    });
    emit(tunnel.id, { kind: "open", protocol });
  };

  const feedFrames = (tunnel: ITunnel, chunk: Uint8Array) => {
    try {
      tunnel.reader!.feed(chunk);
    } catch (error) {
      if (!(error instanceof WebSocketProtocolError)) throw error;
      // Tell the server why, best effort, then drop the connection - the page only ever sees
      // 1006, same as a browser reports for any connection it had to fail.
      writeFrame(tunnel, OPCODE_CLOSE, encodeClosePayload(error.closeCode));
      fail(tunnel);
    }
  };

  const onData = (tunnel: ITunnel, chunk: Uint8Array) => {
    if (tunnel.state === "handshake") {
      let consumed: number;
      try {
        consumed = tunnel.parser!.execute(chunk);
      } catch (error) {
        if (!(error instanceof HttpParseError)) throw error;
        fail(tunnel);
        return;
      }
      // Whatever followed the 101's blank line in this same chunk is already frame data (a
      // server that sends a message right after upgrading often lands both in one write). The
      // cast: execute() just ran onHeadersComplete, which may have moved the state on.
      if ((tunnel.state as TunnelState) === "open" && consumed < chunk.length) feedFrames(tunnel, chunk.subarray(consumed));
      return;
    }
    if (tunnel.state === "open" || tunnel.state === "closing") feedFrames(tunnel, chunk);
  };

  const onConnected = (tunnel: ITunnel, connId: number) => {
    tunnel.connId = connId;
    byConn.set(connId, tunnel);
    // Closed from the page while still connecting - drop the connection now that there is one.
    if (tunnel.state === "closed") {
      byConn.delete(connId);
      close(connId);
      return;
    }
    tunnel.state = "handshake";
    const parser = new HttpMessageParser("RESPONSE");
    parser.onHeadersComplete = (info) => onHeadersComplete(tunnel, info);
    tunnel.parser = parser;
    // Same deferral as previewRelay.ts's own: this sentinel's notify is synchronous, so writing
    // right now would race ahead of netServer.connect()'s still-pending net:incoming to the
    // listening process - see that file's comment for the real bug this caused there.
    queueMicrotask(() => {
      if (tunnel.state === "handshake") writeData(connId, encodeHandshake(tunnel.request));
    });
  };

  const open = (request: IPreviewWebSocketOpen) => {
    const tunnel: ITunnel = { id: request.id, request, state: "connecting" };
    tunnels.set(request.id, tunnel);
    const ticket = nextTicket++;
    byTicket.set(ticket, tunnel);
    connect(ticket, request.port);
  };

  const send = (id: number, data: string | Uint8Array) => {
    const tunnel = tunnels.get(id);
    // Like a browser WebSocket, sending while CLOSING/CLOSED silently discards (the page's shim
    // already throws for CONNECTING, before anything reaches here).
    if (tunnel?.state !== "open") return;
    if (typeof data === "string") writeFrame(tunnel, OPCODE_TEXT, new TextEncoder().encode(data));
    else writeFrame(tunnel, OPCODE_BINARY, data);
  };

  const closeSocket = (id: number, code?: number, reason = "") => {
    const tunnel = tunnels.get(id);
    if (!tunnel || tunnel.state === "closing" || tunnel.state === "closed") return;
    if (tunnel.state !== "open") {
      // Closing before the handshake finished fails the connection (a browser does the same).
      fail(tunnel);
      return;
    }
    tunnel.state = "closing";
    writeFrame(tunnel, OPCODE_CLOSE, encodeClosePayload(code, reason));
    tunnel.closeTimer = setTimeout(() => fail(tunnel), CLOSE_HANDSHAKE_TIMEOUT_MS);
  };

  const onNetEvent = (event: NetKernelEvent) => {
    switch (event.type) {
      case "net:connectResult": {
        const tunnel = byTicket.get(event.ticket);
        if (!tunnel) return;
        byTicket.delete(event.ticket);
        if (event.ok) onConnected(tunnel, event.connId);
        else fail(tunnel); // ECONNREFUSED: nobody listening on that port
        return;
      }
      case "net:data": {
        const tunnel = byConn.get(event.connId);
        if (tunnel) onData(tunnel, event.chunk);
        return;
      }
      case "net:eof":
      case "net:close": {
        // The server went away (or its whole process exited) without finishing a close
        // handshake - a clean close would already have removed this tunnel via finish().
        const tunnel = byConn.get(event.connId);
        if (tunnel) fail(tunnel);
        return;
      }
      // net:incoming never targets PREVIEW_WS_PID - this side only ever connects, never listens.
    }
  };

  return { open, send, close: closeSocket, onNetEvent };
};

export { createPreviewWebSockets };

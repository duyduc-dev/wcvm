// internalBinding('tcp_wrap'): the native side lib/net.js needs for real TCP. No real sockets -
// a "connection" is two processes' own TCP handles, relayed byte-for-byte through the kernel
// (kernel/netServer.ts), the same shape child_process's stdin/stdout/ipc already use. IPv6 and
// Unix-domain sockets (net.connect({path})) aren't supported: bind6()/connect6() always fail
// (net.js falls back to IPv4 gracefully, the same way a real IPv6-less machine would), and
// pipe_wrap's existing Pipe class stays scoped to child_process stdio, not exposed for net's
// own use of it. See OP_NET_LISTEN (protocols/syscall.ts) for why listen() alone needs a
// blocking round-trip and connect()/read/write don't.

import { OP_NET_LISTEN, bytesToU32, encodeRequest, u32ToBytes, type ISyscallClient } from "../../protocols/syscall";
import { K_ARRAY_BUFFER_OFFSET, K_BYTES_WRITTEN, K_LAST_WRITE_WAS_ASYNC, K_READ_BYTES_OR_ERROR, streamBaseStateFor } from "./streamBaseState";
import { hasErrno, uvCode } from "./uvErrors";

export type NetEvent =
  | { type: "connectResult"; ticket: number; ok: true; connId: number }
  | { type: "connectResult"; ticket: number; ok: false; code: string }
  | { type: "incoming"; connId: number; port: number }
  | { type: "data"; connId: number; chunk: Uint8Array }
  /** Peer half-closed: EOF, but the connection stays registered (see NetRouter.dispatch). */
  | { type: "eof"; connId: number }
  | { type: "close"; connId: number };

export interface INetHost {
  /** server.close(): stop accepting new connections on `port`. */
  unlisten(port: number): void;
  /** `ticket` is this process's own correlation id for the eventual connectResult - like a
   *  child_process's childPid, minted locally (see NetRouter.mintTicket below). */
  connect(ticket: number, port: number): void;
  writeData(connId: number, chunk: Uint8Array): void;
  /** Half-close: done writing, but the peer may still have more to send. */
  shutdown(connId: number): void;
  /** Full close: tears the connection down for both sides. */
  close(connId: number): void;
  /** Registers the one handler for every connectResult/incoming/data/close event. */
  onEvent(handler: (event: NetEvent) => void): void;
}

export interface INetContext {
  loop: { post(fn: () => void): void; ref(): () => void };
  process?: { pid?: number };
  net?: INetHost;
  /** The blocking half: only OP_NET_LISTEN goes through this - see protocols/syscall.ts. */
  netSync?: ISyscallClient;
}

class TCPConnectWrap {
  oncomplete: ((status: number, handle: TCP, req: TCPConnectWrap, readable: boolean, writable: boolean) => void) | null = null;
  address?: string;
  port?: number;
  localAddress?: string;
  localPort?: number;
}
class WriteWrap {}
class ShutdownWrap {}

type QueuedRead = { chunk: Uint8Array } | { eof: true };

const bytesFromString = (str: string, kind: "utf8" | "latin1" | "ucs2"): Uint8Array => {
  if (kind === "utf8") return new TextEncoder().encode(str);
  if (kind === "ucs2") {
    const bytes = new Uint8Array(str.length * 2);
    const view = new DataView(bytes.buffer);
    for (let i = 0; i < str.length; i++) view.setUint16(i * 2, str.charCodeAt(i), true);
    return bytes;
  }
  const bytes = new Uint8Array(str.length);
  for (let i = 0; i < str.length; i++) bytes[i] = str.charCodeAt(i) & 0xff;
  return bytes;
};

const WRITEV_ENCODING_KIND: Record<string, "utf8" | "latin1" | "ucs2"> = {
  utf8: "utf8", "utf-8": "utf8",
  latin1: "latin1", binary: "latin1", ascii: "latin1",
  ucs2: "ucs2", "ucs-2": "ucs2", utf16le: "ucs2", "utf-16le": "ucs2",
};

const UV_EOF = -4095;
// This sandbox is a single virtual host: every TCP address, on both ends of every connection,
// is this same loopback address - see PLAN.md "Known differences".
const VIRTUAL_ADDRESS = "127.0.0.1";
const VIRTUAL_FAMILY = "IPv4";

class TCP {
  onread: ((arrayBuffer: ArrayBuffer) => void) | null = null;
  onconnection: ((err: number, clientHandle: TCP | undefined) => void) | null = null;
  reading = false;
  bytesRead = 0;
  bytesWritten = 0;
  /** Set once .listen() succeeds (server) or a connection is established (client/accepted). */
  port: number | null = null;
  connId: number | null = null;
  closed = false;
  queue: QueuedRead[] = [];
  release: (() => void) | null = null;
  readonly router: NetRouter;

  constructor(router: NetRouter) {
    this.router = router;
  }

  // ---- server side ------------------------------------------------------------------------

  bind(_address: string, port: number): number {
    this.port = port;
    return 0;
  }
  // No IPv6 support: net.js's own setupListenHandle tries bind6 first when no address is given,
  // and gracefully falls back to bind() on failure - exactly like a machine with no IPv6 would.
  bind6(): number {
    return uvCode("EAFNOSUPPORT");
  }

  listen(backlog: number): number {
    if (!this.router.netSync) return uvCode("ENOSYS");
    try {
      const payload = this.router.netSync.call(OP_NET_LISTEN, encodeRequest([u32ToBytes(this.port ?? 0), u32ToBytes(backlog)]));
      this.port = bytesToU32(payload);
    } catch (error) {
      return hasErrno(error) ? uvCode(error.code) : uvCode("EIO");
    }
    this.router.registerServer(this.port, this);
    this.ref();
    return 0;
  }

  // ---- client side --------------------------------------------------------------------------

  connect(req: TCPConnectWrap, _address: string, port: number): number {
    if (!this.router.host) return uvCode("ENOSYS");
    const ticket = this.router.mintTicket();
    this.router.registerPendingConnect(ticket, this, req);
    // A real uv_tcp_t is ref'd from the moment it starts connecting, not just once connected -
    // otherwise a script doing nothing but `net.connect(...)` would see an idle loop and exit
    // before the (inherently async) connectResult ever arrives.
    this.ref();
    this.router.host.connect(ticket, port);
    return 0;
  }
  connect6(): number {
    return uvCode("EAFNOSUPPORT");
  }

  // ---- shared stream surface (also used for an accepted connection) -------------------------

  readStart(): number {
    this.reading = true;
    this.drain();
    return 0;
  }
  readStop(): number {
    this.reading = false;
    return 0;
  }

  writeBuffer(_req: WriteWrap, data: Uint8Array): number {
    return this.deliverWrite(data);
  }
  writeUtf8String(_req: WriteWrap, data: string): number {
    return this.deliverWrite(bytesFromString(data, "utf8"));
  }
  writeLatin1String(_req: WriteWrap, data: string): number {
    return this.deliverWrite(bytesFromString(data, "latin1"));
  }
  writeAsciiString(_req: WriteWrap, data: string): number {
    return this.deliverWrite(bytesFromString(data, "latin1"));
  }
  writeUcs2String(_req: WriteWrap, data: string): number {
    return this.deliverWrite(bytesFromString(data, "ucs2"));
  }
  writev(_req: WriteWrap, chunks: unknown[], allBuffers: boolean): number {
    const parts: Uint8Array[] = [];
    if (allBuffers) {
      for (const chunk of chunks) parts.push(chunk as Uint8Array);
    } else {
      for (let i = 0; i < chunks.length; i += 2) {
        const chunk = chunks[i];
        if (typeof chunk === "string") {
          const encoding = chunks[i + 1] as string | undefined;
          parts.push(bytesFromString(chunk, (encoding ? WRITEV_ENCODING_KIND[encoding] : undefined) ?? "utf8"));
        } else {
          parts.push(chunk as Uint8Array);
        }
      }
    }
    const combined = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
    let offset = 0;
    for (const part of parts) {
      combined.set(part, offset);
      offset += part.length;
    }
    return this.deliverWrite(combined);
  }

  deliverWrite(bytes: Uint8Array): number {
    if (this.connId === null || !this.router.host) return uvCode("ENOTCONN");
    this.router.host.writeData(this.connId, bytes);
    this.bytesWritten += bytes.length;
    const state = this.router.state;
    state[K_BYTES_WRITTEN] = bytes.length;
    state[K_LAST_WRITE_WAS_ASYNC] = 0;
    return 0;
  }

  shutdown(): number {
    if (this.connId !== null) this.router.host?.shutdown(this.connId);
    return 1; // finished synchronously; net.js calls the callback itself.
  }

  getsockname(out: { address?: string; port?: number; family?: string }): number {
    out.address = VIRTUAL_ADDRESS;
    out.family = VIRTUAL_FAMILY;
    out.port = this.port ?? 0;
    return 0;
  }
  getpeername(out: { address?: string; port?: number; family?: string }): number {
    out.address = VIRTUAL_ADDRESS;
    out.family = VIRTUAL_FAMILY;
    out.port = this.port ?? 0;
    return 0;
  }

  close(callback?: () => void): void {
    if (!this.closed) {
      if (this.port !== null) {
        this.router.unregisterServer(this.port);
        this.router.host?.unlisten(this.port);
      }
      if (this.connId !== null) {
        this.router.unregisterConnection(this.connId);
        this.router.host?.close(this.connId);
      }
    }
    this.closed = true;
    this.queue.length = 0;
    this.release?.();
    this.release = null;
    if (callback) queueMicrotask(callback);
  }

  ref(): void {
    this.release ??= this.router.loop.ref();
  }
  unref(): void {
    this.release?.();
    this.release = null;
  }
  getAsyncId(): number {
    return 0;
  }

  /** Internal: fed by NetRouter, never called by vendored code. */
  push(chunk: Uint8Array | null): void {
    if (this.closed) return;
    this.queue.push(chunk === null ? { eof: true } : { chunk });
    this.drain();
  }

  drain(): void {
    if (!this.reading) return;
    while (this.queue.length > 0) {
      const item = this.queue.shift()!;
      const state = this.router.state;
      if ("eof" in item) {
        state[K_READ_BYTES_OR_ERROR] = UV_EOF;
        state[K_ARRAY_BUFFER_OFFSET] = 0;
        this.onread?.(undefined as unknown as ArrayBuffer);
      } else {
        this.bytesRead += item.chunk.byteLength;
        state[K_READ_BYTES_OR_ERROR] = item.chunk.byteLength;
        state[K_ARRAY_BUFFER_OFFSET] = item.chunk.byteOffset;
        this.onread?.(item.chunk.buffer as ArrayBuffer);
      }
    }
  }
}

const TICKET_MULTIPLIER = 1_000_000;

/** Shared per running script: ticket minting, and the one subscription to net events. */
class NetRouter {
  readonly state: Int32Array;
  readonly host?: INetHost;
  readonly netSync?: ISyscallClient;
  readonly loop: INetContext["loop"];
  private readonly ownPid: number;
  private counter = 0;
  private readonly serversByPort = new Map<number, TCP>();
  private readonly connectionsByConnId = new Map<number, TCP>();
  private readonly pendingConnects = new Map<number, { handle: TCP; req: TCPConnectWrap }>();

  constructor(ctx: INetContext) {
    this.host = ctx.net;
    this.netSync = ctx.netSync;
    this.loop = ctx.loop;
    this.ownPid = ctx.process?.pid ?? 0;
    this.state = streamBaseStateFor(ctx);

    this.host?.onEvent((event) => this.loop.post(() => this.dispatch(event)));
  }

  mintTicket(): number {
    return this.ownPid * TICKET_MULTIPLIER + ++this.counter;
  }

  registerServer(port: number, handle: TCP): void {
    this.serversByPort.set(port, handle);
  }
  unregisterServer(port: number): void {
    this.serversByPort.delete(port);
  }
  unregisterConnection(connId: number): void {
    this.connectionsByConnId.delete(connId);
  }
  registerPendingConnect(ticket: number, handle: TCP, req: TCPConnectWrap): void {
    this.pendingConnects.set(ticket, { handle, req });
  }

  createHandle(): TCP {
    return new TCP(this);
  }

  private dispatch(event: NetEvent): void {
    if (event.type === "connectResult") {
      const pending = this.pendingConnects.get(event.ticket);
      if (!pending) return;
      this.pendingConnects.delete(event.ticket);
      const { handle, req } = pending;
      if (!event.ok) {
        req.oncomplete?.(uvCode(event.code), handle, req, false, false);
        return;
      }
      handle.connId = event.connId;
      handle.port = req.port ?? null;
      this.connectionsByConnId.set(event.connId, handle);
      handle.ref();
      req.oncomplete?.(0, handle, req, true, true);
      return;
    }
    if (event.type === "incoming") {
      const server = this.serversByPort.get(event.port);
      if (!server) return;
      const accepted = this.createHandle();
      accepted.connId = event.connId;
      accepted.port = event.port;
      accepted.ref();
      this.connectionsByConnId.set(event.connId, accepted);
      server.onconnection?.(0, accepted);
      return;
    }
    if (event.type === "data") {
      this.connectionsByConnId.get(event.connId)?.push(event.chunk);
      return;
    }
    if (event.type === "eof") {
      // Half-close: deliver EOF, but keep the mapping - the peer (or this side) may still write.
      this.connectionsByConnId.get(event.connId)?.push(null);
      return;
    }
    // close: fully gone, both directions.
    const handle = this.connectionsByConnId.get(event.connId);
    this.connectionsByConnId.delete(event.connId);
    handle?.push(null);
  }
}

const routers = new WeakMap<INetContext, NetRouter>();
const routerFor = (ctx: INetContext): NetRouter => {
  let router = routers.get(ctx);
  if (!router) {
    router = new NetRouter(ctx);
    routers.set(ctx, router);
  }
  return router;
};

export const createTcpWrapBinding = (ctx: INetContext) => {
  const router = routerFor(ctx);
  return {
    TCP: class extends TCP {
      constructor(_type: number) {
        super(router);
      }
    },
    TCPConnectWrap,
    constants: { SOCKET: 0, SERVER: 1 },
  };
};

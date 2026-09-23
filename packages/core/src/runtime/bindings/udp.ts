// internalBinding('udp_wrap'): the native side lib/dgram.js/internal/dgram.js need for real UDP.
// No real sockets - a datagram is relayed through the kernel (kernel/netServer.ts's own,
// separate UDP port namespace), the same "kernel owns the port registry, relay by postMessage"
// shape tcp_wrap uses - but connectionless: there's no listen()/accept(), just bind() (claim a
// port) and send() (fire-and-forget to whoever, if anyone, is bound to the destination port - a
// real OS UDP socket drops silently when nobody's listening, so this does too; no error surfaces
// to the sender, matching real UDP's own unreliable-delivery contract).
//
// Only udp4 is supported: bind6()/connect6()/send6() all fail EAFNOSUPPORT, matching tcp_wrap's
// own IPv6 stance (see net.ts) - internal/dgram.js's own newHandle() only swaps a handle onto the
// *6 variants for an explicit `dgram.createSocket('udp6')`, so a plain (default) udp4 socket
// never reaches them. Multicast/broadcast (addMembership, setBroadcast, ...) have no meaning in a
// single virtual host - accepted, no-op, the same treatment zlib.ts's ignored
// windowBits/memLevel/etc. already has. `handle.lookup` isn't implemented here at all: real
// internal/dgram.js's own newHandle() already binds it straight to require('dns').lookup
// (already shimmed - see shims.ts's dnsShim), never touching this binding.

import { OP_UDP_BIND, bytesToU32, encodeRequest, u32ToBytes, type ISyscallClient } from "../../protocols/syscall";
import { hasErrno, uvCode } from "./uvErrors";

export type UdpEvent = { type: "message"; port: number; fromPort: number; chunk: Uint8Array };

export interface IUdpHost {
  /** dgram.Socket.close(): release `port` from the UDP namespace. */
  unbind(port: number): void;
  /** Fire-and-forget: `chunk` from this process's own `fromPort` to `toPort`. */
  send(fromPort: number, toPort: number, chunk: Uint8Array): void;
  /** Registers the one handler for every incoming datagram. */
  onEvent(handler: (event: UdpEvent) => void): void;
}

export interface IUdpContext {
  loop: { post(fn: () => void): void; ref(): () => void };
  udp?: IUdpHost;
  /** The blocking half: only OP_UDP_BIND goes through this - see protocols/syscall.ts. Reuses
   *  net's own sync client (bindings/index.ts wires ctx.netSync in here), since it's really "the
   *  kernel's synchronous virtual-network servicer", not TCP-specific by nature. */
  udpSync?: ISyscallClient;
  /** Wraps an incoming datagram as a real (sandbox) Buffer before handing it to onmessage - real
   *  Node's own native binding constructs one before ever calling into JS (dgram.js's own
   *  `onMessage(nread, handle, buf, rinfo)` just re-emits `buf` as-is, with no wrapping step of
   *  its own), so this binding has to do the same, not leave `msg.toString()`/etc. to a caller
   *  getting a plain Uint8Array whose inherited TypedArray#toString joins bytes with commas
   *  instead of decoding them. */
  requireBuiltin: (id: string) => any;
}

class SendWrap {}

const VIRTUAL_ADDRESS = "127.0.0.1";
const VIRTUAL_FAMILY = "IPv4";

interface IRinfo {
  address: string;
  family: string;
  port: number;
}

class UDP {
  onmessage: ((nread: number, handle: UDP, buf: Uint8Array, rinfo: IRinfo) => void) | null = null;
  onerror: ((nread: number, handle: UDP, error: Error) => void) | null = null;
  port: number | null = null;
  closed = false;
  release: (() => void) | null = null;
  readonly router: UdpRouter;

  constructor(router: UdpRouter) {
    this.router = router;
  }

  bind(_address: string, port: number, _flags: number): number {
    if (!this.router.udpSync) return uvCode("ENOSYS");
    try {
      const payload = this.router.udpSync.call(OP_UDP_BIND, encodeRequest([u32ToBytes(port)]));
      this.port = bytesToU32(payload);
    } catch (error) {
      return hasErrno(error) ? uvCode(error.code) : uvCode("EIO");
    }
    this.router.registerSocket(this.port, this);
    // A bound UDP socket keeps the process alive (a real dgram server does too) - the moment
    // there's nothing left to listen FOR is the moment close() releases this same ref.
    this.ref();
    return 0;
  }
  bind6(): number {
    return uvCode("EAFNOSUPPORT");
  }

  connect(): number {
    // UDP "connect" just pins a default destination for future unaddressed send() calls - no
    // handshake, and real dgram.js's own Socket.prototype.send() still always passes an explicit
    // destination through to handle.send() regardless of connect state, so there's nothing this
    // binding itself needs to remember.
    return 0;
  }
  connect6(): number {
    return uvCode("EAFNOSUPPORT");
  }
  disconnect(): number {
    return 0;
  }

  send(_req: SendWrap, buffers: Uint8Array[], _count: number, port: number): number {
    if (!this.router.host || this.port === null) return uvCode("ENOTCONN");
    let total = 0;
    for (const buffer of buffers) total += buffer.length;
    const combined = new Uint8Array(total);
    let offset = 0;
    for (const buffer of buffers) {
      combined.set(buffer, offset);
      offset += buffer.length;
    }
    this.router.host.send(this.port, port, combined);
    // Synchronous finish (msg_length + 1): this relay never actually blocks on real I/O, so
    // there's no async completion to report - dgram.js's own send() treats this return value as
    // "already done, don't wait for req.oncomplete" (see its own `if (err >= 1) {...return;}`).
    return total + 1;
  }
  send6(): number {
    return uvCode("EAFNOSUPPORT");
  }

  recvStart(): number {
    return 0; // delivery is push-based (UdpRouter.dispatch) - nothing to actually start.
  }
  recvStop(): number {
    return 0;
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

  close(): void {
    if (!this.closed && this.port !== null) {
      this.router.unregisterSocket(this.port);
      this.router.host?.unbind(this.port);
    }
    this.closed = true;
    this.release?.();
    this.release = null;
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

  // Multicast/broadcast: no meaning in a single virtual host - accepted, no-op (see file header).
  setBroadcast(): number {
    return 0;
  }
  setTTL(): number {
    return 0;
  }
  setMulticastTTL(): number {
    return 0;
  }
  setMulticastLoopback(): number {
    return 0;
  }
  setMulticastInterface(): number {
    return 0;
  }
  addMembership(): number {
    return 0;
  }
  dropMembership(): number {
    return 0;
  }
  addSourceSpecificMembership(): number {
    return 0;
  }
  dropSourceSpecificMembership(): number {
    return 0;
  }
  bufferSize(): number {
    return 0;
  }
  getSendQueueCount(): number {
    return 0;
  }
  getSendQueueSize(): number {
    return 0;
  }
  /** dgram.createSocket({fd}): adopting an already-open fd - no real fd to adopt here. */
  open(): number {
    return uvCode("ENOSYS");
  }

  /** Internal: fed by UdpRouter, never called by vendored code. */
  deliver(buf: Uint8Array, fromPort: number): void {
    if (this.closed) return;
    this.onmessage?.(buf.length, this, buf, { address: VIRTUAL_ADDRESS, family: VIRTUAL_FAMILY, port: fromPort });
  }
}

/** Shared per running script: one subscription to UDP events, dispatched by port. */
class UdpRouter {
  readonly host?: IUdpHost;
  readonly udpSync?: ISyscallClient;
  readonly loop: IUdpContext["loop"];
  private readonly requireBuiltin: (id: string) => any;
  private readonly socketsByPort = new Map<number, UDP>();

  constructor(ctx: IUdpContext) {
    this.host = ctx.udp;
    this.udpSync = ctx.udpSync;
    this.loop = ctx.loop;
    this.requireBuiltin = ctx.requireBuiltin;
    this.host?.onEvent((event) => this.loop.post(() => this.dispatch(event)));
  }

  registerSocket(port: number, handle: UDP): void {
    this.socketsByPort.set(port, handle);
  }
  unregisterSocket(port: number): void {
    this.socketsByPort.delete(port);
  }
  createHandle(): UDP {
    return new UDP(this);
  }

  private dispatch(event: UdpEvent): void {
    const socket = this.socketsByPort.get(event.port);
    if (!socket) return;
    const { Buffer } = this.requireBuiltin("buffer");
    socket.deliver(Buffer.from(event.chunk), event.fromPort);
  }
}

const routers = new WeakMap<IUdpContext, UdpRouter>();
const routerFor = (ctx: IUdpContext): UdpRouter => {
  let router = routers.get(ctx);
  if (!router) {
    router = new UdpRouter(ctx);
    routers.set(ctx, router);
  }
  return router;
};

export const createUdpWrapBinding = (ctx: IUdpContext) => {
  const router = routerFor(ctx);
  return {
    UDP: class extends UDP {
      constructor(_type: number) {
        super(router);
      }
    },
    SendWrap,
    constants: { SOCKET: 0, SERVER: 1, UDP_DGRAM_IS_REMOTE: 1 },
  };
};

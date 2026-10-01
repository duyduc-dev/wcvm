// A virtual network, entirely inside this kernel: there's no real OS socket to bind, so
// listening/connecting/relaying is just bookkeeping plus postMessage. TCP and UDP each have two
// very different needs:
//
//   - net.Server.listen() and dgram's Socket.bind() must both look synchronous to guest code and
//     give a globally-coordinated answer (port 0 -> the actual assigned port; an explicit port
//     already taken -> EADDRINUSE) - real net.js's own contract for listen() (it emits
//     'listening' right after handle.listen() returns 0, with no further async confirmation
//     awaited - see lib/net.js's setupListenHandle) and real dgram.js's own contract for bind()
//     (`state.handle.bind()` is a synchronous call whose return value IS the error, not an event
//     fired later - see lib/dgram.js's own Socket.prototype.bind). Both share ONE per-process SAB
//     (parallel to spawnSync's own second one - protocols/syscall.ts's OP_NET_LISTEN/
//     OP_UDP_BIND), serviced here by opcode exactly like kernel/kernelSyncServer.ts dispatches
//     between its own three unrelated opcodes on one shared SAB - TCP and UDP ports are still
//     separate namespaces (`listeners` vs `udpBindings` below), just coordinated through the same
//     physical channel.
//   - Everything else - TCP's connect()/data/close, UDP's send (there's no UDP "accept": every
//     send() either lands on a bound socket or is silently dropped, matching real UDP's own
//     unreliable-delivery contract) - is naturally async, ordinary postMessage relay through
//     kernel/processes.ts, the same shape child_process's stdin/stdout/ipc already use (parent <->
//     kernel <-> child, just server-pid <-> kernel <-> client-pid here instead).
//
// A TCP connection has TWO kernel-minted ids, one per endpoint: the connecting side is told its own
// in "connectResult", the accepting side its own in "incoming", and every later event for an endpoint
// carries that endpoint's id. Two ids, not one shared one, because both ends can live in the SAME
// process (a script that `listen()`s and then `http.get()`s itself - the usual shape of a test or a
// demo): a process keys its sockets by id, so one shared id made the client and the server collide,
// and the server read back its own response as a request. Nothing here ever exposes one pid's identity
// to the other. UDP has no such id - a datagram is addressed by port alone, exactly like a real one is.

import {
  OP_NET_LISTEN,
  OP_UDP_BIND,
  bytesToU32,
  hasPendingRequest,
  makeViews,
  readRequest,
  respondErr,
  respondOk,
  u32ToBytes,
  type ISyscallViews,
} from "../protocols/syscall";
import type { ChildEvent } from "../workers/process/messages";

/** The kernel -> process worker net variants of ChildEvent (the canonical wire format), so this
 *  file's own event shapes can never drift from what workers/process/worker.ts actually expects. */
export type NetKernelEvent = Extract<ChildEvent, { type: `net:${string}` }>;
/** Same idea, for UDP. */
export type UdpKernelEvent = Extract<ChildEvent, { type: `udp:${string}` }>;

export interface INetServerParams {
  /** Pushes one event to a specific process's own worker; see kernel/processes.ts's notifyNet. */
  notify: (pid: number, event: NetKernelEvent) => void;
  /** Same idea, for UDP - a separate method (not folded into `notify` above) since the two event
   *  unions don't overlap and callers (kernel/processes.ts's notifyUdp) want them kept apart. */
  notifyUdp: (pid: number, event: UdpKernelEvent) => void;
  /** A listener came up or went away (listen() succeeded, unlisten()/close(), or its owning pid
   *  exited) - the host's own handle on this, so a preview UI can know when to point an iframe
   *  at a virtual port without polling. Optional: most callers (e.g. tests) don't need it. */
  onListenChange?: (info: { pid: number; port: number; listening: boolean }) => void;
}

export interface INetServer {
  registerClient(clientId: number, sab: SharedArrayBuffer): void;
  unregisterClient(clientId: number): void;
  /** Call when clientId's doorbell rings on the net SAB: services a parked OP_NET_LISTEN/
   *  OP_UDP_BIND, if any. */
  service(clientId: number): void;

  /** server.close(): stops accepting new connections on `port`; a no-op if `pid` isn't its owner. */
  unlisten(pid: number, port: number): void;
  /** `fromPid` wants to connect to `port`; `ticket` is fromPid's own correlation id for the reply. */
  connect(fromPid: number, ticket: number, port: number): void;
  data(fromPid: number, connId: number, chunk: Uint8Array): void;
  /** Half-close: fromPid is done writing: EOF for the peer's read side, connection stays registered. */
  shutdown(fromPid: number, connId: number): void;
  /** Full close: tears the connection down and notifies the peer. */
  close(fromPid: number, connId: number): void;
  /** A process exited: drop every listener/connection it owned, notifying any live peers. */
  releasePid(pid: number): void;

  /** dgram.Socket.close(): releases `port` from the UDP namespace; a no-op if `pid` isn't its owner. */
  udpUnbind(pid: number, port: number): void;
  /** A datagram sent from `fromPort` (on `fromPid`) to `toPort` - delivered if, and only if, some
   *  process currently has `toPort` bound; silently dropped otherwise, matching real UDP. */
  udpSend(fromPid: number, fromPort: number, toPort: number, chunk: Uint8Array): void;
  /** A process exited: drop every UDP port binding it owned (no peers to notify - UDP has none). */
  udpReleasePid(pid: number): void;
}

// IANA's dynamic/private port range - real ephemeral-port-assignment territory, so a script
// asking for an explicit low port (3000, 8080, ...) never collides with an auto-assigned one.
const EPHEMERAL_PORT_START = 49152;
const EPHEMERAL_PORT_END = 65535;

interface IListener {
  pid: number;
  backlog: number;
}

/** One TCP connection. `a` is the side that connected, `b` the side that accepted. */
interface IConnection {
  pidA: number;
  pidB: number;
  idA: number;
  idB: number;
}

const createNetServer = ({ notify, notifyUdp, onListenChange }: INetServerParams): INetServer => {
  const clients = new Map<number, ISyscallViews>();
  const listeners = new Map<number, IListener>();
  // Keyed by EITHER endpoint's id; `side` says which endpoint that id names.
  const connections = new Map<number, { conn: IConnection; side: "a" | "b" }>();
  // A separate namespace from `listeners` above - real UDP and TCP ports don't collide with each
  // other, only with themselves (a process can bind UDP:3000 while another listens on TCP:3000).
  const udpBindings = new Map<number, number>();
  let nextEphemeralPort = EPHEMERAL_PORT_START;
  let nextUdpEphemeralPort = EPHEMERAL_PORT_START;
  let nextConnId = 1;

  const allocateEphemeralPort = (): number | undefined => {
    for (let tried = 0; tried <= EPHEMERAL_PORT_END - EPHEMERAL_PORT_START; tried++) {
      const port = nextEphemeralPort;
      nextEphemeralPort = nextEphemeralPort >= EPHEMERAL_PORT_END ? EPHEMERAL_PORT_START : nextEphemeralPort + 1;
      if (!listeners.has(port)) return port;
    }
    return undefined; // every ephemeral port is taken - practically unreachable
  };

  const allocateUdpEphemeralPort = (): number | undefined => {
    for (let tried = 0; tried <= EPHEMERAL_PORT_END - EPHEMERAL_PORT_START; tried++) {
      const port = nextUdpEphemeralPort;
      nextUdpEphemeralPort = nextUdpEphemeralPort >= EPHEMERAL_PORT_END ? EPHEMERAL_PORT_START : nextUdpEphemeralPort + 1;
      if (!udpBindings.has(port)) return port;
    }
    return undefined;
  };

  /** The endpoint across from `side`: who to tell, and the id that endpoint knows the connection by. */
  const peerOf = ({ conn, side }: { conn: IConnection; side: "a" | "b" }) =>
    side === "a" ? { pid: conn.pidB, connId: conn.idB } : { pid: conn.pidA, connId: conn.idA };

  const registerClient = (clientId: number, sab: SharedArrayBuffer) => {
    clients.set(clientId, makeViews(sab));
  };
  const unregisterClient = (clientId: number) => {
    clients.delete(clientId);
  };

  const serviceNetListen = (views: ISyscallViews, clientId: number, fields: Uint8Array[]) => {
    const port = bytesToU32(fields[0] ?? new Uint8Array(4));
    const backlog = bytesToU32(fields[1] ?? new Uint8Array(4));
    const assigned = port === 0 ? allocateEphemeralPort() : port;
    if (assigned === undefined) {
      respondErr(views, "EADDRNOTAVAIL");
      return;
    }
    if (listeners.has(assigned)) {
      respondErr(views, "EADDRINUSE");
      return;
    }
    listeners.set(assigned, { pid: clientId, backlog });
    respondOk(views, u32ToBytes(assigned));
    onListenChange?.({ pid: clientId, port: assigned, listening: true });
  };

  const serviceUdpBind = (views: ISyscallViews, clientId: number, fields: Uint8Array[]) => {
    const port = bytesToU32(fields[0] ?? new Uint8Array(4));
    const assigned = port === 0 ? allocateUdpEphemeralPort() : port;
    if (assigned === undefined) {
      respondErr(views, "EADDRNOTAVAIL");
      return;
    }
    if (udpBindings.has(assigned)) {
      respondErr(views, "EADDRINUSE");
      return;
    }
    udpBindings.set(assigned, clientId);
    respondOk(views, u32ToBytes(assigned));
  };

  const service = (clientId: number) => {
    const views = clients.get(clientId);
    if (!views || !hasPendingRequest(views)) return;
    try {
      const { opcode, fields } = readRequest(views);
      if (opcode === OP_NET_LISTEN) serviceNetListen(views, clientId, fields);
      else if (opcode === OP_UDP_BIND) serviceUdpBind(views, clientId, fields);
      else respondErr(views, "ENOSYS");
    } catch (error) {
      const code = (error as { code?: unknown }).code;
      respondErr(views, typeof code === "string" ? code : "EIO");
    }
  };

  const unlisten = (pid: number, port: number) => {
    if (listeners.get(port)?.pid !== pid) return;
    listeners.delete(port);
    onListenChange?.({ pid, port, listening: false });
  };

  const connect = (fromPid: number, ticket: number, port: number) => {
    const listener = listeners.get(port);
    if (!listener) {
      notify(fromPid, { type: "net:connectResult", ticket, ok: false, code: "ECONNREFUSED" });
      return;
    }
    const conn: IConnection = { pidA: fromPid, pidB: listener.pid, idA: nextConnId++, idB: nextConnId++ };
    connections.set(conn.idA, { conn, side: "a" });
    connections.set(conn.idB, { conn, side: "b" });
    notify(fromPid, { type: "net:connectResult", ticket, ok: true, connId: conn.idA });
    notify(listener.pid, { type: "net:incoming", connId: conn.idB, port });
  };

  const data = (_fromPid: number, connId: number, chunk: Uint8Array) => {
    const endpoint = connections.get(connId);
    if (!endpoint) return;
    const peer = peerOf(endpoint);
    notify(peer.pid, { type: "net:data", connId: peer.connId, chunk });
  };

  const shutdown = (_fromPid: number, connId: number) => {
    const endpoint = connections.get(connId);
    if (!endpoint) return;
    // Half-close: the connection stays registered (this side may still receive, and the peer may
    // still write back), unlike close() below - see NetKernelEvent's own "eof" vs "close".
    const peer = peerOf(endpoint);
    notify(peer.pid, { type: "net:eof", connId: peer.connId });
  };

  const close = (_fromPid: number, connId: number) => {
    const endpoint = connections.get(connId);
    if (!endpoint) return;
    connections.delete(endpoint.conn.idA);
    connections.delete(endpoint.conn.idB);
    const peer = peerOf(endpoint);
    notify(peer.pid, { type: "net:close", connId: peer.connId });
  };

  const releasePid = (pid: number) => {
    for (const [port, listener] of listeners) {
      if (listener.pid !== pid) continue;
      listeners.delete(port);
      onListenChange?.({ pid, port, listening: false });
    }
    for (const [id, endpoint] of connections) {
      const { conn, side } = endpoint;
      if (conn.pidA !== pid && conn.pidB !== pid) continue;
      // Visit each connection once (via its `a` id), and tell only a peer that outlives `pid`: when both ends
      // were in the exiting process there is nobody left to notify.
      if (side !== "a") {
        connections.delete(id);
        continue;
      }
      connections.delete(conn.idA);
      connections.delete(conn.idB);
      if (conn.pidA === pid && conn.pidB !== pid) notify(conn.pidB, { type: "net:close", connId: conn.idB });
      else if (conn.pidB === pid && conn.pidA !== pid) notify(conn.pidA, { type: "net:close", connId: conn.idA });
    }
  };

  const udpUnbind = (pid: number, port: number) => {
    if (udpBindings.get(port) !== pid) return;
    udpBindings.delete(port);
  };

  const udpSend = (fromPid: number, fromPort: number, toPort: number, chunk: Uint8Array) => {
    const toPid = udpBindings.get(toPort);
    // No socket bound to toPort: a real UDP datagram to a closed port is silently dropped (no
    // ICMP port-unreachable modeled here, matching plain unconnected send()'s own unreliable-
    // delivery contract - see the file header comment).
    if (toPid === undefined) return;
    notifyUdp(toPid, { type: "udp:message", port: toPort, fromPort, chunk });
  };

  const udpReleasePid = (pid: number) => {
    for (const [port, owner] of udpBindings) {
      if (owner === pid) udpBindings.delete(port);
    }
  };

  return {
    registerClient, unregisterClient, service,
    unlisten, connect, data, shutdown, close, releasePid,
    udpUnbind, udpSend, udpReleasePid,
  };
};

export { createNetServer };

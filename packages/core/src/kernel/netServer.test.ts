import { beforeEach, describe, expect, it } from "vitest";
import {
  I_OPCODE,
  I_REQ_LEN,
  I_RES_LEN,
  I_STATE,
  OP_NET_LISTEN,
  OP_UDP_BIND,
  STATE_REQUEST,
  STATE_RESPONSE_ERR,
  STATE_RESPONSE_OK,
  bytesToU32,
  createSyscallBuffer,
  decodeBytes,
  encodeRequest,
  makeViews,
  u32ToBytes,
} from "../protocols/syscall";
import { createNetServer } from "./netServer";

/** Publishes a request exactly like createSyscallClient.call() does, minus the Atomics.wait -
 *  mirrors spawnSyncServer.test.ts's own helper. */
const publish = (views: ReturnType<typeof makeViews>, request: Uint8Array, opcode = OP_NET_LISTEN) => {
  views.data.set(request, 0);
  Atomics.store(views.ctrl, I_OPCODE, opcode);
  Atomics.store(views.ctrl, I_REQ_LEN, request.length);
  Atomics.store(views.ctrl, I_STATE, STATE_REQUEST);
};

const listenRequest = (port: number, backlog = 511) => encodeRequest([u32ToBytes(port), u32ToBytes(backlog)]);
const bindRequest = (port: number) => encodeRequest([u32ToBytes(port)]);

const setup = () => {
  const notified: unknown[] = [];
  const udpNotified: unknown[] = [];
  const listenChanges: Array<{ pid: number; port: number; listening: boolean }> = [];
  const server = createNetServer({
    notify: (pid, event) => notified.push({ pid, event }),
    notifyUdp: (pid, event) => udpNotified.push({ pid, event }),
    onListenChange: (info) => listenChanges.push(info),
  });
  const sab = createSyscallBuffer();
  const views = makeViews(sab);
  server.registerClient(1, sab);
  return { server, views, notified, udpNotified, listenChanges };
};

let t: ReturnType<typeof setup>;
beforeEach(() => {
  t = setup();
});

describe("netServer onListenChange", () => {
  it("fires with listening:true once a listen() request is serviced", () => {
    publish(t.views, listenRequest(3000));
    t.server.service(1);

    expect(t.listenChanges).toEqual([{ pid: 1, port: 3000, listening: true }]);
  });

  it("does not fire for a failed listen (port already in use)", () => {
    publish(t.views, listenRequest(3000));
    t.server.service(1);
    t.listenChanges.length = 0;

    const sab2 = createSyscallBuffer();
    const views2 = makeViews(sab2);
    t.server.registerClient(2, sab2);
    publish(views2, listenRequest(3000));
    t.server.service(2);

    expect(t.listenChanges).toEqual([]);
  });

  it("fires with listening:false when the owning pid calls unlisten()", () => {
    publish(t.views, listenRequest(3000));
    t.server.service(1);
    t.listenChanges.length = 0;

    t.server.unlisten(1, 3000);

    expect(t.listenChanges).toEqual([{ pid: 1, port: 3000, listening: false }]);
  });

  it("does not fire an unlisten for a pid that doesn't own the port", () => {
    publish(t.views, listenRequest(3000));
    t.server.service(1);
    t.listenChanges.length = 0;

    t.server.unlisten(2, 3000);

    expect(t.listenChanges).toEqual([]);
  });

  it("fires with listening:false for every port a pid held when it's released", () => {
    publish(t.views, listenRequest(3000));
    t.server.service(1);
    const sab2 = createSyscallBuffer();
    const views2 = makeViews(sab2);
    t.server.registerClient(2, sab2);
    publish(views2, listenRequest(4000));
    t.server.service(2);
    t.listenChanges.length = 0;

    t.server.releasePid(1);

    expect(t.listenChanges).toEqual([{ pid: 1, port: 3000, listening: false }]);
  });

  it("onListenChange is optional - listening still works without it", () => {
    const server = createNetServer({ notify: () => {}, notifyUdp: () => {} });
    const sab = createSyscallBuffer();
    const views = makeViews(sab);
    server.registerClient(1, sab);

    expect(() => {
      publish(views, listenRequest(3000));
      server.service(1);
      server.unlisten(1, 3000);
    }).not.toThrow();
  });
});

describe("netServer UDP", () => {
  it("OP_UDP_BIND with port 0 auto-assigns a real ephemeral port", () => {
    publish(t.views, bindRequest(0), OP_UDP_BIND);
    t.server.service(1);

    expect(Atomics.load(t.views.ctrl, I_STATE)).toBe(STATE_RESPONSE_OK);
    const assigned = bytesToU32(t.views.data.slice(0, Atomics.load(t.views.ctrl, I_RES_LEN)));
    expect(assigned).toBeGreaterThanOrEqual(49152);
  });

  it("TCP and UDP are separate port namespaces - binding UDP:3000 while TCP:3000 is listened on doesn't collide", () => {
    publish(t.views, listenRequest(3000));
    t.server.service(1);
    expect(Atomics.load(t.views.ctrl, I_STATE)).toBe(STATE_RESPONSE_OK);
    Atomics.store(t.views.ctrl, I_STATE, 0); // reset to idle, like a real client would after reading

    publish(t.views, bindRequest(3000), OP_UDP_BIND);
    t.server.service(1);
    expect(Atomics.load(t.views.ctrl, I_STATE)).toBe(STATE_RESPONSE_OK);
    expect(bytesToU32(t.views.data.slice(0, Atomics.load(t.views.ctrl, I_RES_LEN)))).toBe(3000);
  });

  it("a second bind on an already-bound UDP port gets a real EADDRINUSE", () => {
    publish(t.views, bindRequest(4000), OP_UDP_BIND);
    t.server.service(1);
    Atomics.store(t.views.ctrl, I_STATE, 0);

    const sab2 = createSyscallBuffer();
    const views2 = makeViews(sab2);
    t.server.registerClient(2, sab2);
    publish(views2, bindRequest(4000), OP_UDP_BIND);
    t.server.service(2);

    expect(Atomics.load(views2.ctrl, I_STATE)).toBe(STATE_RESPONSE_ERR);
    expect(decodeBytes(views2.data.slice(0, Atomics.load(views2.ctrl, I_RES_LEN)))).toBe("EADDRINUSE");
  });

  it("udpSend() delivers to whoever is bound to the destination port, and drops silently if nobody is", () => {
    publish(t.views, bindRequest(5000), OP_UDP_BIND);
    t.server.service(1);

    t.server.udpSend(2, 6000, 5000, new TextEncoder().encode("hi"));
    expect(t.udpNotified).toEqual([{ pid: 1, event: { type: "udp:message", port: 5000, fromPort: 6000, chunk: new TextEncoder().encode("hi") } }]);

    t.udpNotified.length = 0;
    t.server.udpSend(2, 6000, 9999, new TextEncoder().encode("nobody home"));
    expect(t.udpNotified).toEqual([]);
  });

  it("udpUnbind() releases the port; a no-op if the caller doesn't own it", () => {
    publish(t.views, bindRequest(5001), OP_UDP_BIND);
    t.server.service(1);

    t.server.udpUnbind(2, 5001); // wrong owner - no-op
    t.server.udpSend(3, 1, 5001, new TextEncoder().encode("still there"));
    expect(t.udpNotified).toHaveLength(1);
    t.udpNotified.length = 0;

    t.server.udpUnbind(1, 5001); // real owner
    t.server.udpSend(3, 1, 5001, new TextEncoder().encode("gone"));
    expect(t.udpNotified).toEqual([]);
  });

  it("udpReleasePid() drops every UDP port a pid held", () => {
    publish(t.views, bindRequest(5002), OP_UDP_BIND);
    t.server.service(1);

    t.server.udpReleasePid(1);
    t.server.udpSend(3, 1, 5002, new TextEncoder().encode("gone"));
    expect(t.udpNotified).toEqual([]);
  });
});

describe("netServer TCP connections", () => {
  const listenOn = (port: number, pid = 1) => {
    publish(t.views, listenRequest(port));
    t.server.service(pid);
    t.notified.length = 0;
  };
  type Event = { pid: number; event: { type: string; connId: number; ticket?: number; chunk?: Uint8Array } };
  const events = () => t.notified as Event[];

  it("gives each endpoint its own id, and delivers data to the other endpoint under THAT endpoint's id", () => {
    listenOn(4000);
    t.server.registerClient(2, createSyscallBuffer());

    t.server.connect(2, 7, 4000);
    const [result, incoming] = events();
    expect(result).toMatchObject({ pid: 2, event: { type: "net:connectResult", ticket: 7 } });
    expect(incoming).toMatchObject({ pid: 1, event: { type: "net:incoming" } });
    const clientId = result.event.connId;
    const serverId = incoming.event.connId;
    expect(clientId).not.toBe(serverId);

    t.notified.length = 0;
    t.server.data(2, clientId, new Uint8Array([1, 2]));
    t.server.data(1, serverId, new Uint8Array([3]));
    expect(events()).toMatchObject([
      { pid: 1, event: { type: "net:data", connId: serverId } },
      { pid: 2, event: { type: "net:data", connId: clientId } },
    ]);
  });

  it("a process that connects to its OWN listener keeps its two endpoints apart (a script that serves and requests itself)", () => {
    // Before, both ends shared one id: the process could not tell its client socket from its server socket, so
    // the server read its own response back as a request.
    listenOn(4001);

    t.server.connect(1, 1, 4001);
    const [result, incoming] = events();
    expect(result.pid).toBe(1);
    expect(incoming.pid).toBe(1);
    const clientId = result.event.connId;
    const serverId = incoming.event.connId;
    expect(clientId).not.toBe(serverId);

    t.notified.length = 0;
    t.server.data(1, clientId, new Uint8Array([9])); // the client writes -> the SERVER endpoint gets it
    expect(events()).toMatchObject([{ pid: 1, event: { type: "net:data", connId: serverId } }]);

    t.notified.length = 0;
    t.server.data(1, serverId, new Uint8Array([8])); // the server answers -> the CLIENT endpoint gets it
    expect(events()).toMatchObject([{ pid: 1, event: { type: "net:data", connId: clientId } }]);

    t.notified.length = 0;
    t.server.shutdown(1, clientId);
    expect(events()).toMatchObject([{ pid: 1, event: { type: "net:eof", connId: serverId } }]);
  });

  it("close() tears down both ids and tells the peer under its own id", () => {
    listenOn(4002);
    t.server.registerClient(2, createSyscallBuffer());
    t.server.connect(2, 1, 4002);
    const [result, incoming] = events();
    t.notified.length = 0;

    t.server.close(2, result.event.connId);
    expect(events()).toMatchObject([{ pid: 1, event: { type: "net:close", connId: incoming.event.connId } }]);

    t.notified.length = 0;
    t.server.data(1, incoming.event.connId, new Uint8Array([1])); // already closed: nothing is delivered
    expect(events()).toEqual([]);
  });

  it("releasePid() closes a peer that outlives the process, and says nothing when both ends died together", () => {
    listenOn(4003);
    t.server.registerClient(2, createSyscallBuffer());

    t.server.connect(2, 1, 4003); // pid 2 is a client of pid 1
    const [, incoming] = events();
    t.notified.length = 0;
    t.server.releasePid(2);
    expect(events()).toMatchObject([{ pid: 1, event: { type: "net:close", connId: incoming.event.connId } }]);

    t.notified.length = 0;
    t.server.connect(1, 2, 4003); // pid 1 connects to itself
    t.notified.length = 0;
    t.server.releasePid(1);
    expect(events()).toEqual([]);
  });
});

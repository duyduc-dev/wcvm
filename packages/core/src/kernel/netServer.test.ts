import { beforeEach, describe, expect, it } from "vitest";
import {
  I_OPCODE,
  I_REQ_LEN,
  I_STATE,
  OP_NET_LISTEN,
  STATE_REQUEST,
  createSyscallBuffer,
  encodeRequest,
  makeViews,
  u32ToBytes,
} from "../protocols/syscall";
import { createNetServer } from "./netServer";

/** Publishes a request exactly like createSyscallClient.call() does, minus the Atomics.wait -
 *  mirrors spawnSyncServer.test.ts's own helper. */
const publish = (views: ReturnType<typeof makeViews>, request: Uint8Array) => {
  views.data.set(request, 0);
  Atomics.store(views.ctrl, I_OPCODE, OP_NET_LISTEN);
  Atomics.store(views.ctrl, I_REQ_LEN, request.length);
  Atomics.store(views.ctrl, I_STATE, STATE_REQUEST);
};

const listenRequest = (port: number, backlog = 511) => encodeRequest([u32ToBytes(port), u32ToBytes(backlog)]);

const setup = () => {
  const notified: unknown[] = [];
  const listenChanges: Array<{ pid: number; port: number; listening: boolean }> = [];
  const server = createNetServer({
    notify: (pid, event) => notified.push({ pid, event }),
    onListenChange: (info) => listenChanges.push(info),
  });
  const sab = createSyscallBuffer();
  const views = makeViews(sab);
  server.registerClient(1, sab);
  return { server, views, notified, listenChanges };
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
    const server = createNetServer({ notify: () => {} });
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

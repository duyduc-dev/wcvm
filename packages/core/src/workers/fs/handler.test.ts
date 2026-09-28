import { describe, expect, it } from "vitest";
import { FsServer } from "../../fs/FsServer";
import {
  FLAG_NONE,
  FLAG_RECURSIVE,
  I_OPCODE,
  I_REQ_LEN,
  I_STATE,
  OP_EXISTS,
  OP_RM,
  STATE_REQUEST,
  STATE_RESPONSE_OK,
  createSyscallBuffer,
  encodeRequest,
  encodeString,
  makeViews,
} from "../../protocols/syscall";
import { createFsWorkerHandler } from "./handler";

/** Publishes a pending OP_EXISTS("/") request onto `sab`, the way a real parked client would. */
const publishExists = (sab: SharedArrayBuffer) => {
  const { ctrl, data } = makeViews(sab);
  const frame = encodeRequest([encodeString("/")]);
  data.set(frame, 0);
  Atomics.store(ctrl, I_OPCODE, OP_EXISTS);
  Atomics.store(ctrl, I_REQ_LEN, frame.length);
  Atomics.store(ctrl, I_STATE, STATE_REQUEST);
};

/** Publishes a pending OP_RM(path) request onto `sab`. */
const publishRm = (sab: SharedArrayBuffer, path: string, recursive: boolean) => {
  const { ctrl, data } = makeViews(sab);
  const frame = encodeRequest([encodeString(path)], recursive ? FLAG_RECURSIVE : FLAG_NONE);
  data.set(frame, 0);
  Atomics.store(ctrl, I_OPCODE, OP_RM);
  Atomics.store(ctrl, I_REQ_LEN, frame.length);
  Atomics.store(ctrl, I_STATE, STATE_REQUEST);
};

describe("fs worker handler", () => {
  it("services a client only after it registers and rings the doorbell", () => {
    const server = new FsServer();
    const handle = createFsWorkerHandler(server);
    const sab = createSyscallBuffer();
    const { ctrl, data } = makeViews(sab);

    const frame = encodeRequest([encodeString("/")]);
    data.set(frame, 0);
    Atomics.store(ctrl, I_OPCODE, OP_EXISTS);
    Atomics.store(ctrl, I_REQ_LEN, frame.length);
    Atomics.store(ctrl, I_STATE, STATE_REQUEST);

    handle({ type: "doorbell", clientId: 5 });
    expect(Atomics.load(ctrl, I_STATE)).toBe(STATE_REQUEST);

    handle({ type: "register", clientId: 5, sab });
    handle({ type: "doorbell", clientId: 5 });
    expect(Atomics.load(ctrl, I_STATE)).toBe(STATE_RESPONSE_OK);
  });

  it("stops servicing a client after unregister", () => {
    const server = new FsServer();
    const handle = createFsWorkerHandler(server);
    const sab = createSyscallBuffer();
    handle({ type: "register", clientId: 1, sab });
    handle({ type: "unregister", clientId: 1 });

    const { ctrl, data } = makeViews(sab);
    const frame = encodeRequest([encodeString("/")]);
    data.set(frame, 0);
    Atomics.store(ctrl, I_OPCODE, OP_EXISTS);
    Atomics.store(ctrl, I_REQ_LEN, frame.length);
    Atomics.store(ctrl, I_STATE, STATE_REQUEST);
    handle({ type: "doorbell", clientId: 1 });
    expect(Atomics.load(ctrl, I_STATE)).toBe(STATE_REQUEST);
  });

  it("services a client when its own doorbell port rings, and stops after unregister", async () => {
    const server = new FsServer();
    const handle = createFsWorkerHandler(server);
    const sab = createSyscallBuffer();
    const { port1, port2 } = new MessageChannel();
    handle({ type: "register", clientId: 9, sab, port: port1 });

    const { ctrl, data } = makeViews(sab);
    const frame = encodeRequest([encodeString("/")]);
    data.set(frame, 0);
    Atomics.store(ctrl, I_OPCODE, OP_EXISTS);
    Atomics.store(ctrl, I_REQ_LEN, frame.length);
    Atomics.store(ctrl, I_STATE, STATE_REQUEST);

    port2.postMessage(null);
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(Atomics.load(ctrl, I_STATE)).toBe(STATE_RESPONSE_OK);

    Atomics.store(ctrl, I_STATE, STATE_REQUEST);
    handle({ type: "unregister", clientId: 9 });
    port2.postMessage(null);
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(Atomics.load(ctrl, I_STATE)).toBe(STATE_REQUEST);
    port2.close();
  });

  it("flushPersistence replies once the given flush() resolves, carrying the same id", async () => {
    const server = new FsServer();
    let resolveFlush!: () => void;
    const replies: unknown[] = [];
    const handle = createFsWorkerHandler(server, {
      flush: () => new Promise((resolve) => (resolveFlush = resolve)),
      reply: (m) => replies.push(m),
    });

    handle({ type: "flushPersistence", id: 7 });
    expect(replies).toEqual([]); // not yet - flush() hasn't resolved

    resolveFlush();
    await Promise.resolve();
    await Promise.resolve();
    expect(replies).toEqual([{ type: "flushPersistence:done", id: 7 }]);
  });

  it("flushPersistence with no persistence configured is a silent no-op (no reply, no throw)", () => {
    const server = new FsServer();
    const handle = createFsWorkerHandler(server);
    expect(() => handle({ type: "flushPersistence", id: 1 })).not.toThrow();
  });

  describe("lazyRestore (OPFS lazy restore)", () => {
    it("defers servicing a doorbell until ensureRestored's own promise resolves, then answers with the up-to-date result", async () => {
      const server = new FsServer();
      let resolveRestore!: () => void;
      const seen: string[][] = [];
      const handle = createFsWorkerHandler(server, {
        lazyRestore: {
          ensureRestored: (paths) => {
            seen.push(paths);
            return new Promise((resolve) => (resolveRestore = resolve));
          },
          discardPending: () => {},
        },
      });
      const sab = createSyscallBuffer();
      handle({ type: "register", clientId: 1, sab });
      publishExists(sab);

      handle({ type: "doorbell", clientId: 1 });
      expect(seen).toEqual([["/"]]);
      const { ctrl } = makeViews(sab);
      expect(Atomics.load(ctrl, I_STATE)).toBe(STATE_REQUEST); // not answered yet

      resolveRestore();
      await Promise.resolve();
      await Promise.resolve();
      expect(Atomics.load(ctrl, I_STATE)).toBe(STATE_RESPONSE_OK);
    });

    it("never calls ensureRestored for a doorbell with nothing actually pending (peekPendingRequest finds no request at all)", () => {
      const server = new FsServer();
      let calls = 0;
      const handle = createFsWorkerHandler(server, {
        lazyRestore: { ensureRestored: () => { calls++; return Promise.resolve(); }, discardPending: () => {} },
      });
      const sab = createSyscallBuffer();
      handle({ type: "register", clientId: 1, sab });
      // Nothing published - a stray/duplicate doorbell with no request behind it.
      handle({ type: "doorbell", clientId: 1 });
      expect(calls).toBe(0);
    });

    it("applies the same gate to a MessagePort doorbell, not just the postMessage 'doorbell' case (the path every real client actually uses)", async () => {
      const server = new FsServer();
      let resolveRestore!: () => void;
      const handle = createFsWorkerHandler(server, {
        lazyRestore: { ensureRestored: () => new Promise((resolve) => (resolveRestore = resolve)), discardPending: () => {} },
      });
      const sab = createSyscallBuffer();
      const { port1, port2 } = new MessageChannel();
      handle({ type: "register", clientId: 1, sab, port: port1 });
      publishExists(sab);

      port2.postMessage(null);
      await new Promise((resolve) => setTimeout(resolve, 20));
      const { ctrl } = makeViews(sab);
      expect(Atomics.load(ctrl, I_STATE)).toBe(STATE_REQUEST); // still deferred

      resolveRestore();
      await new Promise((resolve) => setTimeout(resolve, 20));
      expect(Atomics.load(ctrl, I_STATE)).toBe(STATE_RESPONSE_OK);
      port2.close();
    });

    it("without lazyRestore configured, a doorbell is serviced immediately, exactly as before", () => {
      const server = new FsServer();
      const handle = createFsWorkerHandler(server, { flush: () => Promise.resolve(), reply: () => {} });
      const sab = createSyscallBuffer();
      handle({ type: "register", clientId: 1, sab });
      publishExists(sab);

      handle({ type: "doorbell", clientId: 1 });
      const { ctrl } = makeViews(sab);
      expect(Atomics.load(ctrl, I_STATE)).toBe(STATE_RESPONSE_OK);
    });

    it("a recursive remove calls discardPending (synchronously) instead of ensureRestored, and services immediately - no wasted materialize-then-delete", () => {
      const server = new FsServer();
      let ensureRestoredCalls = 0;
      const discarded: string[][] = [];
      const handle = createFsWorkerHandler(server, {
        lazyRestore: {
          ensureRestored: () => { ensureRestoredCalls++; return Promise.resolve(); },
          discardPending: (paths) => discarded.push(paths),
        },
      });
      const sab = createSyscallBuffer();
      handle({ type: "register", clientId: 1, sab });
      server.vfs.mkdir("/home", { recursive: true });
      publishRm(sab, "/home", true);

      handle({ type: "doorbell", clientId: 1 });
      expect(discarded).toEqual([["/home"]]);
      expect(ensureRestoredCalls).toBe(0);
      const { ctrl } = makeViews(sab);
      expect(Atomics.load(ctrl, I_STATE)).toBe(STATE_RESPONSE_OK); // serviced right away, no deferral
    });

    it("a non-recursive remove still goes through ensureRestored, not discardPending", async () => {
      const server = new FsServer();
      const discarded: string[][] = [];
      let resolveRestore!: () => void;
      const handle = createFsWorkerHandler(server, {
        lazyRestore: {
          ensureRestored: () => new Promise((resolve) => (resolveRestore = resolve)),
          discardPending: (paths) => discarded.push(paths),
        },
      });
      const sab = createSyscallBuffer();
      handle({ type: "register", clientId: 1, sab });
      publishRm(sab, "/home", false);

      handle({ type: "doorbell", clientId: 1 });
      expect(discarded).toEqual([]);
      const { ctrl } = makeViews(sab);
      expect(Atomics.load(ctrl, I_STATE)).toBe(STATE_REQUEST); // deferred, same as any other op

      resolveRestore();
      await Promise.resolve();
      await Promise.resolve();
    });
  });
});

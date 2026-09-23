import { beforeEach, describe, expect, it, vi } from "vitest";
import { createFakeProcessWorker, type IFakeProcessWorker } from "../testing/fakeProcessWorker";
import {
  I_OPCODE,
  I_REQ_LEN,
  I_RES_LEN,
  I_STATE,
  OP_CRYPTO_DIGEST_SYNC,
  OP_SPAWN_SYNC,
  OP_ZLIB_SYNC,
  SPAWN_SYNC_NO_STATUS,
  STATE_IDLE,
  STATE_REQUEST,
  STATE_RESPONSE_ERR,
  STATE_RESPONSE_OK,
  bytesToU32,
  createSyscallBuffer,
  decodeBytes,
  decodeRequest,
  encodeRequest,
  encodeString,
  makeViews,
  u32ToBytes,
} from "../protocols/syscall";
import { createProcessTable } from "./processes";
import { createKernelSyncServer } from "./kernelSyncServer";

/** Publishes a request exactly like createSyscallClient.call() does, minus the Atomics.wait -
 *  this test drives the servicer synchronously and inspects the response directly. */
const publish = (views: ReturnType<typeof makeViews>, opcode: number, request: Uint8Array) => {
  views.data.set(request, 0);
  Atomics.store(views.ctrl, I_OPCODE, opcode);
  Atomics.store(views.ctrl, I_REQ_LEN, request.length);
  Atomics.store(views.ctrl, I_STATE, STATE_REQUEST);
};

const spawnSyncRequest = (command: string, args: string[], opts: { cwd?: string; env?: Record<string, string>; input?: Uint8Array; timeoutMs?: number } = {}) =>
  encodeRequest([
    encodeString(command),
    encodeString(JSON.stringify(args)),
    encodeString(opts.cwd ?? ""),
    encodeString(opts.env ? JSON.stringify(opts.env) : ""),
    opts.input ?? new Uint8Array(0),
    u32ToBytes(opts.timeoutMs ?? 0),
  ]);

const setupServer = () => {
  const workers: IFakeProcessWorker[] = [];
  let nextPid = 1;
  const table = createProcessTable({
    createProcessWorker: () => {
      const worker = createFakeProcessWorker();
      workers.push(worker);
      return worker;
    },
    attachFsClient: () => ({ sab: new SharedArrayBuffer(8), port: {} as MessagePort }),
    detachFsClient: () => {},
    attachSyncClient: () => ({ sab: new SharedArrayBuffer(8), port: {} as MessagePort }),
    detachSyncClient: () => {},
    attachNetClient: () => ({ sab: new SharedArrayBuffer(8), port: {} as MessagePort }),
    detachNetClient: () => {},
    netRelay: { unlisten: () => {}, connect: () => {}, data: () => {}, shutdown: () => {}, close: () => {}, releasePid: () => {} },
    emit: () => {},
  });
  const server = createKernelSyncServer({ processes: table, allocatePid: () => nextPid++ });
  const sab = createSyscallBuffer();
  const views = makeViews(sab);
  server.registerClient(1, sab);
  return { server, views, workers, table };
};

let t: ReturnType<typeof setupServer>;
beforeEach(() => {
  t = setupServer();
});

describe("kernelSyncServer", () => {
  it("spawns the command and responds once it exits, with buffered output", () => {
    publish(t.views, OP_SPAWN_SYNC, spawnSyncRequest("echo", ["hi"]));
    t.server.service(1);

    expect(t.workers).toHaveLength(1);
    expect(t.workers[0].inits[0]).toMatchObject({ command: "echo", args: ["hi"] });
    expect(Atomics.load(t.views.ctrl, I_STATE)).toBe(STATE_REQUEST); // still parked: child hasn't exited yet

    t.workers[0].emit({ type: "stdout", chunk: new TextEncoder().encode("hi\n") });
    t.workers[0].emit({ type: "exit", code: 0 });

    expect(Atomics.load(t.views.ctrl, I_STATE)).toBe(STATE_RESPONSE_OK);
    const { fields } = decodeRequest(t.views.data.slice(0, Atomics.load(t.views.ctrl, I_RES_LEN)));
    const [pidBytes, statusBytes, signalBytes, stdoutBytes, stderrBytes] = fields;
    expect(bytesToU32(pidBytes)).toBe(1);
    expect(bytesToU32(statusBytes)).toBe(0);
    expect(decodeBytes(signalBytes)).toBe("");
    expect(decodeBytes(stdoutBytes)).toBe("hi\n");
    expect(stderrBytes).toHaveLength(0);
  });

  it("reports a null status and the signal name when the child is killed", () => {
    publish(t.views, OP_SPAWN_SYNC, spawnSyncRequest("sleep", ["9"]));
    t.server.service(1);
    t.table.kill(1, "SIGKILL");

    const { fields } = decodeRequest(t.views.data.slice(0, Atomics.load(t.views.ctrl, I_RES_LEN)));
    expect(bytesToU32(fields[1])).toBe(SPAWN_SYNC_NO_STATUS);
    expect(decodeBytes(fields[2])).toBe("SIGKILL");
  });

  it("writes input to the child's stdin, then ends it", () => {
    publish(t.views, OP_SPAWN_SYNC, spawnSyncRequest("cat", [], { input: new TextEncoder().encode("fed in") }));
    t.server.service(1);

    expect(t.workers[0].childEvents).toEqual([
      { type: "stdin", chunk: new TextEncoder().encode("fed in") },
      { type: "stdinEnd" },
    ]);
  });

  it("with no input, still ends stdin so the child sees EOF", () => {
    publish(t.views, OP_SPAWN_SYNC, spawnSyncRequest("cat", []));
    t.server.service(1);

    expect(t.workers[0].childEvents).toEqual([{ type: "stdinEnd" }]);
  });

  it("kills the child with SIGTERM once its timeout elapses", () => {
    vi.useFakeTimers();
    try {
      publish(t.views, OP_SPAWN_SYNC, spawnSyncRequest("sleep", ["9"], { timeoutMs: 50 }));
      t.server.service(1);

      vi.advanceTimersByTime(50);

      expect(t.workers[0].terminated).toBe(true);
      const { fields } = decodeRequest(t.views.data.slice(0, Atomics.load(t.views.ctrl, I_RES_LEN)));
      expect(decodeBytes(fields[2])).toBe("SIGTERM");
    } finally {
      vi.useRealTimers();
    }
  });

  it("responds ENOSYS for an unsupported opcode", () => {
    publish(t.views, 65, encodeRequest([]));
    t.server.service(1);

    expect(Atomics.load(t.views.ctrl, I_STATE)).toBe(STATE_RESPONSE_ERR);
    expect(decodeBytes(t.views.data.slice(0, Atomics.load(t.views.ctrl, I_RES_LEN)))).toBe("ENOSYS");
  });

  it("does nothing for an unknown client or a client with no pending request", () => {
    expect(() => t.server.service(99)).not.toThrow();
    expect(() => t.server.service(1)).not.toThrow(); // idle: nothing published yet
    expect(t.workers).toHaveLength(0);
  });

  it("unregisterClient stops further servicing", () => {
    t.server.unregisterClient(1);
    publish(t.views, OP_SPAWN_SYNC, spawnSyncRequest("echo", []));
    t.server.service(1);
    expect(t.workers).toHaveLength(0);
  });

  describe("OP_ZLIB_SYNC", () => {
    it("compresses and decompresses a gzip round trip", async () => {
      const input = new TextEncoder().encode("hello zlib sync");
      publish(t.views, OP_ZLIB_SYNC, encodeRequest([encodeString("gzip"), encodeString("compress"), input]));
      t.server.service(1);
      await vi.waitFor(() => expect(Atomics.load(t.views.ctrl, I_STATE)).toBe(STATE_RESPONSE_OK));
      const gzipped = t.views.data.slice(0, Atomics.load(t.views.ctrl, I_RES_LEN));
      // A real ISyscallClient.call() resets to idle after reading the response; do the same so
      // the same SAB can be reused for the second call below.
      Atomics.store(t.views.ctrl, I_STATE, STATE_IDLE);

      publish(t.views, OP_ZLIB_SYNC, encodeRequest([encodeString("gzip"), encodeString("decompress"), gzipped]));
      t.server.service(1);
      await vi.waitFor(() => expect(Atomics.load(t.views.ctrl, I_STATE)).toBe(STATE_RESPONSE_OK));
      const roundTripped = t.views.data.slice(0, Atomics.load(t.views.ctrl, I_RES_LEN));
      expect(decodeBytes(roundTripped)).toBe("hello zlib sync");
    });

    it("responds with an error for malformed gzip input", async () => {
      publish(t.views, OP_ZLIB_SYNC, encodeRequest([encodeString("gzip"), encodeString("decompress"), new TextEncoder().encode("not gzip")]));
      t.server.service(1);
      await vi.waitFor(() => expect(Atomics.load(t.views.ctrl, I_STATE)).toBe(STATE_RESPONSE_ERR));
    });
  });

  describe("OP_CRYPTO_DIGEST_SYNC", () => {
    it("computes a real SHA-256 digest via SubtleCrypto", async () => {
      const input = new TextEncoder().encode("hello");
      publish(t.views, OP_CRYPTO_DIGEST_SYNC, encodeRequest([encodeString("SHA-256"), input]));
      t.server.service(1);
      await vi.waitFor(() => expect(Atomics.load(t.views.ctrl, I_STATE)).toBe(STATE_RESPONSE_OK));
      const digest = t.views.data.slice(0, Atomics.load(t.views.ctrl, I_RES_LEN));
      const expected = new Uint8Array(await crypto.subtle.digest("SHA-256", input));
      expect(digest).toEqual(expected);
    });

    it("responds with an error for an algorithm SubtleCrypto doesn't support", async () => {
      publish(t.views, OP_CRYPTO_DIGEST_SYNC, encodeRequest([encodeString("MD5"), new TextEncoder().encode("x")]));
      t.server.service(1);
      await vi.waitFor(() => expect(Atomics.load(t.views.ctrl, I_STATE)).toBe(STATE_RESPONSE_ERR));
      expect(decodeBytes(t.views.data.slice(0, Atomics.load(t.views.ctrl, I_RES_LEN)))).toBe("ERR_CRYPTO_INVALID_DIGEST");
    });
  });
});

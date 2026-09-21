import { describe, expect, it } from "vitest";
import {
  I_OPCODE,
  I_REQ_LEN,
  I_RES_LEN,
  I_STATE,
  OP_READ_FILE,
  STATE_REQUEST,
  STATE_RESPONSE_ERR,
  STATE_RESPONSE_OK,
  createSyscallBuffer,
  decodeBytes,
  encodeRequest,
  encodeString,
  makeViews,
} from "../protocols/syscall";
import { spawnFixtureWorker } from "../testing/spawnFixtureWorker";
import { FsServer } from "./FsServer";

// Publishes a request the way a parked client would, without a second thread,
// so the server's behavior can be checked in isolation.
const publish = (
  sab: SharedArrayBuffer,
  opcode: number,
  fields: Uint8Array[] = [],
) => {
  const { ctrl, data } = makeViews(sab);
  const frame = encodeRequest(fields);
  data.set(frame, 0);
  Atomics.store(ctrl, I_OPCODE, opcode);
  Atomics.store(ctrl, I_REQ_LEN, frame.length);
  Atomics.store(ctrl, I_STATE, STATE_REQUEST);
};
const outcome = (sab: SharedArrayBuffer) => {
  const { ctrl, data } = makeViews(sab);
  const state = Atomics.load(ctrl, I_STATE);
  const payload = data.slice(0, Atomics.load(ctrl, I_RES_LEN));
  return { state, payload };
};

describe("FsServer", () => {
  it("answers a request and reports errno codes from the Vfs", () => {
    const server = new FsServer();
    const sab = createSyscallBuffer();
    server.registerClient(1, sab);

    publish(sab, OP_READ_FILE, [encodeString("/missing")]);
    server.service(1);
    const failed = outcome(sab);
    expect(failed.state).toBe(STATE_RESPONSE_ERR);
    expect(decodeBytes(failed.payload)).toBe("ENOENT");

    server.vfs.writeFile("/f", encodeString("hi"));
    publish(sab, OP_READ_FILE, [encodeString("/f")]);
    server.service(1);
    const ok = outcome(sab);
    expect(ok.state).toBe(STATE_RESPONSE_OK);
    expect(decodeBytes(ok.payload)).toBe("hi");
  });

  it("answers ENOSYS for unknown and kernel-range opcodes", () => {
    const server = new FsServer();
    const sab = createSyscallBuffer();
    server.registerClient(1, sab);

    for (const opcode of [62, 64, 999]) {
      publish(sab, opcode);
      server.service(1);
      expect(decodeBytes(outcome(sab).payload)).toBe("ENOSYS");
    }
  });

  it("answers EPROTO for malformed frames and missing fields, EIO for a non-errno failure", () => {
    const server = new FsServer();
    const sab = createSyscallBuffer();
    server.registerClient(1, sab);

    const { ctrl, data } = makeViews(sab);
    data.set([1, 0, 0, 0, 5, 0, 0, 0], 0); // claims 5 fields, has none
    Atomics.store(ctrl, I_OPCODE, OP_READ_FILE);
    Atomics.store(ctrl, I_REQ_LEN, 8);
    Atomics.store(ctrl, I_STATE, STATE_REQUEST);
    server.service(1);
    expect(decodeBytes(outcome(sab).payload)).toBe("EPROTO");

    publish(sab, OP_READ_FILE, []);
    server.service(1);
    expect(decodeBytes(outcome(sab).payload)).toBe("EPROTO");

    server.vfs.readFile = () => {
      throw new Error("boom");
    };
    publish(sab, OP_READ_FILE, [encodeString("/f")]);
    server.service(1);
    expect(decodeBytes(outcome(sab).payload)).toBe("EIO");
  });

  it("ignores unknown clients, clients with nothing pending, and unregistered clients", () => {
    const server = new FsServer();
    const sab = createSyscallBuffer();
    server.registerClient(1, sab);

    expect(() => server.service(42)).not.toThrow();
    server.service(1);
    expect(outcome(sab).state).toBe(0);

    server.unregisterClient(1);
    publish(sab, OP_READ_FILE, [encodeString("/f")]);
    server.service(1);
    expect(outcome(sab).state).toBe(STATE_REQUEST);
  });

  it("keeps clients isolated on separate buffers", () => {
    const server = new FsServer();
    const a = createSyscallBuffer();
    const b = createSyscallBuffer();
    server.registerClient(1, a);
    server.registerClient(2, b);
    server.vfs.writeFile("/x", encodeString("shared"));

    publish(a, OP_READ_FILE, [encodeString("/x")]);
    publish(b, OP_READ_FILE, [encodeString("/nope")]);
    server.service(2);
    server.service(1);
    expect(decodeBytes(outcome(a).payload)).toBe("shared");
    expect(decodeBytes(outcome(b).payload)).toBe("ENOENT");
  });

  it("does not leave a caller hanging when a response cannot fit the window", () => {
    const server = new FsServer();
    const sab = createSyscallBuffer();
    server.registerClient(1, sab);
    server.vfs.writeFile("/huge", new Uint8Array(2 * 1024 * 1024));

    publish(sab, OP_READ_FILE, [encodeString("/huge")]);
    server.service(1);
    expect(decodeBytes(outcome(sab).payload)).toBe("EMSGSIZE");
  });
});

describe("sync fs client across a real worker thread", () => {
  it("performs fs operations, including files larger than the syscall window", async () => {
    const server = new FsServer();
    const sab = createSyscallBuffer();
    server.registerClient(1, sab);

    const worker = spawnFixtureWorker(
      new URL("./fsWorkerFixture.mjs", import.meta.url),
      { sab },
    );
    const results = await new Promise<Record<string, any>>(
      (resolve, reject) => {
        worker.on("error", reject);
        worker.on("message", (message) => {
          if (message.type === "done") resolve(message.results);
          else server.service(1);
        });
      },
    );
    await worker.terminate();

    expect(results.read).toBe("hello");
    expect(results.readdir).toEqual(["src"]);
    expect(results.exists).toEqual([true, false]);
    expect(results.stat).toMatchObject({ kind: "file", size: 5 });
    expect(results.missing).toEqual({ ok: false, code: "ENOENT" });
    expect(results.enotdir).toEqual({ ok: false, code: "ENOTDIR" });
    expect(results.viaLink).toBe("hello");
    expect(results.readlink).toBe("/proj/src");
    expect(results.realpath).toBe("/proj/src/a.txt");
    expect(results.renamed).toEqual([false, true]);
    expect(results.removed).toBe(true);
    expect(results.fstatSize).toBe(6);
    expect(results.fdRead).toBe("bcd");
    expect(results.truncated).toBe("ab");
    expect(results.badFd).toEqual({ ok: false, code: "EBADF" });
    expect(results.bigSize).toBe(2_500_000);
    expect(results.bigRoundTrip).toBe(true);
  });
});

describe("FsServer file descriptor ownership", () => {
  const call = (server: FsServer, sab: SharedArrayBuffer, opcode: number, fields: Uint8Array[]) => {
    publish(sab, opcode, fields);
    server.service(1);
    return outcome(sab);
  };

  it("closes a client's open descriptors when it is unregistered", () => {
    const server = new FsServer();
    const sab = createSyscallBuffer();
    server.registerClient(1, sab);
    server.vfs.writeFile("/f", encodeString("x"));

    const flags = new Uint8Array(4);
    const mode = new Uint8Array(4);
    const opened = call(server, sab, 13 /* OP_OPEN */, [encodeString("/f"), flags, mode]);
    expect(opened.state).toBe(STATE_RESPONSE_OK);
    const fd = new DataView(opened.payload.buffer, opened.payload.byteOffset).getUint32(0, true);
    expect(() => server.vfs.fstat(fd)).not.toThrow();

    server.unregisterClient(1);
    expect(() => server.vfs.fstat(fd)).toThrow(expect.objectContaining({ code: "EBADF" }));
  });

  it("forgets descriptors the client closed itself, and never touches another client's", () => {
    const server = new FsServer();
    const a = createSyscallBuffer();
    const b = createSyscallBuffer();
    server.registerClient(1, a);
    server.registerClient(2, b);
    server.vfs.writeFile("/f", encodeString("x"));

    const open = (client: number, sab: SharedArrayBuffer) => {
      publish(sab, 13, [encodeString("/f"), new Uint8Array(4), new Uint8Array(4)]);
      server.service(client);
      return new DataView(outcome(sab).payload.buffer).getUint32(0, true);
    };
    const fdA = open(1, a);
    const fdB = open(2, b);

    const u32 = (n: number) => { const x = new Uint8Array(4); new DataView(x.buffer).setUint32(0, n, true); return x; };
    publish(a, 14 /* OP_CLOSE */, [u32(fdA)]);
    server.service(1);
    server.unregisterClient(1);
    expect(() => server.vfs.fstat(fdB)).not.toThrow();
    server.unregisterClient(2);
    expect(() => server.vfs.fstat(fdB)).toThrow();
  });
});

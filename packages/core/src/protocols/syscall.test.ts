import { Worker } from "node:worker_threads";
import { describe, expect, it } from "vitest";
import {
  DATA_BYTES,
  SyscallError,
  bytesToF64,
  bytesToU32,
  createSyscallBuffer,
  decodeBytes,
  decodeRequest,
  encodeRequest,
  encodeString,
  f64ToBytes,
  makeViews,
  readRequest,
  respondErr,
  respondOk,
  u32ToBytes,
} from "./syscall";

describe("syscall framing", () => {
  it("round-trips flags and fields", () => {
    const frame = encodeRequest(
      [encodeString("/a/b"), u32ToBytes(7), new Uint8Array(0)],
      1,
    );
    const { flags, fields } = decodeRequest(frame);

    expect(flags).toBe(1);
    expect(fields).toHaveLength(3);
    expect(decodeBytes(fields[0])).toBe("/a/b");
    expect(bytesToU32(fields[1])).toBe(7);
    expect(fields[2]).toHaveLength(0);
  });

  it("round-trips scalars, including a non-zero byteOffset view", () => {
    expect(bytesToF64(f64ToBytes(1.5))).toBe(1.5);
    const padded = new Uint8Array(12);
    padded.set(u32ToBytes(0xdeadbeef), 8);
    expect(bytesToU32(padded.subarray(8))).toBe(0xdeadbeef);
  });

  it("rejects truncated frames with EPROTO", () => {
    const frame = encodeRequest([encodeString("hello")]);
    expect(() => decodeRequest(frame.subarray(0, 4))).toThrow(SyscallError);
    expect(() => decodeRequest(frame.subarray(0, frame.length - 1))).toThrow(
      expect.objectContaining({ code: "EPROTO" }),
    );
  });
});

describe("syscall servicer", () => {
  it("answers oversize responses with EMSGSIZE instead of hanging", () => {
    const views = makeViews(createSyscallBuffer());
    respondOk(views, new Uint8Array(DATA_BYTES + 1));

    expect(Atomics.load(views.ctrl, 0)).toBe(3);
    expect(decodeBytes(views.data.slice(0, Atomics.load(views.ctrl, 3)))).toBe(
      "EMSGSIZE",
    );
  });
});

describe("syscall bridge across worker_threads", () => {
  it("parks a real worker until the servicer answers", async () => {
    const sab = createSyscallBuffer();
    const views = makeViews(sab);
    const worker = new Worker(
      new URL("./syscallWorkerFixture.mjs", import.meta.url),
      { workerData: { sab } },
    );

    const results = await new Promise<Record<string, any>>(
      (resolve, reject) => {
        worker.on("error", reject);
        worker.on("message", (message) => {
          if (message.type === "done") return resolve(message.results);

          const request = readRequest(views);
          if (request.opcode === 1) {
            respondOk(views, request.fields[0].slice());
          } else if (request.opcode === 2) {
            respondErr(views, "ENOENT");
          } else {
            respondOk(views, new Uint8Array(DATA_BYTES + 1));
          }
        });
      },
    );
    await worker.terminate();

    expect(results.echo).toEqual({ ok: true, value: "hello" });
    expect(results.fail).toEqual({ ok: false, code: "ENOENT" });
    expect(results.oversizeRequest).toEqual({ ok: false, code: "EMSGSIZE" });
    expect(results.oversizeResponse).toEqual({ ok: false, code: "EMSGSIZE" });
    expect(results.afterError).toEqual({ ok: true, value: "again" });
  });
});

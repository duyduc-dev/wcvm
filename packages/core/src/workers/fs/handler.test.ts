import { describe, expect, it } from "vitest";
import { FsServer } from "../../fs/FsServer";
import {
  I_OPCODE,
  I_REQ_LEN,
  I_STATE,
  OP_EXISTS,
  STATE_REQUEST,
  STATE_RESPONSE_OK,
  createSyscallBuffer,
  encodeRequest,
  encodeString,
  makeViews,
} from "../../protocols/syscall";
import { createFsWorkerHandler } from "./handler";

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
});

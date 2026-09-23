import { describe, expect, it } from "vitest";
import {
  OP_UDP_BIND,
  SyscallError,
  bytesToU32,
  decodeRequest,
  u32ToBytes,
  type ISyscallClient,
} from "../protocols/syscall";
import type { IChildProcessHost } from "./bindings/childProcess";
import type { IUdpHost, UdpEvent } from "./bindings/udp";
import { runScript } from "./harness";

// dgram.js requires stream_wrap unconditionally at module load, transitively through the same
// child_process.js path net.js/http.js already hit (see net.test.ts's own identical comment).
const noopChildProcessHost: IChildProcessHost = {
  spawn: () => {},
  kill: () => {},
  writeStdin: () => {},
  endStdin: () => {},
  writeIpc: () => {},
  endIpc: () => {},
  onEvent: () => {},
};

/** Simulates the kernel's netServer.ts's own UDP registry: reacts to send(), can push an
 *  incoming datagram back as if from the peer side. Mirrors net.test.ts's own createFakeNet. */
const createFakeUdp = () => {
  let handler: ((event: UdpEvent) => void) | null = null;
  const sent: Array<{ fromPort: number; toPort: number; chunk: string }> = [];
  const unbinds: number[] = [];
  const decoder = new TextDecoder();
  const host: IUdpHost = {
    unbind: (port) => unbinds.push(port),
    send: (fromPort, toPort, chunk) => sent.push({ fromPort, toPort, chunk: decoder.decode(chunk) }),
    onEvent: (h) => {
      handler = h;
    },
  };
  const emit = (event: UdpEvent) => queueMicrotask(() => handler?.(event));
  return { host, sent, unbinds, emit };
};

/** A fake OP_UDP_BIND servicer: `assign` decides the assigned port (or throws a SyscallError). */
const createFakeUdpSync = (assign: (port: number) => number): ISyscallClient => ({
  call: (opcode, request) => {
    expect(opcode).toBe(OP_UDP_BIND);
    const { fields } = decodeRequest(request);
    return u32ToBytes(assign(bytesToU32(fields[0])));
  },
});

describe("dgram.createSocket / bind", () => {
  it("bind(0) makes a real synchronous OP_UDP_BIND call and reports the assigned port", async () => {
    const netSync = createFakeUdpSync((port) => (port === 0 ? 54321 : port));
    const r = await runScript(
      {
        "/main.js": `
          const dgram = require('dgram');
          const s = dgram.createSocket('udp4');
          s.bind(0, () => { console.log('bound', s.address().port); s.close(); });
        `,
      },
      "/main.js",
      { childProcess: noopChildProcessHost, udp: createFakeUdp().host, netSync },
    );
    expect(r).toEqual(expect.objectContaining({ code: 0, stdout: "bound 54321\n", stderr: "" }));
  });

  it("an explicit port already bound surfaces as a real 'error' event with EADDRINUSE", async () => {
    const netSync = createFakeUdpSync(() => {
      throw new SyscallError("EADDRINUSE");
    });
    const r = await runScript(
      {
        "/main.js": `
          const dgram = require('dgram');
          const s = dgram.createSocket('udp4');
          s.on('error', (e) => { console.log('error', e.code); process.exit(0); });
          s.bind(3000);
        `,
      },
      "/main.js",
      { childProcess: noopChildProcessHost, udp: createFakeUdp().host, netSync },
    );
    expect(r).toEqual(expect.objectContaining({ code: 0, stdout: "error EADDRINUSE\n", stderr: "" }));
  });

  it("close() releases the port via unbind()", async () => {
    const fake = createFakeUdp();
    const netSync = createFakeUdpSync((port) => (port === 0 ? 4000 : port));
    await runScript(
      {
        "/main.js": `
          const dgram = require('dgram');
          const s = dgram.createSocket('udp4');
          s.bind(4000, () => { s.close(() => process.exit(0)); });
        `,
      },
      "/main.js",
      { childProcess: noopChildProcessHost, udp: fake.host, netSync },
    );
    expect(fake.unbinds).toEqual([4000]);
  });
});

describe("dgram send/receive", () => {
  it("send() implicitly binds an ephemeral port first, then reaches the host as real bytes", async () => {
    const fake = createFakeUdp();
    const netSync = createFakeUdpSync((port) => (port === 0 ? 55000 : port));
    const r = await runScript(
      {
        "/main.js": `
          const dgram = require('dgram');
          const s = dgram.createSocket('udp4');
          s.send('hello', 3000, '127.0.0.1', (err) => {
            console.log('sent', err);
            process.exit(0);
          });
        `,
      },
      "/main.js",
      { childProcess: noopChildProcessHost, udp: fake.host, netSync },
    );
    expect(r).toEqual(expect.objectContaining({ code: 0, stdout: "sent null\n", stderr: "" }));
    expect(fake.sent).toEqual([{ fromPort: 55000, toPort: 3000, chunk: "hello" }]);
  });

  it("an incoming datagram fires 'message' with a real Buffer and the sender's port in rinfo", async () => {
    const fake = createFakeUdp();
    const netSync = createFakeUdpSync((port) => {
      const assigned = port === 0 ? 5000 : port;
      queueMicrotask(() => fake.emit({ type: "message", port: assigned, fromPort: 6000, chunk: new TextEncoder().encode("hi") }));
      return assigned;
    });
    const r = await runScript(
      {
        "/main.js": `
          const dgram = require('dgram');
          const s = dgram.createSocket('udp4');
          s.on('message', (msg, rinfo) => {
            console.log(Buffer.isBuffer(msg), msg.toString(), rinfo.port, rinfo.address);
            s.close();
            process.exit(0);
          });
          s.bind(5000);
        `,
      },
      "/main.js",
      { childProcess: noopChildProcessHost, udp: fake.host, netSync },
    );
    expect(r).toEqual(expect.objectContaining({ code: 0, stdout: "true hi 6000 127.0.0.1\n", stderr: "" }));
  });

  it("a datagram to a port nobody has bound is simply never delivered - no error, no hang", async () => {
    // Nothing ever calls fake.emit() here: this proves the script exits on its own (the process
    // isn't kept alive waiting for a reply that will never come), matching real UDP's own
    // fire-and-forget, no-delivery-confirmation contract.
    const fake = createFakeUdp();
    const netSync = createFakeUdpSync((port) => (port === 0 ? 55001 : port));
    const r = await runScript(
      {
        "/main.js": `
          const dgram = require('dgram');
          const s = dgram.createSocket('udp4');
          s.send('nobody home', 9999, '127.0.0.1', () => {
            s.close();
            console.log('done');
          });
        `,
      },
      "/main.js",
      { childProcess: noopChildProcessHost, udp: fake.host, netSync },
    );
    expect(r).toEqual(expect.objectContaining({ code: 0, stdout: "done\n", stderr: "" }));
  });
});

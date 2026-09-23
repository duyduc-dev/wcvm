import { describe, expect, it } from "vitest";
import {
  OP_NET_LISTEN,
  SyscallError,
  bytesToU32,
  decodeRequest,
  u32ToBytes,
  type ISyscallClient,
} from "../protocols/syscall";
import type { IChildProcessHost } from "./bindings/childProcess";
import type { INetHost, NetEvent } from "./bindings/net";
import { runScript } from "./harness";

// net.js requires stream_wrap unconditionally at module load, and stream_wrap's binding is built
// by the SAME router pipe_wrap/process_wrap use (childProcess.ts's ChildRouter, which throws
// ENOSYS if no childProcess host is wired) - so requiring "net" needs one too, even though these
// tests never spawn a real child. Same pre-existing gotcha child_process.js itself already has
// (see CLAUDE.md's "Hard-won gotchas"), now shared transitively by net.js.
const noopChildProcessHost: IChildProcessHost = {
  spawn: () => {},
  kill: () => {},
  writeStdin: () => {},
  endStdin: () => {},
  writeIpc: () => {},
  endIpc: () => {},
  onEvent: () => {},
};

/** Simulates the kernel's netServer.ts: reacts to net:connect/listen, can push events back as if
 *  from the peer side. Mirrors fork.test.ts's own createFakeHost shape. */
const createFakeNet = () => {
  let handler: ((event: NetEvent) => void) | null = null;
  const connects: Array<{ ticket: number; port: number }> = [];
  const writes: Array<{ connId: number; chunk: string }> = [];
  const unlistens: number[] = [];
  const shutdowns: number[] = [];
  const closes: number[] = [];
  const decoder = new TextDecoder();
  const host: INetHost = {
    unlisten: (port) => unlistens.push(port),
    connect: (ticket, port) => connects.push({ ticket, port }),
    writeData: (connId, chunk) => writes.push({ connId, chunk: decoder.decode(chunk) }),
    shutdown: (connId) => shutdowns.push(connId),
    close: (connId) => closes.push(connId),
    onEvent: (h) => {
      handler = h;
    },
  };
  const emit = (event: NetEvent) => queueMicrotask(() => handler?.(event));
  return { host, connects, writes, unlistens, shutdowns, closes, emit };
};

/** A fake OP_NET_LISTEN servicer: `assign` decides the assigned port (or throws a SyscallError). */
const createFakeNetSync = (assign: (port: number, backlog: number) => number): ISyscallClient => ({
  call: (opcode, request) => {
    expect(opcode).toBe(OP_NET_LISTEN);
    const { fields } = decodeRequest(request);
    const port = bytesToU32(fields[0]);
    const backlog = bytesToU32(fields[1]);
    return u32ToBytes(assign(port, backlog));
  },
});

describe("net.createServer / listen", () => {
  it("listen() makes a real synchronous OP_NET_LISTEN call and reports the assigned port", async () => {
    const netSync = createFakeNetSync((port) => (port === 0 ? 54321 : port));
    const r = await runScript(
      {
        "/main.js":
          "const net = require('net'); const s = net.createServer(); s.listen(0, () => { console.log('listening', s.address().port); s.close(); });",
      },
      "/main.js",
      { childProcess: noopChildProcessHost, net: createFakeNet().host, netSync },
    );
    expect(r).toEqual(expect.objectContaining({ code: 0, stdout: "listening 54321\n", stderr: "" }));
  });

  it("an explicit port that's already in use surfaces as a real 'error' event with EADDRINUSE", async () => {
    const netSync = createFakeNetSync(() => {
      throw new SyscallError("EADDRINUSE");
    });
    const r = await runScript(
      {
        "/main.js":
          "const net = require('net'); const s = net.createServer(); s.on('error', (e) => { console.log('error', e.code); process.exit(0); }); s.listen(3000);",
      },
      "/main.js",
      { childProcess: noopChildProcessHost, net: createFakeNet().host, netSync },
    );
    expect(r).toEqual(expect.objectContaining({ code: 0, stdout: "error EADDRINUSE\n", stderr: "" }));
  });
});

describe("net.connect", () => {
  it("a refused connection (no listener) surfaces as a real 'error' event with ECONNREFUSED", async () => {
    const fake = createFakeNet();
    fake.host.connect = (ticket) => fake.emit({ type: "connectResult", ticket, ok: false, code: "ECONNREFUSED" });
    const r = await runScript(
      {
        "/main.js":
          "const net = require('net'); const s = net.connect(3000); s.on('error', (e) => { console.log('error', e.code); process.exit(0); });",
      },
      "/main.js",
      { childProcess: noopChildProcessHost, net: fake.host },
    );
    expect(r).toEqual(expect.objectContaining({ code: 0, stdout: "error ECONNREFUSED\n", stderr: "" }));
  });

  it("a successful connect() fires 'connect', and a write reaches the host as real bytes", async () => {
    const fake = createFakeNet();
    fake.host.connect = (ticket) => fake.emit({ type: "connectResult", ticket, ok: true, connId: 7 });
    const r = await runScript(
      {
        "/main.js":
          "const net = require('net'); const s = net.connect(3000, () => { console.log('connected'); s.write('hello'); process.exit(0); });",
      },
      "/main.js",
      { childProcess: noopChildProcessHost, net: fake.host },
    );
    expect(r).toEqual(expect.objectContaining({ code: 0, stdout: "connected\n", stderr: "" }));
    expect(fake.writes).toEqual([{ connId: 7, chunk: "hello" }]);
  });
});

describe("accepted connections (server side)", () => {
  it("an incoming connection fires the server's connection listener, and data flows both ways", async () => {
    const fake = createFakeNet();
    const netSync = createFakeNetSync((port) => {
      const assigned = port === 0 ? 3000 : port;
      // Simulates a peer connecting and immediately sending data, right after listen() succeeds -
      // real net.js's own onconnection/connection-listener wiring is synchronous once dispatched,
      // so a real peer's data can follow its own connection notification just as closely.
      queueMicrotask(() => {
        fake.emit({ type: "incoming", connId: 9, port: assigned });
        queueMicrotask(() => fake.emit({ type: "data", connId: 9, chunk: new TextEncoder().encode("hi") }));
      });
      return assigned;
    });
    const r = await runScript(
      {
        "/main.js": `
          const net = require('net');
          const server = net.createServer((socket) => {
            socket.on('data', (chunk) => {
              console.log('got', chunk.toString());
              socket.write('echo:' + chunk);
              server.close();
              process.exit(0);
            });
          });
          server.listen(0, () => console.log('listening'));
        `,
      },
      "/main.js",
      { childProcess: noopChildProcessHost, net: fake.host, netSync },
    );
    expect(r).toEqual(expect.objectContaining({ code: 0, stdout: "listening\ngot hi\n", stderr: "" }));
    expect(fake.writes).toEqual([{ connId: 9, chunk: "echo:hi" }]);
  });

  it("destroying an accepted connection does not unlisten the still-running server", async () => {
    // Regression test: an accepted socket's own TCP handle reports the SAME `port` its server
    // listens on (for getsockname()) - close()'ing that socket (e.g. a one-shot HTTP client
    // ending its connection) must not be mistaken for the SERVER itself closing, or every
    // connection's end would silently kill the server for all future requests.
    const fake = createFakeNet();
    const netSync = createFakeNetSync((port) => (port === 0 ? 3000 : port));
    queueMicrotask(() => fake.emit({ type: "incoming", connId: 9, port: 3000 }));
    const r = await runScript(
      {
        "/main.js": `
          const net = require('net');
          const server = net.createServer((socket) => {
            socket.destroy();
          });
          server.listen(3000, () => console.log('listening'));
          setTimeout(() => {
            console.log('still listening:', server.listening);
            process.exit(0);
          }, 10);
        `,
      },
      "/main.js",
      { childProcess: noopChildProcessHost, net: fake.host, netSync },
    );
    expect(r).toEqual(expect.objectContaining({ code: 0, stdout: "listening\nstill listening: true\n", stderr: "" }));
    expect(fake.unlistens).toEqual([]);
  });
});

import { describe, expect, it } from "vitest";
import { OP_NET_LISTEN, bytesToU32, decodeRequest, u32ToBytes, type ISyscallClient } from "../protocols/syscall";
import type { IChildProcessHost } from "./bindings/childProcess";
import type { INetHost, NetEvent } from "./bindings/net";
import { runScript } from "./harness";

// http.js requires stream_wrap/pipe_wrap unconditionally at module load (via net.js, which it
// itself requires) - same pre-existing gotcha as net.test.ts's own noopChildProcessHost.
const noopChildProcessHost: IChildProcessHost = {
  spawn: () => {}, kill: () => {}, writeStdin: () => {}, endStdin: () => {},
  writeIpc: () => {}, endIpc: () => {}, onEvent: () => {},
};

/** Simulates the kernel's netServer.ts, same shape as net.test.ts's own. */
const createFakeNet = () => {
  let handler: ((event: NetEvent) => void) | null = null;
  const writes: Uint8Array[] = [];
  const host: INetHost = {
    unlisten: () => {},
    connect: () => {},
    writeData: (_connId, chunk) => writes.push(chunk),
    shutdown: () => {},
    close: () => {},
    onEvent: (h) => {
      handler = h;
    },
  };
  const emit = (event: NetEvent) => queueMicrotask(() => handler?.(event));
  const writtenText = () => new TextDecoder().decode(concatAll(writes));
  return { host, writes, writtenText, emit };
};

const concatAll = (parts: Uint8Array[]): Uint8Array => {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
};

const createFakeNetSync = (assign: (port: number, backlog: number) => number): ISyscallClient => ({
  call: (opcode, request) => {
    expect(opcode).toBe(OP_NET_LISTEN);
    const { fields } = decodeRequest(request);
    return u32ToBytes(assign(bytesToU32(fields[0]), bytesToU32(fields[1])));
  },
});

describe("http.createServer (server side, over a real net.Server)", () => {
  it("responds to a GET request with a real HTTP/1.1 response, status line, headers, and body", async () => {
    const fake = createFakeNet();
    const netSync = createFakeNetSync((port) => {
      const assigned = port === 0 ? 4000 : port;
      queueMicrotask(() => {
        fake.emit({ type: "incoming", connId: 1, port: assigned });
        queueMicrotask(() =>
          fake.emit({ type: "data", connId: 1, chunk: new TextEncoder().encode("GET /hello HTTP/1.1\r\nHost: h\r\n\r\n") }),
        );
      });
      return assigned;
    });
    const r = await runScript(
      {
        "/main.js": `
          const http = require('http');
          const server = http.createServer((req, res) => {
            res.statusCode = 200;
            res.setHeader('Content-Type', 'text/plain');
            res.end('hello world');
            process.exit(0);
          });
          server.listen(0, () => console.log('listening'));
        `,
      },
      "/main.js",
      { childProcess: noopChildProcessHost, net: fake.host, netSync },
    );
    expect(r).toEqual(expect.objectContaining({ code: 0, stdout: "listening\n", stderr: "" }));
    const written = fake.writtenText();
    expect(written).toContain("HTTP/1.1 200");
    expect(written).toContain("Content-Type: text/plain");
    expect(written.endsWith("hello world")).toBe(true);
  });

  it("streams a POST request body to the handler via real Readable events", async () => {
    const fake = createFakeNet();
    const netSync = createFakeNetSync((port) => {
      const assigned = port === 0 ? 4001 : port;
      queueMicrotask(() => {
        fake.emit({ type: "incoming", connId: 2, port: assigned });
        queueMicrotask(() =>
          fake.emit({
            type: "data",
            connId: 2,
            chunk: new TextEncoder().encode("POST /submit HTTP/1.1\r\nHost: h\r\nContent-Length: 11\r\n\r\nhello world"),
          }),
        );
      });
      return assigned;
    });
    const r = await runScript(
      {
        "/main.js": `
          const http = require('http');
          const server = http.createServer((req, res) => {
            let body = '';
            req.on('data', (c) => { body += c; });
            req.on('end', () => {
              console.log('got', body);
              res.end('ack');
              process.exit(0);
            });
          });
          server.listen(0, () => {});
        `,
      },
      "/main.js",
      { childProcess: noopChildProcessHost, net: fake.host, netSync },
    );
    expect(r).toEqual(expect.objectContaining({ code: 0, stdout: "got hello world\n", stderr: "" }));
    expect(fake.writtenText()).toContain("ack");
  });

  it("res.end() with no explicit Content-Length uses real chunked encoding", async () => {
    const fake = createFakeNet();
    const netSync = createFakeNetSync((port) => {
      const assigned = port === 0 ? 4002 : port;
      queueMicrotask(() => {
        fake.emit({ type: "incoming", connId: 3, port: assigned });
        queueMicrotask(() => fake.emit({ type: "data", connId: 3, chunk: new TextEncoder().encode("GET / HTTP/1.1\r\nHost: h\r\n\r\n") }));
      });
      return assigned;
    });
    await runScript(
      {
        "/main.js": `
          const http = require('http');
          const server = http.createServer((req, res) => {
            res.write('ab');
            res.end('cd');
            process.exit(0);
          });
          server.listen(0, () => {});
        `,
      },
      "/main.js",
      { childProcess: noopChildProcessHost, net: fake.host, netSync },
    );
    const written = fake.writtenText();
    expect(written).toContain("Transfer-Encoding: chunked");
    expect(written).toMatch(/2\r\nab\r\n2\r\ncd\r\n0\r\n\r\n$/);
  });

  it("an Upgrade request fires 'upgrade' with the raw socket and any bytes past the headers", async () => {
    const fake = createFakeNet();
    const netSync = createFakeNetSync((port) => {
      const assigned = port === 0 ? 4003 : port;
      queueMicrotask(() => {
        fake.emit({ type: "incoming", connId: 4, port: assigned });
        queueMicrotask(() =>
          fake.emit({
            type: "data",
            connId: 4,
            chunk: new TextEncoder().encode("GET /ws HTTP/1.1\r\nHost: h\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n\r\nHEAD"),
          }),
        );
        // A later chunk on the same connection must reach the upgraded socket, not the parser.
        setTimeout(() => fake.emit({ type: "data", connId: 4, chunk: new TextEncoder().encode("LATER") }), 20);
      });
      return assigned;
    });
    const r = await runScript(
      {
        "/main.js": `
          const http = require('http');
          const server = http.createServer(() => console.log('request handler must not run'));
          server.on('upgrade', (req, socket, head) => {
            console.log('upgrade', req.url, req.headers.upgrade, head.toString());
            socket.write('HTTP/1.1 101 Switching Protocols\\r\\nUpgrade: websocket\\r\\nConnection: Upgrade\\r\\n\\r\\n');
            socket.on('data', (d) => {
              console.log('data', d.toString());
              process.exit(0);
            });
          });
          server.listen(0);
        `,
      },
      "/main.js",
      { childProcess: noopChildProcessHost, net: fake.host, netSync },
    );
    expect(r).toEqual(expect.objectContaining({ code: 0, stdout: "upgrade /ws websocket HEAD\ndata LATER\n", stderr: "" }));
    expect(fake.writtenText()).toBe("HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n\r\n");
  });
});

describe("http.request/http.get (client side, over a real net.Socket)", () => {
  it("parses a real HTTP/1.1 response: status, headers, and body", async () => {
    const fake = createFakeNet();
    let connId = 0;
    fake.host.connect = (ticket) => {
      connId += 1;
      fake.emit({ type: "connectResult", ticket, ok: true, connId });
      queueMicrotask(() => {
        const raw = "HTTP/1.1 201 Created\r\nContent-Type: text/plain\r\nContent-Length: 2\r\n\r\nok";
        fake.emit({ type: "data", connId, chunk: new TextEncoder().encode(raw) });
      });
    };
    const r = await runScript(
      {
        "/main.js": `
          const http = require('http');
          http.get('http://h:4000/x', (res) => {
            let body = '';
            res.on('data', (c) => { body += c; });
            res.on('end', () => {
              console.log(res.statusCode, res.headers['content-type'], body);
              process.exit(0);
            });
          });
        `,
      },
      "/main.js",
      { childProcess: noopChildProcessHost, net: fake.host },
    );
    expect(r).toEqual(expect.objectContaining({ code: 0, stdout: "201 text/plain ok\n", stderr: "" }));
  });

  it("a real client request is itself a valid HTTP/1.1 wire request (method, path, headers, body)", async () => {
    const fake = createFakeNet();
    let connId = 0;
    fake.host.connect = (ticket) => {
      connId += 1;
      fake.emit({ type: "connectResult", ticket, ok: true, connId });
    };
    await runScript(
      {
        "/main.js": `
          const http = require('http');
          const req = http.request('http://h:4000/create', { method: 'POST', headers: { 'X-Test': '1' } });
          req.on('finish', () => process.exit(0));
          req.end('payload');
        `,
      },
      "/main.js",
      { childProcess: noopChildProcessHost, net: fake.host },
    );
    const written = fake.writtenText();
    expect(written).toMatch(/^POST \/create HTTP\/1\.1\r\n/);
    expect(written).toContain("X-Test: 1");
    expect(written.endsWith("payload")).toBe(true);
  });
});

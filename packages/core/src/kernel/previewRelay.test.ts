import { describe, expect, it } from "vitest";
import { createPreviewRelay } from "./previewRelay";

const enc = new TextEncoder();
const dec = new TextDecoder();

/** connect()'s own synchronous resolve() defers its write to a microtask (see previewRelay.ts's
 *  comment on why) - tests that need to observe it drain the microtask queue once first. */
const tick = () => Promise.resolve();

/** A fake netServer: records connect()/writeData()/close() calls and lets the test drive
 *  onNetEvent() as if the real kernel had routed events back from a real server process. */
const createFakeNet = () => {
  const connects: Array<{ ticket: number; port: number }> = [];
  const writes: Array<{ connId: number; chunk: Uint8Array }> = [];
  const closes: number[] = [];
  const relay = createPreviewRelay({
    connect: (ticket, port) => connects.push({ ticket, port }),
    writeData: (connId, chunk) => writes.push({ connId, chunk }),
    close: (connId) => closes.push(connId),
  });
  return { relay, connects, writes, closes };
};

describe("previewRelay", () => {
  it("encodes a real HTTP/1.1 request (Host, Connection: close, Content-Length) and parses the response", async () => {
    const { relay, connects, writes, closes } = createFakeNet();
    const done = relay.fetch({ port: 4000, path: "/a?b=1", method: "POST", headers: [["X-Test", "1"]], body: enc.encode("hi") });

    expect(connects).toHaveLength(1);
    relay.onNetEvent({ type: "net:connectResult", ticket: connects[0].ticket, ok: true, connId: 9 });
    await tick();

    expect(writes).toHaveLength(1);
    expect(writes[0].connId).toBe(9);
    const sent = dec.decode(writes[0].chunk);
    expect(sent).toMatch(/^POST \/a\?b=1 HTTP\/1\.1\r\n/);
    expect(sent).toContain("Host: localhost:4000\r\n");
    expect(sent).toContain("Connection: close\r\n");
    expect(sent).toContain("X-Test: 1\r\n");
    expect(sent).toContain("Content-Length: 2\r\n");
    expect(sent.endsWith("hi")).toBe(true);

    relay.onNetEvent({
      type: "net:data",
      connId: 9,
      chunk: enc.encode("HTTP/1.1 201 Created\r\nContent-Type: text/plain\r\nContent-Length: 2\r\n\r\nok"),
    });

    await expect(done).resolves.toEqual({
      status: 201,
      statusMessage: "Created",
      headers: [["Content-Type", "text/plain"], ["Content-Length", "2"]],
      body: enc.encode("ok"),
    });
    // The connection is torn down the moment the response is fully parsed - one connection per
    // fetch, matching the explicit `Connection: close` sent above.
    expect(closes).toEqual([9]);
  });

  it("strips an incoming Host/Content-Length/Connection and never sends a body or Content-Length for a GET", async () => {
    const { relay, connects, writes } = createFakeNet();
    relay.fetch({ port: 1, path: "/", method: "GET", headers: [["Host", "example.com"], ["Connection", "keep-alive"]], body: null });
    relay.onNetEvent({ type: "net:connectResult", ticket: connects[0].ticket, ok: true, connId: 1 });
    await tick();
    const sent = dec.decode(writes[0].chunk);
    expect(sent).toBe("GET / HTTP/1.1\r\nHost: localhost:1\r\nConnection: close\r\n\r\n");
  });

  it("no listener on the port rejects the fetch with the real ECONNREFUSED code", async () => {
    const { relay, connects } = createFakeNet();
    const done = relay.fetch({ port: 1, path: "/", method: "GET", headers: [], body: null });
    relay.onNetEvent({ type: "net:connectResult", ticket: connects[0].ticket, ok: false, code: "ECONNREFUSED" });
    await expect(done).rejects.toMatchObject({ code: "ECONNREFUSED" });
  });

  it("the connection closing before a response is ever fully framed rejects instead of hanging forever", async () => {
    const { relay, connects } = createFakeNet();
    const done = relay.fetch({ port: 1, path: "/", method: "GET", headers: [], body: null });
    relay.onNetEvent({ type: "net:connectResult", ticket: connects[0].ticket, ok: true, connId: 5 });
    await tick();
    relay.onNetEvent({ type: "net:data", connId: 5, chunk: enc.encode("HTTP/1.1 200 OK\r\n") }); // headers not even complete yet
    relay.onNetEvent({ type: "net:close", connId: 5 });
    await expect(done).rejects.toMatchObject({ code: "ECONNRESET" });
  });

  it("a close-delimited response (no Content-Length/chunked) completes on net:close via finish()", async () => {
    const { relay, connects, closes } = createFakeNet();
    const done = relay.fetch({ port: 1, path: "/", method: "GET", headers: [], body: null });
    relay.onNetEvent({ type: "net:connectResult", ticket: connects[0].ticket, ok: true, connId: 3 });
    await tick();
    relay.onNetEvent({ type: "net:data", connId: 3, chunk: enc.encode("HTTP/1.0 200 OK\r\n\r\nhello") });
    relay.onNetEvent({ type: "net:close", connId: 3 });
    await expect(done).resolves.toMatchObject({ status: 200, body: enc.encode("hello") });
    // onMessageComplete always calls close() once a message completes, even when (as here) the
    // peer already closed its own end first - netServer.close() is idempotent against a
    // since-removed connection, so this redundant call is harmless, not a bug to work around.
    expect(closes).toEqual([3]);
  });
});

import { describe, expect, it } from "vitest";
import { PREVIEW_PATH_PREFIX } from "../../protocols/preview";
import { injectWebSocketShim, installPreviewWebSocketShim } from "./webSocketShim";

const ORIGIN = "http://localhost:4173";

interface IShimRequest {
  message: { type: string; port: number; path: string; protocols: string[] };
  targetOrigin: string;
  /** The host page's end of this socket's MessagePort. */
  port: MessagePort;
}

/** A preview iframe (at `pagePath`) inside a wcvm host page, built from Node's own web globals. */
const setup = ({ pagePath = "/__wcvm_preview__/3000/index.html", embedded = true } = {}) => {
  const requests: IShimRequest[] = [];
  const host = {
    location: new URL(`${ORIGIN}/`),
    postMessage: (message: IShimRequest["message"], targetOrigin: string, transfer: MessagePort[]) =>
      requests.push({ message, targetOrigin, port: transfer[0] }),
  } as Record<string, unknown>;
  host.parent = host;
  const native: Array<{ url: string; protocols: unknown }> = [];
  class FakeNativeWebSocket {
    constructor(url: string | URL, protocols?: unknown) {
      native.push({ url: String(url), protocols });
    }
  }
  const pagehide: Array<() => void> = [];
  const win = {
    WebSocket: FakeNativeWebSocket,
    EventTarget, Event, MessageEvent, CloseEvent, MessageChannel, Blob, DOMException,
    location: new URL(`${ORIGIN}${pagePath}`),
    parent: undefined as unknown,
    opener: null,
    postMessage: () => {},
    addEventListener: (_type: string, listener: () => void) => pagehide.push(listener),
  };
  win.parent = embedded ? host : win;
  installPreviewWebSocketShim(win as never, PREVIEW_PATH_PREFIX);
  const WS = win.WebSocket as unknown as typeof WebSocket;
  return { win, WS, requests, native, firePagehide: () => pagehide.forEach((l) => l()) };
};

/** Collects what the page's socket sends to the host, as the host side of the port sees it. */
const hostSide = (request: IShimRequest) => {
  const received: unknown[] = [];
  request.port.onmessage = (e) => received.push(e.data);
  return { received, deliver: (event: unknown) => request.port.postMessage(event) };
};

/** Records every event a socket dispatches, in order, as "type" or "type:detail". */
const record = (socket: WebSocket) => {
  const seen: string[] = [];
  socket.addEventListener("open", () => seen.push("open"));
  socket.addEventListener("error", () => seen.push("error"));
  socket.addEventListener("message", (e) => seen.push(`message:${typeof e.data === "string" ? e.data : Object.prototype.toString.call(e.data)}`));
  socket.addEventListener("close", (e) => seen.push(`close:${e.code}:${e.reason}:${e.wasClean}`));
  return seen;
};

describe("installPreviewWebSocketShim", () => {
  describe("which URLs are tunnelled", () => {
    it.each([
      ["a same-host URL, meaning this page's own server", `ws://localhost:4173/?token=t`, { port: 3000, path: "/?token=t" }],
      ["an http(s) URL, upgraded to ws(s) like a real WebSocket does", `${ORIGIN}/hmr`, { port: 3000, path: "/hmr" }],
      ["an explicit preview URL for another port", `ws://localhost:4173${PREVIEW_PATH_PREFIX}5000/ws?x=1`, { port: 5000, path: "/ws?x=1" }],
      ["a guest's own localhost:<port> address", "ws://localhost:3001/socket", { port: 3001, path: "/socket" }],
      ["a guest's own 127.0.0.1:<port> address", "ws://127.0.0.1:3002/", { port: 3002, path: "/" }],
    ])("tunnels %s", (_name, url, target) => {
      const t = setup();
      new t.WS(url, ["vite-hmr"]);
      expect(t.native).toEqual([]);
      expect(t.requests.map((r) => [r.message, r.targetOrigin])).toEqual([
        [{ type: "wcvm:previewWebSocket", ...target, protocols: ["vite-hmr"] }, ORIGIN],
      ]);
      t.requests[0].port.close();
    });

    it("leaves a real remote WebSocket alone", () => {
      const t = setup();
      new t.WS("wss://example.com/feed", "p");
      expect(t.requests).toEqual([]);
      expect(t.native).toEqual([{ url: "wss://example.com/feed", protocols: "p" }]);
    });

    it("leaves a same-host URL alone on a page that isn't a preview document", () => {
      const t = setup({ pagePath: "/some/app.html" });
      new t.WS("ws://localhost:4173/");
      expect(t.requests).toEqual([]);
      expect(t.native).toHaveLength(1);
    });

    it("falls back to a real WebSocket when there's no wcvm page to relay through", () => {
      const t = setup({ embedded: false });
      new t.WS("ws://localhost:4173/");
      expect(t.requests).toEqual([]);
      expect(t.native).toHaveLength(1);
    });

    it("installing twice keeps the first shim", () => {
      const t = setup();
      const first = t.win.WebSocket;
      installPreviewWebSocketShim(t.win as never, PREVIEW_PATH_PREFIX);
      expect(t.win.WebSocket).toBe(first);
    });
  });

  describe("a tunnelled socket", () => {
    it("has the real WebSocket shape before it opens", () => {
      const t = setup();
      const ws = new t.WS("ws://localhost:4173/path");
      expect(ws).toBeInstanceOf(EventTarget);
      expect(ws.url).toBe("ws://localhost:4173/path");
      expect([ws.readyState, ws.protocol, ws.extensions, ws.bufferedAmount, ws.binaryType]).toEqual([0, "", "", 0, "blob"]);
      expect([t.WS.CONNECTING, t.WS.OPEN, t.WS.CLOSING, t.WS.CLOSED, ws.OPEN]).toEqual([0, 1, 2, 3, 1]);
      expect(() => ws.send("too early")).toThrow(expect.objectContaining({ name: "InvalidStateError" }));
      t.requests[0].port.close();
    });

    it("opens, receives text and binary per binaryType, and closes cleanly - through on* handlers too", async () => {
      const t = setup();
      const ws = new t.WS("ws://localhost:4173/");
      const seen = record(ws);
      const handlerSaw: string[] = [];
      ws.onopen = () => handlerSaw.push("onopen");
      ws.onclose = () => handlerSaw.push("onclose");
      const host = hostSide(t.requests[0]);
      host.deliver({ kind: "open", protocol: "vite-hmr" });
      host.deliver({ kind: "message", data: "hello" });
      host.deliver({ kind: "message", data: new Uint8Array([1, 2]) });
      await expect.poll(() => seen.length).toBe(3);
      expect(ws.readyState).toBe(1);
      expect(ws.protocol).toBe("vite-hmr");

      ws.binaryType = "arraybuffer";
      host.deliver({ kind: "message", data: new Uint8Array([3]) });
      host.deliver({ kind: "close", code: 1000, reason: "done", wasClean: true });
      await expect.poll(() => seen.length).toBe(5);
      expect(seen).toEqual(["open", "message:hello", "message:[object Blob]", "message:[object ArrayBuffer]", "close:1000:done:true"]);
      expect(handlerSaw).toEqual(["onopen", "onclose"]);
      expect(ws.readyState).toBe(3);
      expect(ws.onopen).toBeTypeOf("function");
    });

    it("an unclean close fires 'error' before 'close', like a failed real connection", async () => {
      const t = setup();
      const ws = new t.WS("ws://localhost:4173/");
      const seen = record(ws);
      hostSide(t.requests[0]).deliver({ kind: "close", code: 1006, reason: "", wasClean: false });
      await expect.poll(() => seen.length).toBe(2);
      expect(seen).toEqual(["error", "close:1006::false"]);
    });

    it("sends text, bytes, and Blobs in call order", async () => {
      const t = setup();
      const ws = new t.WS("ws://localhost:4173/");
      const host = hostSide(t.requests[0]);
      const seen = record(ws);
      host.deliver({ kind: "open", protocol: "" });
      await expect.poll(() => seen).toEqual(["open"]);
      ws.send(new Blob(["blob"]));
      ws.send("text");
      ws.send(new Uint8Array([9, 8, 7]).subarray(1));
      ws.send(new Uint8Array([6]).buffer);
      await expect.poll(() => host.received.length).toBe(4);
      expect(host.received).toEqual([
        { kind: "send", data: new TextEncoder().encode("blob") },
        { kind: "send", data: "text" },
        { kind: "send", data: new Uint8Array([8, 7]) },
        { kind: "send", data: new Uint8Array([6]) },
      ]);
      t.requests[0].port.close();
    });

    it("close() validates like a real one, then asks the host to close and drops later sends", async () => {
      const t = setup();
      const ws = new t.WS("ws://localhost:4173/");
      const host = hostSide(t.requests[0]);
      const seen = record(ws);
      host.deliver({ kind: "open", protocol: "" });
      await expect.poll(() => seen).toEqual(["open"]);
      expect(() => ws.close(1001)).toThrow(expect.objectContaining({ name: "InvalidAccessError" }));
      expect(() => ws.close(1000, "x".repeat(124))).toThrow(expect.objectContaining({ name: "SyntaxError" }));
      ws.close(4000, "bye");
      expect(ws.readyState).toBe(2);
      ws.send("dropped");
      ws.close();
      await expect.poll(() => host.received.length).toBe(1);
      expect(host.received).toEqual([{ kind: "close", code: 4000, reason: "bye" }]);
      t.requests[0].port.close();
    });

    it("the page going away tells the host right away, with 1001", async () => {
      const t = setup();
      new t.WS("ws://localhost:4173/");
      const host = hostSide(t.requests[0]);
      t.firePagehide();
      await expect.poll(() => host.received).toEqual([{ kind: "close", code: 1001, reason: "" }]);
      t.requests[0].port.close();
    });
  });
});

describe("injectWebSocketShim", () => {
  const inject = (html: string) => new TextDecoder().decode(injectWebSocketShim(new TextEncoder().encode(html)));
  const SCRIPT = /<script>\(function installPreviewWebSocketShim[\s\S]*?<\/script>/;

  it("goes right after <head>, before any of the page's own scripts", () => {
    const out = inject(`<!doctype html><html><head><script type="module" src="/@vite/client"></script></head></html>`);
    expect(out.replace(SCRIPT, "[shim]")).toBe(`<!doctype html><html><head>[shim]<script type="module" src="/@vite/client"></script></head></html>`);
  });

  it("goes after an early <meta charset>, so the browser still finds it in the first 1024 bytes", () => {
    const out = inject(`<html><head lang="en"><meta charset="UTF-8" /><title>x</title></head></html>`);
    expect(out.replace(SCRIPT, "[shim]")).toBe(`<html><head lang="en"><meta charset="UTF-8" />[shim]<title>x</title></head></html>`);
  });

  it.each([
    ["no <head>: after <html>", `<html lang="en"><body>hi</body></html>`, `<html lang="en">[shim]<body>hi</body></html>`],
    ["no <html> either: after the doctype", `<!DOCTYPE html><p>hi`, `<!DOCTYPE html>[shim]<p>hi`],
    ["a bare fragment: at the very start", `<p>hi</p>`, `[shim]<p>hi</p>`],
    ["<header> is not <head>", `<body><header>h</header></body>`, `[shim]<body><header>h</header></body>`],
  ])("%s", (_name, html, expected) => {
    expect(inject(html).replace(SCRIPT, "[shim]")).toBe(expected);
  });

  it("leaves every original byte intact, whatever the document's charset", () => {
    const original = new Uint8Array([...new TextEncoder().encode("<head>"), 0xe9, 0xff, 0x00, ...new TextEncoder().encode("</head>")]);
    const out = injectWebSocketShim(original);
    const scriptLength = out.length - original.length;
    expect(out.subarray(0, 6)).toEqual(original.subarray(0, 6));
    expect(out.subarray(6 + scriptLength)).toEqual(original.subarray(6));
  });

  it("the injected source text runs on its own - nothing it needs lives outside the function", () => {
    const script = inject("<head></head>").match(/<script>([\s\S]*)<\/script>/)![1];
    const t = setup(); // for its host page and a fresh fake window to install onto
    const win = { ...t.win, WebSocket: class {} };
    new Function("window", script)(win);
    expect((win.WebSocket as unknown as { wcvmPreviewShim?: boolean }).wcvmPreviewShim).toBe(true);
    new (win.WebSocket as unknown as typeof WebSocket)("ws://localhost:4173/");
    expect(t.requests).toHaveLength(1);
    t.requests[0].port.close();
  });
});

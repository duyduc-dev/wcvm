// A previewed page's `WebSocket`, tunnelled to the guest server behind it. A Service Worker never
// sees WebSocket traffic (only fetch()es), so a page served by workers/preview/
// PreviewServiceWorker.ts could otherwise never open a socket to its own server: its
// `new WebSocket("ws://" + location.host + ...)` (exactly what Vite's HMR client does) would dial
// the REAL host page's origin, where nothing is listening. So the Service Worker injects this into
// every HTML document it serves (injectWebSocketShim below), replacing `WebSocket` with a
// same-API class that, for URLs that mean "this preview's server", hands the embedding wcvm page
// a MessagePort (src/apis/Preview.ts's createPreviewWebSocketRelay) instead of opening a real
// connection; the kernel's tunnel (kernel/previewWebSocket.ts) is the real RFC 6455 client.
//
// installPreviewWebSocketShim is injected as SOURCE TEXT (Function.prototype.toString), so it MUST
// stay self-contained: no imports, no module-level helpers, no class fields a compiler could lower
// into a helper call defined outside its body (`declare` fields only - they compile to nothing).
// Every DOM global it touches goes through `win`, so Vitest can hand it a fake window.

import { PREVIEW_PATH_PREFIX } from "../../protocols/preview";

interface IShimWindow {
  WebSocket: typeof WebSocket;
  EventTarget: typeof EventTarget;
  Event: typeof Event;
  MessageEvent: typeof MessageEvent;
  CloseEvent: typeof CloseEvent;
  MessageChannel: typeof MessageChannel;
  Blob: typeof Blob;
  DOMException: typeof DOMException;
  location: { href: string; origin: string; host: string; pathname: string };
  parent: IShimWindow;
  opener: IShimWindow | null;
  postMessage(message: unknown, targetOrigin: string, transfer?: Transferable[]): void;
  addEventListener(type: "pagehide", listener: () => void): void;
}

export function installPreviewWebSocketShim(win: IShimWindow, prefix: string): void {
  const NativeWebSocket = win.WebSocket;
  if (!NativeWebSocket || (NativeWebSocket as unknown as { wcvmPreviewShim?: boolean }).wcvmPreviewShim) return;

  const CONNECTING = 0;
  const OPEN = 1;
  const CLOSING = 2;
  const CLOSED = 3;

  type TunnelEvent =
    | { kind: "open"; protocol: string }
    | { kind: "message"; data: string | Uint8Array }
    | { kind: "close"; code: number; reason: string; wasClean: boolean };

  const parsePreviewPath = (pathname: string): { port: number; path: string } | undefined => {
    if (!pathname.startsWith(prefix)) return undefined;
    const rest = pathname.slice(prefix.length);
    const slash = rest.indexOf("/");
    const port = Number(slash === -1 ? rest : rest.slice(0, slash));
    if (!Number.isInteger(port) || port < 1 || port > 65535) return undefined;
    return { port, path: slash === -1 ? "/" : rest.slice(slash) };
  };

  /** Which guest port/path a WebSocket URL means, or undefined if it isn't a preview server's. */
  const resolveTarget = (url: URL): { port: number; path: string } | undefined => {
    const query = url.search;
    if (url.host === win.location.host) {
      // Same host as the page: an explicit preview URL names its own port; any other path is
      // relative to THIS page's own server (the common `location.host`-based case).
      const explicit = parsePreviewPath(url.pathname);
      if (explicit) return { port: explicit.port, path: explicit.path + query };
      const own = parsePreviewPath(win.location.pathname);
      return own ? { port: own.port, path: url.pathname + query } : undefined;
    }
    // A guest's own idea of its address (`ws://localhost:3000/...`) - its virtual port.
    if ((url.hostname === "localhost" || url.hostname === "127.0.0.1") && url.port) {
      return { port: Number(url.port), path: url.pathname + query };
    }
    return undefined;
  };

  /** The embedding wcvm page: the nearest same-origin ancestor (or opener) that isn't itself a
   *  previewed document. Cross-origin ancestors throw on `.location` access and are skipped. */
  const findHost = (): IShimWindow | undefined => {
    const candidates: IShimWindow[] = [];
    for (let w = win; w.parent && w.parent !== w; w = w.parent) candidates.push(w.parent);
    if (win.opener) candidates.push(win.opener);
    for (const candidate of candidates) {
      try {
        if (candidate.location.origin === win.location.origin && !parsePreviewPath(candidate.location.pathname)) return candidate;
      } catch {
        // cross-origin: not ours
      }
    }
    return undefined;
  };

  const live = new Set<PreviewWebSocket>();

  class PreviewWebSocket extends win.EventTarget {
    declare readonly url: string;
    declare readyState: number;
    declare protocol: string;
    declare readonly extensions: string;
    declare readonly bufferedAmount: number;
    declare binaryType: BinaryType;
    declare wcvmPort: MessagePort;
    declare wcvmQueue: Promise<void>;
    declare wcvmHandlers: Record<string, ((event: Event) => unknown) | null>;

    constructor(url: string | URL, protocols?: string | string[]) {
      super();
      const resolved = new URL(String(url), win.location.href);
      if (resolved.protocol === "http:") resolved.protocol = "ws:";
      else if (resolved.protocol === "https:") resolved.protocol = "wss:";
      const target = resolved.protocol === "ws:" || resolved.protocol === "wss:" ? resolveTarget(resolved) : undefined;
      const host = target && findHost();
      // Not a preview server (or no wcvm page to relay through): a real WebSocket, untouched.
      if (!target || !host) return new NativeWebSocket(url, protocols) as unknown as PreviewWebSocket;

      let list: string[] = [];
      if (typeof protocols === "string") list = [protocols];
      else if (protocols) list = [...protocols];
      Object.defineProperties(this, {
        url: { value: resolved.href, enumerable: true },
        extensions: { value: "", enumerable: true },
        bufferedAmount: { value: 0, enumerable: true },
      });
      this.readyState = CONNECTING;
      this.protocol = "";
      this.binaryType = "blob";
      this.wcvmQueue = Promise.resolve();
      this.wcvmHandlers = {};

      const channel = new win.MessageChannel();
      this.wcvmPort = channel.port1;
      channel.port1.onmessage = (event: MessageEvent) => this.wcvmReceive(event.data as TunnelEvent);
      host.postMessage(
        { type: "wcvm:previewWebSocket", port: target.port, path: target.path, protocols: list },
        win.location.origin,
        [channel.port2],
      );
      live.add(this);
    }

    send(data: string | ArrayBufferLike | ArrayBufferView | Blob): void {
      if (this.readyState === CONNECTING) throw new win.DOMException("Still in CONNECTING state.", "InvalidStateError");
      if (this.readyState !== OPEN) return; // CLOSING/CLOSED: discarded, like a real one
      // Queued, so a Blob (read asynchronously) can't be overtaken by a later string.
      this.wcvmQueue = this.wcvmQueue.then(async () => {
        let payload: string | Uint8Array;
        if (typeof data === "string") payload = data;
        else if (data instanceof win.Blob) payload = new Uint8Array(await data.arrayBuffer());
        else if (ArrayBuffer.isView(data)) payload = new Uint8Array(data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength));
        else payload = new Uint8Array(data.slice(0));
        this.wcvmPort.postMessage({ kind: "send", data: payload });
      });
    }

    close(code?: number, reason?: string): void {
      if (code !== undefined && code !== 1000 && (code < 3000 || code > 4999)) {
        throw new win.DOMException(`The close code must be either 1000, or between 3000 and 4999. ${code} is neither.`, "InvalidAccessError");
      }
      if (reason !== undefined && new TextEncoder().encode(reason).length > 123) {
        throw new win.DOMException("The close reason must not be greater than 123 UTF-8 bytes.", "SyntaxError");
      }
      if (this.readyState === CLOSING || this.readyState === CLOSED) return;
      this.readyState = CLOSING;
      this.wcvmQueue = this.wcvmQueue.then(() => this.wcvmPort.postMessage({ kind: "close", code, reason }));
    }

    /** The page is going away: tell the server now (1001, "going away" - what a browser sends
     *  on navigation), synchronously, since queued work may never run once it's gone. */
    wcvmAbandon(): void {
      if (this.readyState === CLOSED) return;
      this.readyState = CLOSED;
      this.wcvmPort.postMessage({ kind: "close", code: 1001, reason: "" });
      live.delete(this);
    }

    wcvmReceive(event: TunnelEvent): void {
      if (this.readyState === CLOSED) return;
      if (event.kind === "open") {
        if (this.readyState !== CONNECTING) return;
        this.readyState = OPEN;
        this.protocol = event.protocol;
        this.dispatchEvent(new win.Event("open"));
      } else if (event.kind === "message") {
        if (this.readyState !== OPEN) return;
        let data: string | ArrayBuffer | Blob = event.data as string;
        if (typeof event.data !== "string") {
          const bytes = event.data;
          data = this.binaryType === "arraybuffer" ? bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer : new win.Blob([bytes as Uint8Array<ArrayBuffer>]);
        }
        this.dispatchEvent(new win.MessageEvent("message", { data, origin: new URL(this.url).origin }));
      } else {
        this.readyState = CLOSED;
        live.delete(this);
        this.wcvmPort.close();
        // A browser fires 'error' first whenever the connection had to be failed rather than
        // closed cleanly (handshake refused, protocol error, dropped connection).
        if (!event.wasClean) this.dispatchEvent(new win.Event("error"));
        this.dispatchEvent(new win.CloseEvent("close", { code: event.code, reason: event.reason, wasClean: event.wasClean }));
      }
    }
  }

  // `onopen`/`onmessage`/... event handler attributes, registered as a real listener the first
  // time one is set (so their ordering relative to addEventListener() listeners matches a real one).
  for (const type of ["open", "message", "error", "close"]) {
    Object.defineProperty(PreviewWebSocket.prototype, `on${type}`, {
      configurable: true,
      enumerable: true,
      get(this: PreviewWebSocket) {
        return this.wcvmHandlers[type] ?? null;
      },
      set(this: PreviewWebSocket, handler: ((event: Event) => unknown) | null) {
        if (!(type in this.wcvmHandlers)) {
          this.addEventListener(type, (event) => this.wcvmHandlers[type]?.call(this, event));
        }
        this.wcvmHandlers[type] = typeof handler === "function" ? handler : null;
      },
    });
  }
  const constants = { CONNECTING, OPEN, CLOSING, CLOSED };
  for (const [name, value] of Object.entries(constants)) {
    Object.defineProperty(PreviewWebSocket, name, { value, enumerable: true });
    Object.defineProperty(PreviewWebSocket.prototype, name, { value, enumerable: true });
  }
  Object.defineProperty(PreviewWebSocket, "wcvmPreviewShim", { value: true });

  win.addEventListener("pagehide", () => {
    for (const socket of live) socket.wcvmAbandon(); // deleting the visited entry mid-iteration is safe
  });
  win.WebSocket = PreviewWebSocket as unknown as typeof WebSocket;
}

const SHIM_SCRIPT = `<script>(${installPreviewWebSocketShim.toString()})(window, ${JSON.stringify(PREVIEW_PATH_PREFIX)});</script>`;

// Byte offsets and character offsets agree under a single-byte decoding, so the insertion point
// found in this string is also the right byte offset - whatever the document's real charset is.
const latin1 = new TextDecoder("latin1");

/**
 * Inserts the shim as the first script the document runs: after `<head>` (or, failing that,
 * `<html>`/the doctype, or the very start) - but after a `<meta charset>` near the top if there is
 * one, since a browser only looks for that in the first 1024 bytes and the shim is bigger than that.
 */
export const injectWebSocketShim = (html: Uint8Array): Uint8Array => {
  const text = latin1.decode(html);
  const head = /<head(?=[\s>/])[^>]*>/i.exec(text);
  const charset = /<meta(?=[\s/])[^>]*charset[^>]*>/i.exec(text);
  let at = 0;
  if (charset && (!head || charset.index > head.index) && charset.index < 1024) at = charset.index + charset[0].length;
  else if (head) at = head.index + head[0].length;
  else {
    const opening = /<html(?=[\s>])[^>]*>/i.exec(text) ?? /<!doctype[^>]*>/i.exec(text);
    if (opening) at = opening.index + opening[0].length;
  }
  const script = new TextEncoder().encode(SHIM_SCRIPT);
  const out = new Uint8Array(html.length + script.length);
  out.set(html.subarray(0, at), 0);
  out.set(script, at);
  out.set(html.subarray(at), at + script.length);
  return out;
};

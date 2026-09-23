// The preview Service Worker: intercepts a same-origin fetch() to /__wcvm_preview__/<port>/<path>
// and relays it to whatever real http.createServer() a sandboxed script has listening on that
// virtual port. This worker never talks to the Kernel Worker directly - a Service Worker can only
// postMessage a Client (a window) or another same-registration Service Worker, never an arbitrary
// dedicated Worker - so it relays through whichever window client it's controlling; that window's
// own preview glue (src/preview.ts) forwards the request to the kernel over the SAME
// request/response channel every other host<->kernel call already uses (kernelBridge.request()).
// Everything else (a non-preview fetch, a navigate with no client yet) is left alone: not calling
// event.respondWith() means the browser just handles it as if this worker didn't exist.
//
// Service-Worker-specific globals (self.clients, FetchEvent, ...) aren't in the DOM lib this
// package's tsconfig already pulls in for the OTHER (dedicated) workers - the two libs define an
// overlapping but different-typed `self` and can't both be included - so they're declared locally
// below, just the handful actually used here, rather than switching this whole package to the
// "webworker" lib.

import { parsePreviewPath, type IPreviewFetchMessage, type IPreviewFetchReply } from "../../protocols/preview";

interface IClient {
  postMessage(message: unknown): void;
}

interface IFetchEvent {
  request: Request;
  clientId: string;
  resultingClientId?: string;
  respondWith(response: Promise<Response> | Response): void;
  waitUntil(promise: Promise<unknown>): void;
}

interface IExtendableEvent {
  waitUntil(promise: Promise<unknown>): void;
}

interface IExtendableMessageEvent {
  data: unknown;
}

interface IServiceWorkerGlobal {
  addEventListener(type: "install", listener: (event: IExtendableEvent) => void): void;
  addEventListener(type: "activate", listener: (event: IExtendableEvent) => void): void;
  addEventListener(type: "fetch", listener: (event: IFetchEvent) => void): void;
  addEventListener(type: "message", listener: (event: IExtendableMessageEvent) => void): void;
  skipWaiting(): Promise<void>;
  clients: {
    claim(): Promise<void>;
    get(id: string): Promise<IClient | undefined>;
  };
}

const sw = self as unknown as IServiceWorkerGlobal;

sw.addEventListener("install", () => {
  sw.skipWaiting();
});
sw.addEventListener("activate", (event) => {
  // Lets an already-open page start being controlled (and so intercepted) without a reload -
  // src/preview.ts's enable() waits for exactly this before resolving.
  event.waitUntil(sw.clients.claim());
});

let nextRequestId = 1;
const pending = new Map<string, (reply: IPreviewFetchReply) => void>();

sw.addEventListener("message", (event) => {
  const reply = event.data as IPreviewFetchReply | null;
  if (!reply || reply.type !== "wcvm:previewFetchResult") return;
  const resolve = pending.get(reply.requestId);
  if (!resolve) return;
  pending.delete(reply.requestId);
  resolve(reply);
});

const relay = (client: IClient, message: Omit<IPreviewFetchMessage, "type" | "requestId">): Promise<IPreviewFetchReply> => {
  const requestId = String(nextRequestId++);
  return new Promise((resolve) => {
    pending.set(requestId, resolve);
    const full: IPreviewFetchMessage = { type: "wcvm:previewFetch", requestId, ...message };
    client.postMessage(full);
  });
};

const respondFromGuest = async (event: IFetchEvent, port: number, path: string): Promise<Response> => {
  const clientId = event.clientId || event.resultingClientId;
  const client = clientId ? await sw.clients.get(clientId) : undefined;
  if (!client) return new Response("wcvm preview: no host page available to relay the request to", { status: 502 });

  const method = event.request.method;
  const headers: [string, string][] = [...event.request.headers.entries()];
  const body = method === "GET" || method === "HEAD" ? null : new Uint8Array(await event.request.arrayBuffer());

  const reply = await relay(client, { port, path, method, headers, body });
  if (!reply.ok) return new Response(`wcvm preview relay error: ${reply.error}`, { status: 502 });
  const { result } = reply;
  // result.body's static type (Uint8Array<ArrayBufferLike>, from structured-clone deserialization)
  // is stricter than what BodyInit's TS definition accepts - same generic-TypedArray friction as
  // httpParser.ts's own `buffer` field; a real Uint8Array is always a valid BodyInit at runtime.
  return new Response(result.body as BufferSource, { status: result.status, statusText: result.statusMessage, headers: result.headers });
};

sw.addEventListener("fetch", (event) => {
  const url = new URL(event.request.url);
  const target = parsePreviewPath(url.pathname);
  if (!target) return; // not a preview URL - let the browser handle it as normal
  event.respondWith(respondFromGuest(event, target.port, target.path + url.search));
});

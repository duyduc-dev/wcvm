// The preview Service Worker: intercepts a same-origin fetch() to /__wcvm_preview__/<port>/<path>
// and relays it to whatever real http.createServer() a sandboxed script has listening on that
// virtual port. This worker never talks to the Kernel Worker directly - a Service Worker can only
// postMessage a Client (a window) or another same-registration Service Worker, never an arbitrary
// dedicated Worker - so it relays through whichever window client it's controlling; that window's
// own preview glue (src/apis/Preview.ts) forwards the request to the kernel over the SAME
// request/response channel every other host<->kernel call already uses (kernelBridge.request()).
// Everything else (a non-preview fetch, a navigate with no client yet) is left alone: not calling
// event.respondWith() means the browser just handles it as if this worker didn't exist.
//
// Service-Worker-specific globals (self.clients, FetchEvent, ...) aren't in the DOM lib this
// package's tsconfig already pulls in for the OTHER (dedicated) workers - the two libs define an
// overlapping but different-typed `self` and can't both be included - so they're declared locally
// below, just the handful actually used here, rather than switching this whole package to the
// "webworker" lib.

import { type IPreviewFetchMessage, type IPreviewFetchReply, type IPreviewFetchResult } from "../../protocols/preview";
import { previewPortOf, previewRedirect, routePreviewRequest, type PreviewClientPorts, type PreviewRoute } from "./previewRouting";
import { injectWebSocketShim } from "./webSocketShim";

interface IClient {
  id: string;
  url: string;
  frameType?: "top-level" | "nested" | "auxiliary" | "none";
  postMessage(message: unknown): void;
}

interface IFetchEvent {
  request: Request;
  clientId: string;
  resultingClientId: string;
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
  location: { origin: string };
  addEventListener(type: "install", listener: (event: IExtendableEvent) => void): void;
  addEventListener(type: "activate", listener: (event: IExtendableEvent) => void): void;
  addEventListener(type: "fetch", listener: (event: IFetchEvent) => void): void;
  addEventListener(type: "message", listener: (event: IExtendableMessageEvent) => void): void;
  skipWaiting(): Promise<void>;
  clients: {
    claim(): Promise<void>;
    get(id: string): Promise<IClient | undefined>;
    matchAll(options?: { type?: "window" }): Promise<IClient[]>;
  };
}

const sw = self as unknown as IServiceWorkerGlobal;

sw.addEventListener("install", () => {
  sw.skipWaiting();
});
sw.addEventListener("activate", (event) => {
  // Lets an already-open page start being controlled (and so intercepted) without a reload -
  // src/apis/Preview.ts's enable() waits for exactly this before resolving.
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

// Always relay through the top-level wcvm page that called enable() - never event.clientId/
// resultingClientId. Those identify whoever is MAKING the request, which for a preview iframe
// NAVIGATING to this URL is the iframe's own (nested) browsing context, not the host page: it has
// no message listener of its own (its document is the guest server's raw response, not wcvm's own
// JS), and worse, resultingClientId names a client that doesn't exist yet at fetch time for a
// genuine cross-document navigation - clients.get() on it never resolves (a real, observed
// Chromium hang, not a hypothetical). A top-level client, by contrast, always already exists
// (it's the page that's running right now) and is exactly the one enable()'s own message listener
// is attached to - true whether the request came from that page's own fetch() (already covered by
// the existing preview:fetch tests) or, now, from an iframe's navigation or its own subresource
// fetches once loaded (also a nested client, so still correctly skipped).
// A previewed page opened in its own tab is top-level too - but it's not a wcvm page, so skip it.
const findHostClient = async (): Promise<IClient | undefined> => {
  const clients = await sw.clients.matchAll({ type: "window" });
  return clients.find((client) => client.frameType === "top-level" && previewPortOf(client.url, sw.location.origin) === undefined);
};

// A page with COEP: require-corp (needed here for SharedArrayBuffer/crossOriginIsolated, see
// examples/playground/vite.config.ts) can only embed an <iframe> whose own response ALSO
// declares a matching Cross-Origin-Embedder-Policy header - real Chromium enforcement
// (net::ERR_BLOCKED_BY_RESPONSE otherwise), independent of same-origin-ness. The guest server has
// no idea its response is being iframed into a COEP page, so every response this SW hands back -
// success or error - adds it; without it, a preview iframe navigation is silently blocked while a
// plain fetch() of the same URL (no nested browsing context involved) works fine either way.
const previewResponse = (body: BodyInit | null, init: ResponseInit): Response => {
  const headers = new Headers(init.headers);
  headers.set("Cross-Origin-Embedder-Policy", "require-corp");
  return new Response(body, { ...init, headers });
};

const headerValue = (headers: [string, string][], name: string): string | undefined =>
  headers.find(([key]) => key.toLowerCase() === name)?.[1];

// A previewed page's own `new WebSocket(...)` never reaches this worker at all (a Service Worker
// only ever sees fetch()es), so every HTML document a preview frame navigates to gets the shim
// (webSocketShim.ts) that tunnels them through the host page instead - only a real navigation's
// document, never a page's own fetch() of some HTML, and never a compressed body (no Content-
// Encoding is ever decoded on this path, so there'd be no way to find where to insert it).
const withWebSocketShim = (request: Request, result: IPreviewFetchResult): IPreviewFetchResult => {
  const contentType = headerValue(result.headers, "content-type") ?? "";
  const encoding = headerValue(result.headers, "content-encoding") ?? "identity";
  if (request.mode !== "navigate" || !/^\s*text\/html/i.test(contentType) || encoding.toLowerCase() !== "identity") return result;
  return {
    ...result,
    body: injectWebSocketShim(result.body),
    // The guest's own Content-Length described the body before injection.
    headers: result.headers.filter(([key]) => key.toLowerCase() !== "content-length"),
  };
};

const respondFromGuest = async (event: IFetchEvent, port: number, path: string): Promise<Response> => {
  const client = await findHostClient();
  if (!client) return previewResponse("wcvm preview: no host page available to relay the request to", { status: 502 });

  const method = event.request.method;
  const headers: [string, string][] = [...event.request.headers.entries()];
  const body = method === "GET" || method === "HEAD" ? null : new Uint8Array(await event.request.arrayBuffer());

  const reply = await relay(client, { port, path, method, headers, body });
  if (!reply.ok) return previewResponse(`wcvm preview relay error: ${reply.error}`, { status: 502 });
  const result = withWebSocketShim(event.request, reply.result);
  // result.body's static type (Uint8Array<ArrayBufferLike>, from structured-clone deserialization)
  // is stricter than what BodyInit's TS definition accepts - same generic-TypedArray friction as
  // httpParser.ts's own `buffer` field; a real Uint8Array is always a valid BodyInit at runtime.
  return previewResponse(result.body as BufferSource, { status: result.status, statusText: result.statusMessage, headers: result.headers });
};

// See previewRouting.ts: which clients are previewed documents, and the port each was served from.
const clientPorts: PreviewClientPorts = new Map();

/** A client this worker has never seen (see previewRouting.ts): ask the browser what it is, once. */
const lookupClientPort = async (clientId: string): Promise<number | undefined> => {
  const client = await sw.clients.get(clientId);
  const port = client ? previewPortOf(client.url, sw.location.origin) : undefined;
  clientPorts.set(clientId, port ?? null);
  return port;
};

const respond = (event: IFetchEvent, route: Exclude<PreviewRoute, { kind: "passthrough" }>): Promise<Response> | Response => {
  switch (route.kind) {
    case "guest":
      return respondFromGuest(event, route.port, route.path);
    case "redirect":
      // 307, not 302: a redirected POST (a form, a fetch() to "/api") keeps its method and body.
      return Response.redirect(route.location, 307);
    case "lookup":
      return lookupClientPort(route.clientId).then((port) => {
        if (port === undefined) return fetch(event.request); // not a preview after all: as if untouched
        return respond(event, previewRedirect(port, new URL(event.request.url)));
      });
  }
};

sw.addEventListener("fetch", (event) => {
  const { request, clientId, resultingClientId } = event;
  const route = routePreviewRequest(
    { url: request.url, mode: request.mode, referrer: request.referrer, clientId, resultingClientId },
    sw.location.origin,
    clientPorts,
  );
  if (route.kind === "passthrough") return; // not calling respondWith(): the browser handles it as normal
  event.respondWith(respond(event, route));
});

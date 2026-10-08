// The wire format for previewing a guest script's own listening http.Server, and the URL scheme
// a fetch() is recognized by. Shared by three very different contexts - the Service Worker
// (workers/preview/PreviewServiceWorker.ts), the main thread's relay glue (src/apis/Preview.ts), and
// the kernel worker's own request handler (workers/kernel/handlers/preview.ts) - so it stays
// dependency-free (no DOM lib, no worker-only globals) and framework-free.

/** Every previewable URL starts with this; the next path segment is the virtual port. */
export const PREVIEW_PATH_PREFIX = "/__wcvm_preview__/";

/** Query parameter the Service Worker is registered with to learn a non-default prefix. */
export const PREVIEW_PREFIX_PARAM = "prefix";

/** Validates a host-chosen preview prefix and normalizes it to a path with a trailing slash. Throws on
 *  anything that couldn't be a plain same-origin path prefix. */
export const normalizePreviewPrefix = (raw: string): string => {
  const trimmed = raw.trim();
  if (!trimmed.startsWith("/") || /[?#\\\s]/.test(trimmed) || trimmed.includes("//")) {
    throw new Error(`Invalid preview path prefix ${JSON.stringify(raw)}: expected an absolute path like "/__preview__/"`);
  }
  const normalized = trimmed.endsWith("/") ? trimmed : `${trimmed}/`;
  if (normalized === "/") throw new Error('Invalid preview path prefix "/": it would capture the whole origin');
  return normalized;
};

/** Splits `<prefix><port>/<rest>` (default `/__wcvm_preview__/<port>/<rest>`) into the port and the
 *  guest-relative path (including any query string) - `undefined` if `pathname` isn't a preview URL. */
export const parsePreviewPath = (pathname: string, prefix: string = PREVIEW_PATH_PREFIX): { port: number; path: string } | undefined => {
  if (!pathname.startsWith(prefix)) return undefined;
  const rest = pathname.slice(prefix.length);
  const slash = rest.indexOf("/");
  const portText = slash === -1 ? rest : rest.slice(0, slash);
  const port = Number(portText);
  if (!Number.isInteger(port) || port < 1 || port > 65535) return undefined;
  return { port, path: slash === -1 ? "/" : rest.slice(slash) };
};

/** SW -> window client (`Client.postMessage`): "please relay this fetch". */
export interface IPreviewFetchMessage {
  type: "wcvm:previewFetch";
  requestId: string;
  port: number;
  path: string;
  method: string;
  headers: [string, string][];
  body: Uint8Array | null;
}

/** window -> kernel worker (`kernelBridge.request("preview:fetch", ...)`) and its result. */
export interface IPreviewFetchRequest {
  port: number;
  path: string;
  method: string;
  headers: [string, string][];
  body: Uint8Array | null;
}

export interface IPreviewFetchResult {
  status: number;
  statusMessage: string;
  headers: [string, string][];
  body: Uint8Array;
}

/** window -> SW (a direct reply to the ServiceWorker that sent IPreviewFetchMessage). */
export type IPreviewFetchReply =
  | { type: "wcvm:previewFetchResult"; requestId: string; ok: true; result: IPreviewFetchResult }
  | { type: "wcvm:previewFetchResult"; requestId: string; ok: false; error: string };

/** window -> SW: "take control of me". `clients.claim()` otherwise runs once, when a worker first
 *  activates - a page that loads UNcontrolled while a worker is already active (a hard reload,
 *  DevTools' "Bypass for network" having been on) would never be controlled again. */
export interface IPreviewClaimMessage {
  type: "wcvm:previewClaim";
}

/** SW -> every top-level wcvm page when more than one is open (`Client.postMessage`): "does a guest
 *  server of yours listen on this port?" The preview Service Worker is shared by every tab of an
 *  origin, so without asking it can't tell whose iframe a request came from. */
export interface IPreviewProbeMessage {
  type: "wcvm:previewProbe";
  requestId: string;
  port: number;
}

/** window -> SW (a direct reply to the ServiceWorker that sent IPreviewProbeMessage). */
export interface IPreviewProbeReply {
  type: "wcvm:previewProbeResult";
  requestId: string;
  listening: boolean;
}

// --- WebSocket tunnel ------------------------------------------------------------------------
// A preview page's own `new WebSocket(...)` can't reach a guest server any other way: a Service
// Worker never sees WebSocket traffic at all (only fetch()es), so the page's WebSocket is
// replaced by a small shim (workers/preview/webSocketShim.ts, injected into every previewed HTML
// document by the Service Worker) that hands the host page a MessagePort; the host page
// (src/apis/Preview.ts) relays that port to the kernel, whose tunnel (kernel/previewWebSocket.ts)
// is the real RFC 6455 client end of a virtual TCP connection to the guest's 'upgrade' handler.

/** Everything the kernel -> host -> page direction carries for one socket, in order. */
export type PreviewWebSocketEvent =
  | { kind: "open"; protocol: string }
  | { kind: "message"; data: string | Uint8Array }
  | { kind: "close"; code: number; reason: string; wasClean: boolean };

/** page -> host, over the socket's own MessagePort. */
export type PreviewWebSocketCommand =
  | { kind: "send"; data: string | Uint8Array }
  | { kind: "close"; code?: number; reason?: string };

/** page -> host window (`postMessage` to the embedding wcvm page, the socket's MessagePort
 *  transferred alongside): "open a WebSocket to this guest port/path". */
export interface IPreviewWebSocketRequest {
  type: "wcvm:previewWebSocket";
  port: number;
  path: string;
  protocols: string[];
}

/** host -> kernel worker ("preview:wsOpen"); `id` is minted by the host, so events for it can
 *  never arrive before the host knows where to route them. */
export interface IPreviewWebSocketOpen {
  id: number;
  port: number;
  path: string;
  protocols: string[];
}

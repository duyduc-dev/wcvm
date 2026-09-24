// The wire format for previewing a guest script's own listening http.Server, and the URL scheme
// a fetch() is recognized by. Shared by three very different contexts - the Service Worker
// (workers/preview/PreviewServiceWorker.ts), the main thread's relay glue (src/apis/Preview.ts), and
// the kernel worker's own request handler (workers/kernel/handlers/preview.ts) - so it stays
// dependency-free (no DOM lib, no worker-only globals) and framework-free.

/** Every previewable URL starts with this; the next path segment is the virtual port. */
export const PREVIEW_PATH_PREFIX = "/__wcvm_preview__/";

/** Splits `/__wcvm_preview__/<port>/<rest>` into the port and the guest-relative path
 *  (including any query string) - `undefined` if `pathname` isn't a preview URL at all. */
export const parsePreviewPath = (pathname: string): { port: number; path: string } | undefined => {
  if (!pathname.startsWith(PREVIEW_PATH_PREFIX)) return undefined;
  const rest = pathname.slice(PREVIEW_PATH_PREFIX.length);
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

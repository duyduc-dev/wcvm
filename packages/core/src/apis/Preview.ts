import type { IKernelBridge } from "../bridges/kernel";
import {
  PREVIEW_PATH_PREFIX,
  type IPreviewFetchMessage,
  type IPreviewFetchReply,
  type IPreviewFetchResult,
  type IPreviewWebSocketOpen,
  type IPreviewWebSocketRequest,
  type PreviewWebSocketCommand,
  type PreviewWebSocketEvent,
} from "../protocols/preview";

export interface IPreviewApi {
  /**
   * Registers the preview Service Worker and waits until it's actually controlling this page
   * (clients.claim() lets an already-open page skip the reload a fresh registration would
   * otherwise need) - idempotent, safe to call more than once. Every later fetch() to a
   * `url()`-built address is relayed to whatever real http.createServer() is listening on that
   * virtual port.
   */
  enable(): Promise<void>;
  /** Builds the fetch()-able address for a guest server's virtual `port` (and, optionally, path). */
  url(port: number, path?: string): string;
  /**
   * Fires whenever any guest `net`/`http` server starts or stops listening on a virtual port -
   * e.g. to point a preview iframe at `url(port)` as soon as a dev server comes up, without
   * polling. Returns an unsubscribe function. Does not require `enable()` to have been called.
   */
  onListen(handler: (info: { port: number; listening: boolean }) => void): () => void;
}

/**
 * The host page's half of a previewed page's WebSockets: the page's shim
 * (workers/preview/webSocketShim.ts) posts this window an IPreviewWebSocketRequest with a
 * MessagePort for that one socket; this relays the port's commands to the kernel's tunnel
 * (kernel/previewWebSocket.ts) and the tunnel's "preview:ws" events back down the port. The id is
 * minted here, before the kernel ever hears of the socket, so no event can arrive unroutable.
 */
const createPreviewWebSocketRelay = (kernelBridge: IKernelBridge) => {
  let nextId = 1;
  const ports = new Map<number, MessagePort>();

  kernelBridge.on("preview:ws", (m) => {
    const id = m.id as number;
    const port = ports.get(id);
    if (!port) return;
    const event = m.event as PreviewWebSocketEvent;
    port.postMessage(event);
    if (event.kind === "close") {
      ports.delete(id);
      port.close();
    }
  });

  /** A `message` event on this window. Only a same-origin sender counts: every previewed page is
   *  served through the Service Worker on this page's own origin, and nothing else may open one. */
  const handleMessage = (event: MessageEvent, ownOrigin: string) => {
    const request = event.data as IPreviewWebSocketRequest | null;
    if (!request || request.type !== "wcvm:previewWebSocket" || event.origin !== ownOrigin) return;
    const port = event.ports[0];
    if (!port) return;
    const id = nextId++;
    ports.set(id, port);
    port.onmessage = (e: MessageEvent) => {
      const command = e.data as PreviewWebSocketCommand;
      if (command.kind === "send") kernelBridge.postMessage("preview:wsSend", { id, data: command.data });
      else if (command.kind === "close") kernelBridge.postMessage("preview:wsClose", { id, code: command.code, reason: command.reason });
    };
    const open: IPreviewWebSocketOpen = { id, port: request.port, path: request.path, protocols: request.protocols };
    kernelBridge.postMessage("preview:wsOpen", { ...open });
  };

  return { handleMessage };
};

const createPreviewApi = (kernelBridge: IKernelBridge): IPreviewApi => {
  let enabled: Promise<void> | undefined;
  const webSockets = createPreviewWebSocketRelay(kernelBridge);

  const handleMessage = (event: MessageEvent) => {
    const message = event.data as IPreviewFetchMessage | null;
    if (!message || message.type !== "wcvm:previewFetch") return;
    const source = event.source as ServiceWorker | null;
    if (!source) return;

    kernelBridge
      .request<IPreviewFetchResult>("preview:fetch", {
        port: message.port,
        path: message.path,
        method: message.method,
        headers: message.headers,
        body: message.body,
      })
      .then((result): IPreviewFetchReply => ({ type: "wcvm:previewFetchResult", requestId: message.requestId, ok: true, result }))
      .catch((error): IPreviewFetchReply => ({
        type: "wcvm:previewFetchResult",
        requestId: message.requestId,
        ok: false,
        error: error instanceof Error ? error.message : String(error),
      }))
      .then((reply) => source.postMessage(reply));
  };

  const enable = (): Promise<void> => {
    if (!enabled) {
      enabled = (async () => {
        await navigator.serviceWorker.register(new URL("workers/preview/PreviewServiceWorker.js", import.meta.url), { scope: "/" });
        await navigator.serviceWorker.ready;
        // A registration that's already active+claiming from an earlier page load leaves
        // `controller` set immediately - only wait for the event when it isn't, or a page whose
        // preview worker was already installed would hang here forever waiting for an event that
        // (correctly) never fires again.
        if (!navigator.serviceWorker.controller) {
          await new Promise<void>((resolve) => {
            navigator.serviceWorker.addEventListener("controllerchange", () => resolve(), { once: true });
          });
        }
        navigator.serviceWorker.addEventListener("message", handleMessage);
        // Every previewed HTML document is served by the Service Worker registered above, which
        // is what injects the WebSocket shim that talks to this listener - so it only matters
        // once that worker is controlling this page.
        globalThis.addEventListener("message", (event) => webSockets.handleMessage(event, location.origin));
      })();
    }
    return enabled;
  };

  const url = (port: number, path = "/"): string => `${PREVIEW_PATH_PREFIX}${port}${path.startsWith("/") ? path : `/${path}`}`;

  const onListen = (handler: (info: { port: number; listening: boolean }) => void): (() => void) => {
    const offListen = kernelBridge.on("net:listen", (m) => handler({ port: m.port as number, listening: true }));
    const offUnlisten = kernelBridge.on("net:unlisten", (m) => handler({ port: m.port as number, listening: false }));
    return () => {
      offListen();
      offUnlisten();
    };
  };

  return { enable, url, onListen };
};

export { createPreviewApi, createPreviewWebSocketRelay };

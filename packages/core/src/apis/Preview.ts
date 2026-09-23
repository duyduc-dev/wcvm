import type { IKernelBridge } from "../bridges/kernel";
import { PREVIEW_PATH_PREFIX, type IPreviewFetchMessage, type IPreviewFetchReply, type IPreviewFetchResult } from "../protocols/preview";

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

const createPreviewApi = (kernelBridge: IKernelBridge): IPreviewApi => {
  let enabled: Promise<void> | undefined;

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

export { createPreviewApi };

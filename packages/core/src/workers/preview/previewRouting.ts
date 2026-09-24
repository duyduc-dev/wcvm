// Which requests the preview Service Worker takes, and what it does with them - kept free of any
// Service Worker global so it's plain-Vitest-testable (PreviewServiceWorker.ts is just wiring).
//
// The hard case is an ABSOLUTE path from inside a previewed page. A document at
// /__wcvm_preview__/5173/ asking for `/@vite/client`, `/src/main.ts` or `fetch("/api")` resolves
// against the host page's origin root, not the preview prefix - so without this, the request never
// looks like a preview URL at all and falls through to the host's own server. Every Vite module URL
// is absolute. The fix: remember which Service Worker clients are previewed documents (and which
// port each came from), and REDIRECT their un-prefixed same-origin requests into that port's
// prefix. A redirect rather than answering under the original URL, so each resource has exactly one
// URL: `/src/a.ts` and `/__wcvm_preview__/5173/src/a.ts` would otherwise be two separate ES module
// instances, and a module's own relative imports/import.meta.url stay inside the prefix.
//
// respondWith() must be called synchronously, but asking which client made a request is async
// (clients.get()). So the port a client was served from is recorded at the moment its navigation
// is seen (`resultingClientId`) - known synchronously ever after. Only a client this worker has
// never seen (e.g. after the browser stopped and restarted an idle Service Worker, losing this
// in-memory map) needs an async lookup, once. A navigation has no clientId at all; its referrer
// (the document it's navigating away from) decides instead.

import { PREVIEW_PATH_PREFIX, parsePreviewPath } from "../../protocols/preview";

export interface IRoutableRequest {
  url: string;
  mode: string;
  referrer: string;
  clientId: string;
  resultingClientId: string;
}

export type PreviewRoute =
  /** A preview URL: relay it to the guest server on `port`. */
  | { kind: "guest"; port: number; path: string }
  /** Belongs to a preview but isn't in its canonical form: send the browser here instead. */
  | { kind: "redirect"; location: string }
  /** Made by a client this worker has never seen: ask clients.get() which it is, then decide. */
  | { kind: "lookup"; clientId: string }
  /** Nothing to do with a preview: let the browser handle it as if this worker didn't exist. */
  | { kind: "passthrough" };

/** clientId -> the virtual port its document was served from, or null for a known non-preview
 *  client (the host page, its workers, ...). */
export type PreviewClientPorts = Map<string, number | null>;

/** The preview port a same-origin URL belongs to, if any. */
export const previewPortOf = (url: string, origin: string): number | undefined => {
  const parsed = new URL(url);
  return parsed.origin === origin ? parsePreviewPath(parsed.pathname)?.port : undefined;
};

/** `url`'s path and query, moved inside `port`'s preview prefix. */
export const previewRedirect = (port: number, url: URL): { kind: "redirect"; location: string } => ({
  kind: "redirect",
  location: `${url.origin}${PREVIEW_PATH_PREFIX}${port}${url.pathname}${url.search}`,
});

export const routePreviewRequest = (request: IRoutableRequest, origin: string, clientPorts: PreviewClientPorts): PreviewRoute => {
  const url = new URL(request.url);
  if (url.origin !== origin) return { kind: "passthrough" };
  const navigate = request.mode === "navigate";

  const target = parsePreviewPath(url.pathname);
  if (target) {
    // `/__wcvm_preview__/5173` with no trailing slash: a document there would resolve its own
    // `./x` to `/__wcvm_preview__/x`, outside its port - send it to the slashed form first.
    if (navigate && url.pathname === `${PREVIEW_PATH_PREFIX}${target.port}`) return previewRedirect(target.port, new URL(`/${url.search}`, url));
    if (navigate && request.resultingClientId) clientPorts.set(request.resultingClientId, target.port);
    return { kind: "guest", port: target.port, path: target.path + url.search };
  }

  if (navigate) {
    // A previewed page navigating to one of its own absolute paths (a link to "/about", or
    // `location.href = "/"`) - its referrer is the page it's leaving.
    const port = request.referrer ? previewPortOf(request.referrer, origin) : undefined;
    if (port !== undefined) return previewRedirect(port, url);
    if (request.resultingClientId) clientPorts.set(request.resultingClientId, null);
    return { kind: "passthrough" };
  }

  if (!request.clientId) return { kind: "passthrough" };
  const port = clientPorts.get(request.clientId);
  if (port === undefined) return { kind: "lookup", clientId: request.clientId };
  return port === null ? { kind: "passthrough" } : previewRedirect(port, url);
};

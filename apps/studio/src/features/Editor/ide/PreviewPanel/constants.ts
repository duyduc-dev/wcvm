// A previewed page runs arbitrary guest code, so it's sandboxed like any other untrusted embed
// — same-origin is still needed for the preview Service Worker relay to apply to it.
export const PREVIEW_IFRAME_SANDBOX = "allow-scripts allow-same-origin allow-forms allow-popups allow-modals";

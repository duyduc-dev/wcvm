import { Connect, defineConfig, Plugin } from "vite";

// wcvm's own build (packages/core/tsup.config.ts) emits the preview Service Worker at
// dist/workers/preview/PreviewServiceWorker.js; new URL(..., import.meta.url) in src/preview.ts
// resolves it relative to wherever this app ends up serving wcvm's own dist/index.js from, so the
// exact final path/hash isn't fixed here - matched by a name fragment instead. A SW's own default
// scope is capped at its script's own directory unless the server says otherwise: since that
// directory is some nested node_modules/assets path, not "/", Service-Worker-Allowed has to
// widen it explicitly for the { scope: "/" } passed to register() to actually take effect.
const isPreviewServiceWorker = (url: string | undefined) => Boolean(url?.includes("PreviewServiceWorker"));

function previewServiceWorkerHeaders(): Plugin {
  const middleware: Connect.NextHandleFunction = (req, res, next) => {
    if (isPreviewServiceWorker(req.url)) {
      res.setHeader("Service-Worker-Allowed", "/");
    }
    next();
  };

  return {
    name: "wcvm-preview-sw-headers",
    configureServer(server) {
      server.middlewares.use(middleware);
    },
    configurePreviewServer(server) {
      server.middlewares.use(middleware);
    },
  };
}

// wcvm's synchronous fs bridge to the kernel worker needs SharedArrayBuffer, which only exists on
// a cross-origin-isolated page — these two response headers on every response are what
// `self.crossOriginIsolated` reflects; boot() throws ERR_NOT_ISOLATED without them.
function crossOriginIsolationHeaders(): Plugin {
  const middleware: Connect.NextHandleFunction = (_req, res, next) => {
    res.setHeader("Cross-Origin-Opener-Policy", "same-origin");
    res.setHeader("Cross-Origin-Embedder-Policy", "require-corp");
    next();
  };

  return {
    name: "wcvm-cross-origin-isolation-headers",
    configureServer(server) {
      server.middlewares.use(middleware);
    },
    configurePreviewServer(server) {
      server.middlewares.use(middleware);
    },
  };
}

export default defineConfig({
  plugins: [previewServiceWorkerHeaders(), crossOriginIsolationHeaders()],
  build: {
    // The built preview Service Worker (packages/core/dist/workers/preview/PreviewServiceWorker.js)
    // is small enough that Vite's default asset inlining would otherwise turn its
    // `new URL(..., import.meta.url)` reference into a `data:` URL - navigator.serviceWorker
    // .register() rejects that (a Service Worker's script must be a real same-origin URL, not an
    // opaque-origin data: one), so nothing gets inlined here at all.
    assetsInlineLimit: 0,
  },
});

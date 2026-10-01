import react, { reactCompilerPreset } from "@vitejs/plugin-react";
import babel from "@rolldown/plugin-babel";
import { defineConfig, type Connect, type Plugin } from "vite";
import tailwindcss from "@tailwindcss/vite";
import path from "node:path";
import { tanstackRouter } from "@tanstack/router-plugin/vite";

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

// wcvm's own build (packages/core/tsup.config.ts) emits the preview Service Worker at
// dist/workers/preview/PreviewServiceWorker.js; `wc.preview.enable()` resolves it relative to
// wherever this app ends up serving wcvm's own dist/index.js from (in dev, pnpm's workspace
// symlink means Vite serves it under `/@fs/...`), so the exact final path/hash isn't fixed here
// — matched by a name fragment instead, same as examples/playground/vite.config.ts does. A
// Service Worker's own default scope is capped at its script's own directory unless the server
// says otherwise: since that directory isn't "/", Service-Worker-Allowed has to widen it
// explicitly for the `{ scope: "/" }` `enable()` passes to `register()` to actually take effect
// — without this, registration throws a SecurityError and the whole preview feature silently
// never works.
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

// https://vite.dev/config/
export default defineConfig({
  plugins: [
    tanstackRouter({
      target: "react",
      autoCodeSplitting: true,
    }),
    react(),
    babel({ presets: [reactCompilerPreset()] }),
    tailwindcss(),
    crossOriginIsolationHeaders(),
    previewServiceWorkerHeaders(),
  ],
  resolve: {
    alias: [
      { find: "@", replacement: path.resolve(__dirname, "./src") },
      // prettier-plugin-svelte imports plain "prettier" (its Node entry, index.cjs - unparsable in
      // a browser build); everything here formats through the browser build instead. Anchored so
      // "prettier/standalone" and "prettier/plugins/*" are untouched.
      { find: /^prettier$/, replacement: "prettier/standalone" },
    ],
  },
  build: {
    // The built preview Service Worker is small enough that Vite's default asset inlining would
    // otherwise turn its `new URL(..., import.meta.url)` reference into a `data:` URL —
    // `navigator.serviceWorker.register()` rejects that (its script must be a real same-origin
    // URL, not an opaque-origin `data:` one) — so nothing gets inlined here at all.
    assetsInlineLimit: 0,
  },
});

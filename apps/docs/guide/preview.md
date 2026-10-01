# Preview a dev server

A script's `http.createServer()` is reachable from an `<iframe>` through a Service Worker relay. Register the worker with `wc.preview.enable()`, then point an iframe at `wc.preview.url(port)`:

```ts
await wc.preview.enable();
wc.preview.onListen(({ port, listening }) => {
  if (listening) iframe.src = wc.preview.url(port);            // "/__wcvm_preview__/<port>/"
});
```

## A complete Vite example

```ts
await wc.fs.mount({
  "package.json": {
    file: {
      contents: JSON.stringify({
        name: "app", private: true, type: "module", scripts: { dev: "vite" },
        // Vite 7 and the WebAssembly builds of esbuild and rollup: native binaries cannot run in a browser.
        devDependencies: { vite: "7.3.6" },
        overrides: { esbuild: "npm:esbuild-wasm@0.28.2", rollup: "npm:@rollup/wasm-node@4.63.4" },
      }),
    },
  },
  "index.html": { file: { contents: '<div id="app"></div><script type="module" src="/main.js"></script>' } },
  "main.js": { file: { contents: 'document.getElementById("app").textContent = "Hello from Vite, in the tab";' } },
}, "/app");

await (await wc.spawn("npm", ["install"], { cwd: "/app" })).exit;
const dev = await wc.spawn("npm", ["run", "dev"], { cwd: "/app" });   // onListen fires, the iframe loads
```

Edit a file with `wc.fs.writeFile` and Vite's hot module replacement updates the iframe. The preview tunnels WebSockets, so HMR works.

## How a request travels

```
iframe  ->  Service Worker  ->  host page  ->  kernel  ->  your server (a process worker)
```

A Service Worker cannot talk to a dedicated worker, only to a window, so it relays through the host page. The kernel opens a virtual TCP connection to your server and sends real HTTP/1.1 bytes. See the [architecture](/architecture#_7-the-virtual-network-and-preview) for the full sequence.

## What the preview needs

- **The Service Worker script.** It ships as `wcvm/preview-sw`; `enable()` registers it with scope `/`. If your bundler serves it from a nested path, send `Service-Worker-Allowed: /` for that file, otherwise registration throws a `SecurityError`. The playground's `vite.config.ts` shows how.
- **A path prefix.** Previewed pages live under `/__wcvm_preview__/<port>/`. A client-side router that matches on `location.pathname` needs that prefix as its base path. Absolute URLs inside the page (`/src/main.ts`, `fetch("/api")`) are redirected into the prefix for you.
- **Isolation on the host page, and on the iframe.** The host page is cross-origin isolated (`require-corp`), so an iframe's response must also declare COEP. The Service Worker adds it to every response it serves.

## Several tabs

All tabs of an origin share one Service Worker. With more than one wcvm page open, a request goes to the tab that has a server on that port. If two tabs listen on the **same** port, the worker prefers the focused tab, which is a heuristic. Keep one tab per project.

## Controlled pages

A Service Worker claims a page only when it first activates. `enable()` therefore asks an already-active worker to claim the page, which covers a page that loaded uncontrolled (a hard reload, or DevTools "Bypass for network" having been on). If `navigator.serviceWorker.controller` is still `null` afterwards, see [Troubleshooting](/guide/troubleshooting).

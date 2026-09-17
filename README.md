# duck-webcontainer-api

A WebContainer-style Node.js sandbox that runs entirely in the browser — a
virtual filesystem, a shell, real `node`/`npm` execution, and live preview of
servers started inside it, all inside Web Workers, no backend required.
Inspired by [StackBlitz WebContainers](https://webcontainers.io/), built as
its own kernel/worker architecture.

This repo is a pnpm monorepo. The thing you actually install and use in your
own app is the **`duckwc`** package under `packages/core`. This guide
walks through using it — for repo-local development (building this repo
itself, running its own demo), see
[`packages/core/README.md`](packages/core/README.md#development-of-this-repo)
and [`PROGRESS.md`](PROGRESS.md).

## Install

```bash
npm install duckwc
```

## 1. Boot the sandbox

```ts
import { bootWC } from "duckwc";

const dwc = bootWC(); // synchronous - no await needed
```

That's the entire setup on the JavaScript side. `bootWC()` spins up the
kernel/filesystem workers under the hood and returns real, immediately
usable handles (`dwc.fs`, `dwc.process`, `dwc.shell`, `dwc.preview`) — every
call on them transparently waits for the underlying boot handshake, so
nothing needs to be sequenced by hand. `await dwc.ready` is there if you
specifically want to know boot succeeded (or why it didn't) without making
an actual call.

## 2. Enable cross-origin isolation (recommended)

The library's synchronous bridges (`fs.*Sync`, `dwc.shell.exec()`,
`child_process.execFileSync` inside guest code) need `SharedArrayBuffer`,
which browsers only expose on a page served with:

```
Cross-Origin-Opener-Policy: same-origin
Cross-Origin-Embedder-Policy: require-corp
```

**This is optional** — without these headers `duckwc` still works, just
via a slower fallback and without the shell/sync-exec bridges. If you want
full functionality, add them to whatever serves your page. With Vite:

```ts
// vite.config.ts
export default defineConfig({
  plugins: [{
    name: "cross-origin-isolation",
    configureServer(server) {
      server.middlewares.use((_req, res, next) => {
        res.setHeader("Cross-Origin-Opener-Policy", "same-origin");
        res.setHeader("Cross-Origin-Embedder-Policy", "require-corp");
        next();
      });
    },
  }],
});
```

(Any static host or edge function works the same way — just set these two
response headers.)

## 3. If you want live `<iframe>` preview

Skip this step if you only need `dwc.fs`/`dwc.process`/`dwc.shell` (e.g. a
build-in-the-browser tool with no visual preview).

Previewing a server started inside the sandbox needs a Service Worker
registered on your own origin — the library can't inject this for you the
way it creates its own internal Workers, since
`navigator.serviceWorker.register()` only accepts a same-origin URL you
serve yourself:

1. Copy the built file at the package's `duckwc/preview-sw` export into
   your app's static output (e.g. `public/dwc-preview-sw.js` for
   Vite/Next/CRA-style setups):

   ```js
   // scripts/copy-preview-sw.mjs
   import { copyFileSync } from "node:fs";
   import { createRequire } from "node:module";
   const require = createRequire(import.meta.url);
   copyFileSync(require.resolve("duckwc/preview-sw"), "public/dwc-preview-sw.js");
   ```

2. Register it and point an iframe at a port your guest server listens on:

   ```ts
   await dwc.preview.enable({ swUrl: "/dwc-preview-sw.js" });

   dwc.addEventListener("listen", ({ port }) => {
     iframe.src = dwc.preview.url(port);
   });
   ```

3. If the script isn't served from your origin's root, also send
   `Service-Worker-Allowed: /` on its response, or the browser caps its
   scope to the script's own directory.

## 4. A minimal end-to-end example

```ts
import { bootWC } from "duckwc";

const dwc = bootWC();

await dwc.fs.mkdir("/project", { recursive: true });
await dwc.fs.writeFile(
  "/project/server.js",
  `require("http").createServer((req, res) => {
     res.end("hello from inside the sandbox");
   }).listen(3000);`,
);

const proc = await dwc.process.spawn("/project/server.js");

dwc.addEventListener("listen", ({ port }) => {
  document.querySelector("iframe")!.src = dwc.preview.url(port);
});
```

`examples/playground` in this repo is a complete, real working integration
(Vite + a real `npm install react react-dom` inside the sandbox + live
preview) if you want a fuller reference than the snippet above.

## Full API reference

See [`packages/core/README.md`](packages/core/README.md) — every method on
`dwc.fs`/`dwc.process`/`dwc.shell`/`dwc.preview`, exactly which Node
builtins are available inside guest `require()` calls, and known
limitations.

## Status

Actively developed, pre-1.0. Real `npm install` against the live registry
works end-to-end; a real Node HTTP server started inside the sandbox can be
previewed live in an iframe. [`PROGRESS.md`](PROGRESS.md) tracks exactly
what's verified working versus still in progress — check there before
assuming a given Node API or npm package "just works."

## License

`ISC` per `package.json` — no `LICENSE` file has been added to the repo yet.

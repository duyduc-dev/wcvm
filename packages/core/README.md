# wcvm

A WebContainer-style Node.js sandbox that runs **entirely in the browser tab**, inside Web Workers,
with no backend. Boot it, write files, run `node`, `npm install` from the real registry, start a dev
server (Vite, Express, Next.js, SvelteKit, ...) and preview it in an `<iframe>`.

- Real processes: one Web Worker per PID, with stdout/stderr/stdin streams and `kill()`.
- A real Node.js runtime: Node v24's own `lib/` (vendored unmodified) on a small native layer written
  for the browser, so `fs`, `stream`, `http`, `net`, `child_process`, `zlib`, `worker_threads`,
  `readline`, ESM and CommonJS (including `require(esm)`) behave like Node.
- A shell (`sh`: `;` `&&` `||` pipes, redirects, `cd`) and a built-in `npm install` / `npm run` /
  `npm create`.
- A virtual network: a script's `http.createServer()` is reachable from an `<iframe>` through a
  Service Worker relay, including WebSockets (so HMR works).
- An in-memory filesystem, optionally mirrored to the browser's Origin Private File System so a
  project survives a reload.

> **Status: 0.x.** It runs unmodified Vite + React/Vue, Express, NestJS, Next.js, SvelteKit, React
> Router 7, Astro, Angular and Ember projects, but it is **not** full Node: see
> [Limitations](#limitations).

## Install

```bash
npm install wcvm
```

## Quick start

```ts
import { boot } from "wcvm";

const wc = boot({ persist: true });   // synchronous; throws ERR_NOT_ISOLATED if the page is not isolated
await wc.ready;

await wc.fs.mount({
  "package.json": { file: { contents: JSON.stringify({ name: "app", dependencies: { express: "^4" } }) } },
  "server.js": {
    file: {
      contents: `
        const app = require("express")();
        app.get("/", (req, res) => res.send("hello from the browser"));
        app.listen(3000, () => console.log("ready"));
      `,
    },
  },
});

const install = await wc.spawn("npm", ["install"]);          // from the real npm registry
console.log(await new Response(install.stdout).text());
await install.exit;

await wc.preview.enable();                                    // registers the preview Service Worker
wc.preview.onListen(({ port, listening }) => {
  if (listening) document.querySelector("iframe")!.src = wc.preview.url(port);
});
await wc.spawn("node", ["server.js"]);
```

### API

`boot(options?)` returns `{ spawn, fs, preview, diagnostics, ready }`.

| | |
|---|---|
| `boot({ persist, bootTimeoutMs })` | `persist: true` (or `{ root, lazyDepth }`) mirrors the filesystem to OPFS and restores it before the first call is served. |
| `wc.spawn(command, args, { cwd, env })` | Starts a process: `{ stdout, stderr, stdin, exit, kill(signal?) }`. An unknown command exits 127. |
| `wc.fs` | `readFile writeFile exists readdir mkdir stat lstat rm rename cp symlink readlink realpath chmod mount fetch sync reset`. `sync()` resolves once the OPFS mirror has caught up. |
| `wc.preview` | `enable()`, `url(port, path?)`, `onListen(handler)`. |
| `wc.diagnostics` | `onEvent(handler)` for kernel events, useful when debugging. |

Built-in commands: `echo cat ls pwd mkdir rm sleep clear true false node sh npm`.

## Requirements

**Cross-origin isolation.** The synchronous filesystem bridge needs `SharedArrayBuffer`, which browsers
only expose on a page served with:

```
Cross-Origin-Opener-Policy: same-origin
Cross-Origin-Embedder-Policy: require-corp
```

`boot()` throws `ERR_NOT_ISOLATED` otherwise. The Process Worker is loaded from a `blob:` URL, so a
Content-Security-Policy must allow `blob:` in `worker-src`/`script-src`.

**Preview Service Worker.** `wc.preview.enable()` registers the worker shipped as `wcvm/preview-sw`
with scope `/`. If your bundler serves it from a nested path, send `Service-Worker-Allowed: /` for it
(see `examples/playground/vite.config.ts`). Preview pages are served from
`/__wcvm_preview__/<port>/`, and an app that routes on `location.pathname` needs to know that prefix.

**Several tabs.** All tabs of an origin share one preview Service Worker. With more than one wcvm page
open it relays through the tab that has a server on the requested port; if two tabs listen on the
*same* port it prefers the focused tab, which is a heuristic.

## Limitations

wcvm vendors Node's own JavaScript but replaces everything native, so some things differ or are absent:

- No native add-ons (`.node` files); WebAssembly builds work (esbuild-wasm, SWC, Rolldown's browser build).
- `crypto` is hashing, `randomBytes` and `randomUUID` only; `zlib` has no Brotli or Zstd; DNS is a
  fixed-address shim; there is no real network (a sandbox `net`/`http` talks to other sandbox processes).
- `npm` is a minimal built-in, not the real npm: no lifecycle scripts, no workspaces.
- Vite is limited to Vite 7 (there is no WebAssembly Rolldown for Vite 8).
- Frameworks that rely on worker pools using `child_process.fork` may need `JOBS=1`.
- V8 internals with no JavaScript equivalent (Promise state, Proxy details) are approximated.

The roadmap and a detailed list of deliberate differences are in
[`PLAN.md`](https://github.com/duyduc-dev/wcvm/blob/main/PLAN.md).

## Studio and the playground

The repository also contains **Studio** (`apps/studio`), a VS Code-style in-browser IDE built on wcvm
(Monaco editor, terminals, preview, project templates), and a **playground**
(`examples/playground`) with the Playwright end-to-end suite.

## Development

```bash
pnpm install
pnpm --filter wcvm test          # Vitest (use Node 24)
pnpm build                       # builds packages/core (tsup) and the apps
pnpm --filter playground e2e     # real Chromium
```

Read [`CLAUDE.md`](https://github.com/duyduc-dev/wcvm/blob/main/CLAUDE.md) and
[`AGENTS.md`](https://github.com/duyduc-dev/wcvm/blob/main/AGENTS.md) before changing the runtime.

## License

[ISC](LICENSE). The bundled Node.js runtime sources are MIT licensed; see
[`THIRD_PARTY_NOTICES.md`](THIRD_PARTY_NOTICES.md).

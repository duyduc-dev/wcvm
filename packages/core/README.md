<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="https://raw.githubusercontent.com/duyduc-dev/wcvm/main/assets/logo-dark.svg">
    <img src="https://raw.githubusercontent.com/duyduc-dev/wcvm/main/assets/logo.svg" alt="wcvm" width="280">
  </picture>
</p>

<p align="center"><strong>Node.js in your browser tab. No backend.</strong></p>

# wcvm

A WebContainer-style Node.js sandbox that runs **entirely in the browser tab**, in Web Workers, with no
backend. Write files, run `node`, `npm install` from the real registry, start a dev server (Vite, Express,
Next.js, SvelteKit, ...) and show it in an `<iframe>` - all client-side.

> **Status: 0.x.** It runs unmodified Vite + React/Vue, Express, NestJS, Next.js, SvelteKit, React Router 7,
> Astro, Angular and Ember projects, but it is **not** full Node: see [Limitations](#limitations).

## How it works

<p align="center">
  <img src="https://raw.githubusercontent.com/duyduc-dev/wcvm/main/assets/architecture.svg" alt="wcvm architecture: host page, kernel worker, process workers, file system worker, and the preview service worker" width="760">
</p>

Every process is a **Web Worker**. A call such as `readFileSync` writes its request into a `SharedArrayBuffer` and parks the
worker with `Atomics.wait`; the **File System Worker** answers into the same buffer and wakes it, so guest code can block even
though the browser never lets a thread block on async work. The `node` runtime is **Node's own `lib/`**, vendored unmodified,
on a small native layer written for the browser. `http` servers are reachable from an `<iframe>` through a **Service Worker**
relay. The full design, with sequence diagrams, is in [`ARCHITECTURE.md`](https://github.com/duyduc-dev/wcvm/blob/main/ARCHITECTURE.md).

## Contents

1. [Install](#install) · 2. [Serve a page that can boot](#1-serve-a-page-that-can-boot) ·
3. [Boot and run a command](#2-boot-and-run-a-command) · 4. [Files](#3-work-with-files) ·
5. [Streams, stdin and a terminal](#4-stream-output-and-send-input) · 6. [Install packages](#5-install-packages) ·
7. [Run a dev server and preview it](#6-run-a-dev-server-and-preview-it) · 8. [Keep a project across reloads](#7-keep-a-project-across-reloads) ·
9. [Stop things](#8-stop-things) · [API summary](#api-summary) · [Frameworks](#frameworks-that-run) ·
[Troubleshooting](#troubleshooting) · [Limitations](#limitations) · [Architecture](#architecture)

## Install

```bash
npm install wcvm
```

An ES module for the browser, with no runtime dependencies.

## 1. Serve a page that can boot

wcvm's synchronous filesystem bridge needs `SharedArrayBuffer`, which browsers only expose on a
**cross-origin isolated** page. Serve the page that calls `boot()` with:

```
Cross-Origin-Opener-Policy: same-origin
Cross-Origin-Embedder-Policy: require-corp
```

`boot()` throws `ERR_NOT_ISOLATED` otherwise. With Vite:

```ts
// vite.config.ts
import { defineConfig } from "vite";

const isolation = {
  "Cross-Origin-Opener-Policy": "same-origin",
  "Cross-Origin-Embedder-Policy": "require-corp",
};
export default defineConfig({ server: { headers: isolation }, preview: { headers: isolation } });
```

If you set a Content-Security-Policy, allow `blob:` in `worker-src` / `script-src` (each process worker is
loaded from a `blob:` URL). `examples/playground/vite.config.ts` is a complete working setup.

## 2. Boot and run a command

```ts
import { boot } from "wcvm";

const wc = boot();     // synchronous
await wc.ready;        // the kernel worker is up

await wc.fs.writeFile("/hello.js", `console.log("hello from", process.version)`);

const proc = await wc.spawn("node", ["hello.js"], { cwd: "/" });
console.log(await new Response(proc.stdout).text());   // hello from v24.18.0
console.log((await proc.exit).exitCode);               // 0
```

`spawn(command, args, { cwd, env })` returns `{ stdout, stderr, stdin, exit, kill() }`. An unknown command
exits with status 127. Built-in commands: `echo cat ls pwd mkdir rm sleep clear true false node sh npm`.

## 3. Work with files

The filesystem is in memory and starts **empty** (no `/tmp`, no `/home`): create what you need.

```ts
await wc.fs.mkdir("/app/src", { recursive: true });           // writeFile does not create parents
await wc.fs.writeFile("/app/src/main.js", "console.log(1)");
const text = new TextDecoder().decode(await wc.fs.readFile("/app/src/main.js"));
console.log(await wc.fs.readdir("/app/src"));                  // ["main.js"]
```

Seed a whole project in one call with `mount`:

```ts
await wc.fs.mount({
  "package.json": { file: { contents: '{"name":"app"}' } },
  src: { directory: { "main.js": { file: { contents: "console.log(1)" } } } },
}, "/app");                                                    // a node is { file } | { directory } | { symlink }
```

Errors reject with a `WcvmError` whose `code` is the errno (`ENOENT`, `EEXIST`, ...). Other calls: `exists`,
`stat`, `lstat`, `rm`, `rename`, `cp` (recursive), `symlink`, `readlink`, `realpath`, `chmod`, `fetch(url, path)`.

## 4. Stream output and send input

Output is a `ReadableStream<Uint8Array>`; stdin is a `WritableStream<Uint8Array>`.

```ts
const pump = async (stream: ReadableStream<Uint8Array>, write: (s: string) => void) => {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  for (;;) {
    const { value, done } = await reader.read();
    if (done) return;
    write(decoder.decode(value, { stream: true }));
  }
};

const proc = await wc.spawn("node", ["server.js"], { cwd: "/app" });
void pump(proc.stdout, (text) => terminal.write(text));        // e.g. xterm.js
void pump(proc.stderr, (text) => terminal.write(text));

const writer = proc.stdin.getWriter();                          // feed it input
await writer.write(new TextEncoder().encode("hello\n"));
```

For an interactive shell, spawn `sh` with no arguments and wire a terminal to it. There is no pty: `sh` and the
`node` REPL read whole lines and do not echo, so the terminal widget does line editing and echo itself (Studio's
terminal, in `apps/studio`, is a working example).

`sh` supports `;` `&&` `||`, pipes, `>` `>>` `<` redirects (`2>&1`, `&>`, `2>/dev/null` too) and `cd`; it has no `$`
expansion, globbing, subshells, control flow or `&`.

## 5. Install packages

```ts
await wc.fs.mount({ "package.json": { file: { contents: '{"dependencies":{"express":"^4"}}' } } }, "/app");

const install = await wc.spawn("npm", ["install"], { cwd: "/app" });
void pump(install.stdout, console.log);
console.log((await install.exit).exitCode);
```

wcvm's `npm` is a small built-in, **not real npm**: `npm install [pkg...] [-D]`, `npm run <script>`,
`npm start|test`, `npm create <name>`. It installs from the real registry (or `--registry`) but has **no lockfile,
no lifecycle (`postinstall`) scripts and no workspaces**. `npx <bin>` runs a binary that is already installed.

## 6. Run a dev server and preview it

A script's `http.createServer()` is reachable from an `<iframe>` through a Service Worker relay. Register it with
`wc.preview.enable()`, then point an iframe at `wc.preview.url(port)`:

```ts
await wc.preview.enable();
wc.preview.onListen(({ port, listening }) => {
  if (listening) iframe.src = wc.preview.url(port);            // "/__wcvm_preview__/<port>/"
});
```

A complete example - a Vite app, installed and served entirely in the tab:

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

Edit a file with `wc.fs.writeFile` and Vite's hot module replacement updates the iframe (the preview also
tunnels WebSockets).

**What the preview needs:**
- The Service Worker script ships as `wcvm/preview-sw`; `enable()` registers it with scope `/`. If your bundler
  serves it from a nested path, send `Service-Worker-Allowed: /` for it (see `examples/playground/vite.config.ts`).
- Previewed pages live under `/__wcvm_preview__/<port>/`. A client-side router that matches on
  `location.pathname` needs that prefix as its base.
- All tabs of an origin share one Service Worker. With several tabs open, requests go to the tab that has a server on
  that port; if two tabs listen on the **same** port it prefers the focused tab, which is a heuristic. Keep one tab
  per project.

## 7. Keep a project across reloads

```ts
const wc = boot({ persist: true });        // or { root: "my-app", lazyDepth: 4 }
```

Every change is mirrored to the browser's Origin Private File System, **write-behind**, and restored before the
first call is served on the next load. A call returns before its OPFS write finishes, so before anything that could
lose recent writes (closing the tab right after an `npm install`) do:

```ts
await wc.fs.sync();                        // resolves once everything so far has landed
```

Give two wcvm instances on the same origin different `root` names if they must not share storage. If your
projects live under one parent directory (`/home/user/projects/<name>`), `lazyDepth: 4` restores each project
only when something first touches it, so boot stays fast. `wc.fs.reset()` clears everything, including the
persisted copy.

## 8. Stop things

```ts
proc.kill();            // SIGTERM (143); kill("SIGKILL") for 137. Also kills the processes it spawned.
await proc.exit;
```

There is no `SIGINT`: a command run from a shell runs inside that shell's own worker, so Ctrl+C cannot interrupt
it. End the shell (`kill()`) and start a new one.

## API summary

`boot(options?)` returns `{ spawn, fs, preview, diagnostics, ready }`.

| | |
|---|---|
| `boot({ persist, bootTimeoutMs })` | `persist`: `true` or `{ root, lazyDepth }`. `ready` rejects with `ERR_BOOT_TIMEOUT` (default 10 s). |
| `wc.spawn(cmd, args, { cwd, env })` | `{ processId, stdout, stderr, stdin, exit, kill(signal?) }`. |
| `wc.fs.*` | `readFile writeFile exists readdir mkdir stat lstat rm rename cp symlink readlink realpath chmod mount fetch sync reset`. |
| `wc.preview` | `enable()`, `url(port, path?)`, `onListen(handler)`. |
| `wc.diagnostics` | `onEvent(handler)`: kernel events, with the last 50 replayed to a late subscriber. |
| `WcvmError` | `type`: `ERR_NOT_ISOLATED` `ERR_WORKER` `ERR_NOT_IMPLEMENTED` `ERR_BOOT_TIMEOUT`; `code`: the errno for filesystem errors. |

## Frameworks that run

Each of these is exercised in real Chromium by this repository's end-to-end tests, installed from the real npm
registry and served through the preview:

Vite (React, Vue, Preact, Lit, Solid, Qwik, Svelte, vanilla), Tailwind CSS v4, Angular, Ember, Express, NestJS,
Next.js (webpack + the WebAssembly SWC; the first page compiles for 15-30 s), SvelteKit, React Router 7 and Astro.

Notes: Vite is limited to **Vite 7**; frameworks that start a worker pool with `child_process.fork` may need
`JOBS=1` in the environment; Nuxt does not run yet. `apps/studio` (a VS Code-style IDE built on wcvm) packages
these as project templates, with the working install/start recipes under
`apps/studio/src/services/wcvm/templateProjects/`.

## Troubleshooting

| Symptom | Cause and fix |
|---|---|
| `ERR_NOT_ISOLATED` | The page is not cross-origin isolated. Send both headers from [step 1](#1-serve-a-page-that-can-boot). |
| The preview iframe shows your *host app* (or its "Not Found"), not the guest server | The preview Service Worker is not controlling the page. Check `navigator.serviceWorker.controller` is set; untick DevTools "Bypass for network"; reload normally (not a hard reload); unregister stale workers for the origin. |
| `wcvm preview relay error: ECONNREFUSED` | Nothing listens on that port in *this* tab. Check the server printed its ready line. With several tabs open, another tab may be answering: close the extra ones. |
| `npm install` fails with `Failed to fetch` | A network error reaching the registry; retry. |
| `NoModificationAllowedError` from OPFS in the console | A writer still holds a file (often two tabs on one origin, or a log being rewritten while its folder is removed). wcvm retries deletes; keep one tab per project. |
| `npm run dev` hangs forever with a worker pool | Set `JOBS=1` in `env`. |
| A hydration warning mentioning an unknown `data-*` attribute | A browser extension is rewriting the page before React loads. Try a clean profile. |
| A CORS error for `registry.npmjs.org/-/package/next/dist-tags` | Next's dev overlay checks for a newer version from the page; harmless. |

## Limitations

wcvm vendors Node's own JavaScript but replaces everything native:

- No native add-ons (`.node` files); WebAssembly builds work (esbuild-wasm, SWC, Rolldown's browser build).
- `crypto` is hashing, `randomBytes` and `randomUUID` only; `zlib` has no Brotli or Zstd; DNS is a fixed-address shim;
  there is no real network (sandbox `net`/`http` talk to other sandbox processes; only `npm`/`fs.fetch` reach the internet).
- `npm` is minimal (see [step 5](#5-install-packages)); there is no real `npm`, `pnpm` or `yarn`.
- V8 internals with no JavaScript equivalent (Promise state, Proxy details) are approximated.

The roadmap and the full list of deliberate differences from Node are in
[`PLAN.md`](https://github.com/duyduc-dev/wcvm/blob/main/PLAN.md).

<!-- architecture:start (generated from ARCHITECTURE.md by scripts/render-architecture.mjs; edit ARCHITECTURE.md) -->
## Architecture

How wcvm is built: which threads exist, how they talk, and why. The same text, with the diagrams as editable
Mermaid source, is [`ARCHITECTURE.md`](https://github.com/duyduc-dev/wcvm/blob/main/ARCHITECTURE.md); the roadmap is [`PLAN.md`](https://github.com/duyduc-dev/wcvm/blob/main/PLAN.md) and the
history behind each decision is [`HISTORY.md`](https://github.com/duyduc-dev/wcvm/blob/main/HISTORY.md).

### 1. The problem and the idea

A browser tab cannot spawn processes, has no synchronous filesystem, and never lets the main thread block. Node
programs expect all three. wcvm's answer:

1. **A process is a Web Worker.** One worker per PID, with its own memory and its own event loop.
2. **A blocked call is `Atomics.wait`.** Guest code calls `readFileSync`; the worker writes a request into a
   `SharedArrayBuffer` and parks. Another worker answers into the same buffer and wakes it. This is the one trick
   everything else rests on (and why the page must be cross-origin isolated).
3. **Node's own JavaScript is the runtime.** Node's `lib/` is vendored unmodified; wcvm supplies only what is native
   in real Node (the `internalBinding` layer, an event loop, a module loader).
4. **The network is virtual.** `net`/`http` talk to other sandbox processes through the kernel; a Service Worker lets an
   `<iframe>` reach a sandbox server.

### 2. System overview

![System overview: host page, kernel, file system, process, fetcher and preview workers](https://raw.githubusercontent.com/duyduc-dev/wcvm/main/assets/architecture/01-system-overview.svg)

| Thread | Source | Responsibility |
|---|---|---|
| Host page | `src/boot.ts`, `src/apis/`, `src/bridges/` | The public API; turns calls into messages to the kernel and events back into streams. |
| Kernel Worker | `src/workers/kernel/`, `src/kernel/` | Owns the process table, the virtual network, preview relay, the fetcher, and a *blocking* fs client of its own. |
| File System Worker | `src/workers/fs/`, `src/fs/` | The only owner of the `Vfs`; services every filesystem syscall; mirrors to OPFS. |
| Process Worker (per PID) | `src/workers/process/`, `src/programs/`, `src/runtime/` | Runs one program (`echo`, `sh`, `npm`, `node`, ...). `node` hosts the vendored Node runtime. |
| Fetcher Worker | `src/workers/fetcher/` | Real `fetch()` calls (up to ~10 at once), streamed straight into the VFS. |
| Preview Service Worker | `src/workers/preview/` | Intercepts `/__wcvm_preview__/<port>/...` and relays it to a sandbox server. |

### 3. Boot

![Boot sequence between the host page, the kernel worker, the file system worker and OPFS](https://raw.githubusercontent.com/duyduc-dev/wcvm/main/assets/architecture/02-boot.svg)

`boot()` itself is synchronous: it subscribes to `ready` first, then posts `boot`, so the message cannot be missed.

### 4. The synchronous syscall bridge

This is the core mechanism (`src/protocols/syscall.ts`, `src/fs/fsClient.ts`).

![A synchronous syscall: the guest writes a request into a SharedArrayBuffer and waits; the servicer answers and wakes it](https://raw.githubusercontent.com/duyduc-dev/wcvm/main/assets/architecture/03-syscall-bridge.svg)

One buffer per client, laid out as a 24-byte control block (`STATE`, `OPCODE`, `REQ_LEN`, `RES_LEN`, `SIGNAL`, padding) followed by a
**1 MiB data window**. A request is `[flags][fieldCount]( [len][bytes] )*`; an error response carries the errno string.

Rules that follow from it:

- **Everything must fit the window.** Larger reads/writes are chunked by the client (`fs/fsClient.ts`); an oversize
  request throws `EMSGSIZE`.
- **Each process gets two buffers.** The first goes to the FS Worker (opcodes `OP_READ_FILE` ... `OP_CP`). The second goes
  to the *Kernel Worker* (opcodes `>= 64`: `spawnSync`, `net.listen`, `zlib` sync, `udp.bind`), because process supervision
  lives there.
- **Out-of-band events never use the buffer.** stdout, stderr, exit and incoming network data are `postMessage`s: a
  parked worker cannot receive messages, so the buffer is only for calls the guest is *waiting* on.
- **The kernel must not `Atomics.wait` before its nested workers report ready**, or it deadlocks them.
- `protocols/syscall.ts` must stay dependency-free and use erasable TypeScript only, so it can be imported as-is by Node
  `worker_threads` in tests.

### 5. Processes

![How wc.spawn resolves a program: builtins, sh, npm and node](https://raw.githubusercontent.com/duyduc-dev/wcvm/main/assets/architecture/04-processes.svg)

- **Streams.** stdout/stderr are `postMessage`d to the kernel and on to the host (or, for a `child_process` child, to the parent's
  worker). stdin is open until closed and is delivered the same way (`writeStdin` / `endStdin`).
- **A shell runs its commands in-process.** `sh`, `npm run` and `node` called from them execute inside the *same* worker. That is
  why there is no `SIGINT`: interrupting one would leave its listeners and globals behind in the shell's worker. Killing a
  process is terminating its worker.
- **`child_process`** starts a real *new* Process Worker, supervised by the kernel through `parentPid`; `fork()` adds an IPC
  channel. **Killing or exiting a process kills its whole subtree**, since a child has no parent left to answer to.
- **Ordering on kill:** terminate the worker *before* detaching its fs client; the fs server closes a client's open fds when
  it is unregistered, and the other order leaks them.
- `worker_threads` run over real `MessageChannel`s; the kernel mints thread ids.

### 6. The Node runtime (`src/runtime/`)

![The Node runtime: Node's vendored lib/ on top of wcvm's bindings, shims, event loop and loaders](https://raw.githubusercontent.com/duyduc-dev/wcvm/main/assets/architecture/05-runtime.svg)

**Path B: vendor, don't reimplement.** `src/runtime/node/lib/**` is generated by `scripts/vendor-node-lib.mjs` from
`node/manifest.json` and pinned by `vendor.lock.json` (sha256 per file, re-checked by a test). Because it *is* Node's code,
behaviour and error messages match Node's; the work is in the bindings, which must return Node's exact values and error
codes. Only a module that is C++ or a C++ parser (`internal/url`, `internal/encoding`, `internal/blob`, ...) is hand-written
(`shims.ts`).

**Module loading.**
- *CommonJS* (`cjs.ts`): `node_modules` and `package.json` `main`/`exports` resolution (including `PATTERN_KEY_COMPARE`), JSON,
  cycles.
- *ESM* (`esm/`): the loader resolves the static import graph itself with Node's algorithm, parses each module with Node's
  vendored acorn, **rewrites specifiers to `blob:` URLs**, and lets the browser's own `import()` link and run them - so live
  bindings, top-level `await` and circular-import semantics are real. A strongly-connected component of the graph (a cycle)
  is merged into getter-based bindings (`esm/cyclic.ts`) because a Blob's content is fixed at creation. `import.meta` is rewritten
  to the module's real `file://` URL.
- *`require(esm)`* (`esm/syncRequire.ts`): like Node 24, an ES module can be `require`d synchronously; it is rewritten into a
  function body over a synchronous import, and top-level `await` raises `ERR_REQUIRE_ASYNC_MODULE`.

**The event loop** (`eventLoop.ts`) models libuv's phases and reference counting: a handle that is ref'd keeps the process
alive, and the loop only exits after microtasks drain and it confirms idleness. Native work (fs callbacks, sockets) re-enters it
through `loop.post()`.

### 7. The virtual network and preview

`net`, `dgram` and `http` are Node's real modules over bindings that route through the kernel (`kernel/netServer.ts`):
`listen()` registers a virtual port, `connect()` creates an in-kernel connection, data flows by `postMessage`. `http` adds a hand-written
HTTP/1.1 wire parser (`runtime/bindings/httpParser.ts`) in place of llhttp. There is no real network: sandbox processes only reach each
other.

![A preview request from the iframe through the Service Worker and host page to a guest server](https://raw.githubusercontent.com/duyduc-dev/wcvm/main/assets/architecture/06-preview-relay.svg)

Why it is shaped this way:

- **A Service Worker cannot talk to a dedicated Worker**, only to a window client, so it relays through the host page.
- **Which tab?** One Service Worker serves every tab of the origin, and a navigation carries no hint of its embedder. With several
  wcvm pages open the worker asks each (`wcvm:previewProbe`) whether it has a server on that port, then prefers the focused, then
  visible one. This is a heuristic when two tabs listen on the *same* port.
- **Claiming.** A worker claims pages only when it first activates, so `enable()` sends `wcvm:previewClaim` to claim a page that
  loaded uncontrolled (hard reload, "Bypass for network").
- **Absolute paths.** A page at `/__wcvm_preview__/5173/` asking for `/src/main.ts` would escape the prefix. The worker records which
  clients are previewed documents and **redirects** (307) their un-prefixed same-origin requests into the prefix, so each resource has
  exactly one URL.
- **COEP.** The host page is `require-corp`, so an iframe's own response must also declare COEP; the worker adds it to every response.
- **WebSockets** never reach a Service Worker. A small shim injected into each previewed HTML document hands the host a `MessagePort`;
  the kernel's tunnel (`kernel/previewWebSocket.ts`) is a real RFC 6455 client to the guest's `upgrade` handler. This is what makes Vite's
  HMR work.

### 8. Filesystem and persistence

![The file system worker, the Vfs, and the ordered write-behind mirror to OPFS](https://raw.githubusercontent.com/duyduc-dev/wcvm/main/assets/architecture/07-filesystem.svg)

- **One owner.** Only the FS Worker touches the `Vfs`, so there are no locks: syscalls are served one at a time.
- **Watching.** `fs.watch` receives real push events from the `Vfs` (and `watchFile` polls). One logical save reports one change event.
- **Persistence is write-behind.** A syscall answers before its OPFS write finishes. The queue applies changes **strictly in the
  order they happened** (an unordered mirror let a slow first write land after a fast second one). `wc.fs.sync()` is the matching
  completion signal, because write-behind is only safe if callers can ask "are you done".
- **Restore before mirror.** Restoring recreates the tree through `Vfs` mutations; if the mirror were already listening it would write it
  all straight back.
- **Lazy restore** (`lazyDepth`) restores directory structure first and each project subtree the first time a path under it is touched.
- **Symlinks** live in a side manifest, since OPFS has none. Deleting a locked entry is retried briefly.

### 9. Package manager and fetching

`npm install` (`src/programs/npm/`) resolves versions with its own semver, reads packuments from the registry, and downloads tarballs through
`wc.fs.fetch` into the VFS (on the Fetcher Worker, so the bytes never pass through the main thread), then unpacks them. It is deliberately not
real npm: no lockfile, no lifecycle scripts, no workspaces. Real npm was investigated and deferred because its fetch stack has no path to a real
network from inside the virtual `net`.

### 10. Studio (`apps/studio`)

Studio is a client of the public API, not part of the library:

![Studio's layering on top of the wcvm API](https://raw.githubusercontent.com/duyduc-dev/wcvm/main/assets/architecture/08-studio.svg)

Project templates are *recipes*: the files, the pinned versions that make a framework run here (Vite 7, WebAssembly builds of esbuild/rollup),
and any step a skipped `postinstall` would have done. The first install of a template is cached as a clone inside the VFS, so later projects are
created with one `fs.cp`.

### 11. Invariants and gotchas that shaped the code

| Rule | Why |
|---|---|
| Never edit `runtime/node/lib/**` | It is generated from Node's source and checksum-verified. Fix the binding instead. |
| Test worker/SAB/`eval` changes in real Chromium | Node accepts things browsers reject (e.g. `TextDecoder.decode` on a `SharedArrayBuffer` view). |
| A binding never calls a global (`queueMicrotask`, `setTimeout`) by bare name | `globalObject: self` puts Node's same-named wrappers on the real global; capture the native function at import time or it recurses. |
| Dispatch anything that can reach guest code with `loop.post()` | A synchronous `process.exit()` thrown from a raw platform event escapes the runtime's uncaught-exception handling. |
| `Buffer#slice` returns a view | Copy with `copyBytes` where a copy is meant. |
| Files loaded directly by Node (worker fixtures, scripts) use erasable TypeScript | No enums or parameter properties. |
| When skipping part of Node's bootstrap, re-read the *whole* skipped function | The fd-open call was skipped for `fork()`, and the `ref()`/`unref()` wiring next to it was lost with it. |
| `net.TCP.port` is not "is this the server" | An accepted connection also carries the server's port; use an explicit listening flag. |
| Ref the loop on the operation that *starts* async work | A `connect()` that is not ref'd until it succeeds lets the process exit first. |

### 12. Where to change things

| To... | Do this |
|---|---|
| Add a Node built-in module | Name it in `runtime/node/manifest.json`, run `node scripts/vendor-node-lib.mjs` (or `scripts/discover-node-lib.mjs <id>` to find missing bindings). Implement missing binding members with Node's exact semantics and return codes in `runtime/bindings/`. |
| Add a built-in command | A function in `src/programs/`, registered in `programs/builtins.ts`. Use a getter for any entry that can reference its own registry (`sh`). |
| Add a filesystem syscall | An opcode in `protocols/syscall.ts`, the server handler in `fs/FsServer.ts`, the client call in `fs/fsClient.ts`, and a binding in `runtime/bindings/fs.ts`. Keep the request inside the 1 MiB window. |
| Add a kernel-side syscall | An opcode `>= KERNEL_OPCODE_MIN`, served in `kernel/kernelSyncServer.ts`. |
| Add a framework template | A recipe under `apps/studio/src/services/wcvm/templateProjects/`, verified by an opt-in Playwright case (`WCVM_E2E_VITE=1`). Bump `CACHE_SCHEMA_VERSION` if a cached clone could go stale. |

### 13. Repository map

```
packages/core/            the published `wcvm` library
  src/boot.ts, apis/      public API (boot, spawn, fs, preview)
  src/bridges/            host <-> kernel messaging
  src/kernel/             process table, virtual network, preview relay, sync servers, fetcher host
  src/fs/                 Vfs, FsServer, fsClient, OPFS persistence
  src/protocols/          the syscall ABI, preview and diagnostics protocols (dependency-free)
  src/programs/           echo/cat/.../sh/npm/node
  src/runtime/            the Node runtime (bindings, loaders, event loop, vendored lib)
  src/workers/            entry points: kernel, fs, process, fetcher, preview
apps/studio/              the in-browser IDE built on wcvm
examples/playground/      demo and the Playwright end-to-end suite (real Chromium)
```

<!-- architecture:end -->

## Development

```bash
pnpm install
pnpm --filter wcvm test          # Vitest (use Node 24)
pnpm build                       # builds packages/core (tsup) and the apps
pnpm --filter playground e2e     # real Chromium
```

How it is built - the workers, the synchronous syscall bridge, the Node runtime, the preview relay - is in
[`ARCHITECTURE.md`](https://github.com/duyduc-dev/wcvm/blob/main/ARCHITECTURE.md). Read [`CLAUDE.md`](https://github.com/duyduc-dev/wcvm/blob/main/CLAUDE.md) and
[`AGENTS.md`](https://github.com/duyduc-dev/wcvm/blob/main/AGENTS.md) before changing the runtime.

## License

[ISC](LICENSE). The bundled Node.js runtime sources are MIT licensed; see
[`THIRD_PARTY_NOTICES.md`](THIRD_PARTY_NOTICES.md).

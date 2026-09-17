# duckwc

A WebContainer-style sandbox that runs in the browser: a virtual filesystem, a
shell, real `node`/`npm` execution against the live npm registry, and live
preview of servers started inside it — all in Web Workers, no backend
required. Inspired by [StackBlitz WebContainers](https://webcontainers.io/).

## Install

```bash
npm install duckwc
```

## Quick start

```ts
import { bootWC } from "duckwc";

// No `await` needed — bootWC() returns real, immediately usable handles.
// Every call queues behind the kernel worker's boot handshake internally.
const dwc = bootWC();

await dwc.fs.mkdir("/project", { recursive: true });
await dwc.fs.writeFile("/project/hello.txt", "hello world");
await dwc.fs.readFile("/project/hello.txt"); // Uint8Array

const result = await dwc.shell.exec("cd /project && pwd");
// { output: "/project\n", cwd: "/project" }
```

`await bootWC()` still works too — `await` on a plain object that isn't a
Promise just resolves to it on the next microtask, so nothing breaks if you
were relying on the old call shape. Use `await dwc.ready` if you want to know
boot succeeded (or catch why it didn't) without making an actual call.

## Filesystem — `dwc.fs`

```ts
mkdir(path, { recursive? })
writeFile(path, contents: string | Uint8Array)
readFile(path): Promise<Uint8Array>
readdir(path): Promise<string[]>
stat(path) / lstat(path): Promise<StatResult>   // isFile()/isDirectory()/isSymbolicLink()/size/mode/mtimeMs
chmod(path, mode)
symlink(target, path) / readlink(path) / realpath(path)
rm(path, { recursive? })
rename(from, to)
exists(path): Promise<boolean>
mount(tree: FileSystemTree, basePath?)   // seed a directory tree in one call
```

All calls are promise-based and throw `FSError` (`.code` — `ENOENT`,
`EEXIST`, `ENOTDIR`, `EISDIR`, `ENOTEMPTY`, `EINVAL` — and `.path`) on
failure.

## Processes — `dwc.process`

```ts
const proc = await dwc.process.spawn("/project/server.js", {
  argv: [],
  env: {},
  cwd: "/project",
});

proc.stdout; // ReadableStream<Uint8Array>
proc.stderr; // ReadableStream<Uint8Array>
proc.stdin; // WritableStream<Uint8Array>
const exitCode = await proc.exit; // Promise<number>
proc.kill(); // resolves exit with 143, same as a killed child_process child
```

Runs a script (a real file path already on the virtual filesystem) as its
own guest process — a fresh CommonJS/ESM module graph, event loop, and
`require()` with real Node builtins (see below). Use this for anything
long-running (a server); for a one-shot command, `dwc.shell.exec()` is
simpler.

## Shell — `dwc.shell`

```ts
const result = await dwc.shell.exec("mkdir -p /project && cd /project");
// { output: string, cwd: string }
```

`exec(line, { cwd? })` runs to completion and resolves with the combined
stdout+stderr text and the shell's final working directory. Supports `&&`
chaining (stops at the first non-zero exit) and `>`/`>>` redirection. The
underlying exit code isn't exposed through this call — inspect `output` if a
command might fail, or use `dwc.process.spawn()` for anything where you need
the real exit code back.

Built-in commands: `pwd`, `cd`, `ls`, `cat`, `mkdir [-p]`, `echo`, `rm [-r]`,
`mv`, `true`, `false`. `node <script>` runs a script the same way
`dwc.process.spawn()` does; any other command resolves against `/bin/<name>.js`
on the virtual filesystem (which is how `npm`/`npx` become runnable — see
below).

**Needs [cross-origin isolation](#cross-origin-isolation)** — the shell runs
as a real guest process internally and depends on the same synchronous
bridges `fs.*Sync`/`child_process.execFileSync` do.

## `require()` inside guest scripts

Guest code (anything run via `dwc.process.spawn()`, `node <script>` in the
shell, or `npm install`'s own dependency tree) gets a real CommonJS loader
*and* real native ES module support (genuine `import()`/live bindings/
top-level await for a `.mjs` file or a package with `"type": "module"`), with
`require()`/`import` resolving:

- **Real vendored Node source**: `stream`, `buffer`, `events`, `http`,
  `https`, `http2`, `crypto`, `zlib`, `net`, `dns`, `tls`, `async_hooks`
- **Hand-written, spec-accurate**: `fs` / `fs/promises`, `path`, `util`
  (including `promisify`, `styleText`, `parseEnv`), `os`, `url`,
  `querystring`, `string_decoder`, `timers/promises`, `module`
  (`createRequire`, `builtinModules`), `assert`, `readline`, `perf_hooks`
  (`performance.now()`), `constants`, `v8`, `tty`
- **`child_process`**: `spawn`/`exec`/`execFile` (async) and a genuinely
  synchronous `execFileSync` (a `SharedArrayBuffer`/`Atomics` bridge, needs
  [cross-origin isolation](#cross-origin-isolation)); `spawnSync`/`execSync`
  are not implemented
- **`vm`**: only `runInThisContext()` (real Node semantics: shares the
  caller's own global scope) — `runInNewContext`/`createContext`/`Script`
  are not implemented (no way to fake real V8 context isolation in
  userland JS)
- **`worker_threads`**: real `MessageChannel`/`MessagePort` (native Web
  API, with Node's `.ref()`/`.unref()` added as no-ops) — `new Worker(...)`
  throws a clear "not implemented" error rather than faking in-VM
  thread execution
- **Not implemented**: `cluster`, `dgram`, `wasi`

`npm install`/`npm install <pkg>` inside a guest process resolves real
packages from `registry.npmjs.org` (full semver ranges, real tarball
extraction, real integrity checks) into `node_modules` on the virtual
filesystem — this is genuinely how a real, unmodified npm CLI itself runs
inside the sandbox (see `examples/playground` for vendoring one). See
[`PROGRESS.md`](../../PROGRESS.md) at the repo root for exactly what's been
verified working against real npm packages, and what the current known gaps
are (real Vite's own bundler currently needs a native binary this sandbox
can't load — in progress).

## Preview

A guest `node` process that calls `server.listen(port)` doesn't open a real
TCP socket — the kernel just remembers which guest Worker owns that port and
emits a `listen` event:

```ts
dwc.addEventListener("listen", ({ port }) => {
  console.log(`server listening on ${port}`);
});
```

From there you have two ways to actually talk to it:

### Direct fetch

```ts
const res = await dwc.preview.fetch(port, "/", { method: "GET" });
// { status, headers, body, bodyEncoding: "utf8" | "base64" }
```

Good for polling/testing that a server inside the container is responding.
Bodies are fully buffered (no streaming) and, currently, always `utf8` — the
guest `http` shim doesn't produce binary/base64 responses yet, so serving
binary assets (images, fonts, wasm) through preview isn't supported.

### Live `<iframe>` preview

```ts
await dwc.preview.enable({ swUrl: "/dwc-preview-sw.js" });
iframe.src = dwc.preview.url(port); // "/__dwc_preview__/<port>/"
```

This registers a Service Worker that intercepts the iframe's traffic —
including a real dev server's root-absolute asset requests (`/style.css`,
`/@vite/client`, etc., which arrive with no prefix at all) — and relays it
through `dwc.preview.fetch()` under the hood.

Two things this requires that can't be automated by the library:

1. **You must serve the Service Worker script yourself**, at (or above) the
   scope you pass to `enable()`. `navigator.serviceWorker.register()` only
   accepts a same-origin URL — there's no bundler magic (unlike the
   `new Worker(new URL(...))` calls this package uses internally) that can
   make a `node_modules` file reachable at a stable public URL for this.
   Resolve the built file via the `duckwc/preview-sw` export and copy it
   into wherever your app serves static assets from its origin root (see
   `examples/playground/scripts/copy-preview-sw.mjs` for a working example
   with Vite).
2. **If it isn't served from the actual origin root**, the response needs a
   `Service-Worker-Allowed: /` header, or the browser caps the Service
   Worker's max scope to the script's own directory and preview requests
   outside that directory silently stop being intercepted.

**No real origin isolation.** Preview content runs on your app's own origin,
so it isn't isolated from your host page's cookies/storage the way a real
sandboxed subdomain would be. Wrapping the iframe in
`sandbox="allow-scripts"` without `allow-same-origin` doesn't help either —
that gives the iframe an opaque origin, and an opaque origin can't be
controlled by a same-origin Service Worker at all, so preview would just stop
working. If you need genuine isolation, that requires owning a domain with
wildcard DNS and an edge worker to serve each preview from its own origin —
out of scope for a client-only library like this one.

## Cross-origin isolation

The synchronous bridges (`fs.*Sync`, `dwc.shell.exec()`,
`child_process.execFileSync`) need `SharedArrayBuffer`, which browsers only
expose on a page served with:

```
Cross-Origin-Opener-Policy: same-origin
Cross-Origin-Embedder-Policy: require-corp
```

Without these headers the library still works — `fs`/`process`/`preview`
fall back to a slower static-preload path — just without the sync bridges.

## Events

`dwc.addEventListener(type, handler)` returns an unsubscribe function.
Currently emits:

- `"listen"` — `{ port }`, when a guest process starts listening on a port.

## Diagnostics

`dwc.diagnostics.onEvent(handler)` subscribes to every request/reply/event
crossing the kernel bridge (useful for debugging) — it replays recent
history to a late subscriber, so you won't miss anything that happened
before you attached.

## Known limitations

- Guest `http` responses are fully buffered and text-only (no streaming, no
  binary bodies).
- `dwc.preview.enable()` assumes a single top-level host page relaying for a
  single sandbox instance.
- `npm install` fetches directly from `registry.npmjs.org` over the network —
  no offline mode or local cache.
- No native-binary execution of any kind (no `esbuild`/`node-gyp`-built
  addons, no WASI yet) — real Vite's own bundler currently hits exactly
  this wall; see `PROGRESS.md` for the current state of working around it.

See [`PROGRESS.md`](../../PROGRESS.md) at the repo root for the full,
up-to-date build log.

## Development of this repo

The steps above are for *using* the published `duckwc` package in your
own app. If you're working on this library itself (or its demo playground):

```bash
git clone <this repository>
cd duck-webcontainer-api
pnpm install         # requires Node 22+ and pnpm (packageManager-pinned - corepack enable)

cd examples/playground
pnpm dev              # vendors a real npm CLI into the sandbox on first run, then starts Vite
```

Then, from `packages/core`:

```bash
pnpm build            # tsup
pnpm dev               # tsup --watch
pnpm test               # vitest run
npx tsc --noEmit -p tsconfig.json
```

`examples/playground`'s own `vite.config.ts` already sets the
cross-origin-isolation headers described above for its dev/preview server,
and its `predev`/`prebuild` scripts vendor a real npm CLI + copy the built
preview Service Worker automatically - see
`examples/playground/scripts/vendor-npm.mjs` and
`examples/playground/scripts/copy-preview-sw.mjs`.

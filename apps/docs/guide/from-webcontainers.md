# Migrating from WebContainers

wcvm and [WebContainers](https://webcontainers.io) solve the same problem, Node.js in a browser tab, and the APIs have the same shape: **boot**, **mount** a file tree, **spawn** processes, show a **preview**. They are separate projects with separate runtimes. wcvm is open source (ISC) and its runtime is Node v24's own `lib/` running on a native layer written for the browser.

This page maps the WebContainers calls you know to their wcvm equivalent, and lists what is different. It compares the public guides and API as documented at webcontainers.io; check their documentation for anything that has changed since.

## At a glance

| | WebContainers | wcvm |
|---|---|---|
| Package | `@webcontainer/api` | `wcvm` |
| Start | `await WebContainer.boot()` | `const wc = boot(); await wc.ready` |
| Load files | `mount(tree, { mountPoint })` | `fs.mount(tree, basePath)` |
| Run a command | `spawn(cmd, args, opts)` | `spawn(cmd, args, opts)` |
| Server up | `on("server-ready", (port, url) => ...)` | `preview.onListen(({ port, listening }) => ...)` and `preview.url(port)` |
| Output | one `output` stream of strings | separate `stdout` and `stderr` streams of bytes |
| Stop | `process.kill()`, `teardown()` | `proc.kill()`, no `teardown()` |

## Booting

```ts
// WebContainers
const wc = await WebContainer.boot();

// wcvm
const wc = boot();      // synchronous
await wc.ready;         // optional: resolves when the kernel is up
```

Like WebContainers, call it **once per page**. Both need [cross-origin isolation](/guide/headers) (`COOP: same-origin`, `COEP: require-corp`) and a secure context.

## Mounting files

The tree format is the same: `{ file: { contents } }`, `{ directory }`, and symlinks.

```ts
// WebContainers
await wc.mount(tree, { mountPoint: "app" });

// wcvm
await wc.fs.mount(tree, "/app");
```

- `mount` lives on `wc.fs`, and the destination is a plain absolute path argument.
- The destination is **created if missing**; you do not need to `mkdir` it first.
- WebContainers' binary snapshot format (`@webcontainer/snapshot`) has no equivalent: send a JSON tree (base64 for binary files) or fetch files with `wc.fs.fetch`.

## The file system

| WebContainers | wcvm |
|---|---|
| `fs.readFile(path)` returns `Uint8Array` | Same. |
| `fs.readFile(path, "utf-8")` returns a string | `readFile` returns bytes; decode with `new TextDecoder().decode(bytes)`. |
| `fs.readdir(path)` returns names | Same. |
| `fs.readdir(path, { withFileTypes: true })` | Names only; call `fs.stat(path).kind` for the type. |
| `fs.writeFile(path, data)` | Same (a string or a `Uint8Array`). |
| `fs.mkdir(path, { recursive })` | Same. |
| `fs.rm(path, { recursive, force })` | `fs.rm(path, { recursive })`. |
| `fs.watch(path, ...)` | Not on the host API. See [Watching for changes](/guide/files#watching-for-changes). |
| `export()` | No built-in export; [a short helper](/guide/files#exporting-a-folder-back-to-a-tree) builds the tree. |

wcvm adds `stat`, `lstat`, `rename`, `cp`, `symlink`, `readlink`, `realpath`, `chmod`, `fetch`, `sync` and `reset`. See [Working with the file system](/guide/files).

## Processes

```ts
// WebContainers
const install = await wc.spawn("npm", ["install"]);
install.output.pipeTo(new WritableStream({ write: (data) => term.write(data) }));
if ((await install.exit) !== 0) throw new Error("install failed");

// wcvm
const install = await wc.spawn("npm", ["install"], { cwd: "/app" });
void pump(install.stdout, (text) => term.write(text));      // pump: see "Reading output"
void pump(install.stderr, (text) => term.write(text));
if ((await install.exit).exitCode !== 0) throw new Error("install failed");
```

Differences to expect:

- **`exit`** resolves to an object `{ exitCode, signal?, errorMessage? }`, not a bare number.
- **Output** is two streams of `Uint8Array`, so you decode them and merge them yourself ([`pump` helper](/guide/processes#reading-output)). Output is buffered until read.
- **Input** is `proc.stdin`, a `WritableStream<Uint8Array>`.
- **Working directory.** Pass `cwd` per call. There is no global `workdir` option on `boot`.
- **Shell.** WebContainers ships `jsh`; wcvm ships `sh` (pipes, redirects, `&&`/`||`, `cd`; no `$` expansion, globbing or control flow).
- **`npm` is a small built-in, not real npm**: no lockfile, no lifecycle scripts, no workspaces. `pnpm` and `yarn` are not provided. See [npm](/guide/processes#npm).
- **No `SIGINT`.** Ctrl+C in a terminal means "restart the shell".

## Server-ready and the preview

```ts
// WebContainers
wc.on("server-ready", (port, url) => { iframe.src = url; });

// wcvm
await wc.preview.enable();
wc.preview.onListen(({ port, listening }) => {
  if (listening) iframe.src = wc.preview.url(port);       // "/__wcvm_preview__/<port>/"
});
```

- The preview URL is a **same-origin path** served by a Service Worker, not a separate origin, so it needs the [Service Worker header](/guide/headers#the-preview-service-worker) and a base path for client-side routers ([Preview a dev server](/guide/preview)).
- `onListen` also fires when a server **stops** (`listening: false`), and for every port, not just the first.
- There is no separate `port` or `error` event; use `onListen` and the process's `stderr` and `exit`.
- `wc.diagnostics.onEvent` exposes kernel events for debugging boot problems.

## What wcvm adds

- **Persistence.** `boot({ persist })` mirrors the filesystem to the browser's OPFS, with lazy restore for many projects and an `exclude` list (`["node_modules"]`). See [Persistence](/guide/files#persistence).
- **Open source.** The runtime, the kernel and the vendored Node `lib/` are all in the repository, so you can read, debug and patch it.
- **Studio.** A complete editor, terminal and preview built on the same API: [studio.wcvmjs.com](https://studio.wcvmjs.com).

## What to check before you switch

1. **Your packages.** wcvm swaps native binaries for WebAssembly builds ([Frameworks](/guide/frameworks)). Anything with a native add-on that has no WebAssembly build will not load.
2. **Your install step.** If a dependency relies on `postinstall`, do that step yourself after `npm install`.
3. **Your terminal.** Output is bytes in two streams and there is no pty: the terminal does line editing. [Connecting a terminal](/guide/processes#connecting-a-terminal) has a working starting point.
4. **Your hosting.** The isolation headers are the same, but the preview also wants `Service-Worker-Allowed: /` on the worker script when it is served from a nested path.
5. **Your browsers.** See [Browser support](/guide/browser-support).

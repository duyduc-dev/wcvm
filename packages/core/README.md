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

## Contents

1. [Install](#install) · 2. [Serve a page that can boot](#1-serve-a-page-that-can-boot) ·
3. [Boot and run a command](#2-boot-and-run-a-command) · 4. [Files](#3-work-with-files) ·
5. [Streams, stdin and a terminal](#4-stream-output-and-send-input) · 6. [Install packages](#5-install-packages) ·
7. [Run a dev server and preview it](#6-run-a-dev-server-and-preview-it) · 8. [Keep a project across reloads](#7-keep-a-project-across-reloads) ·
9. [Stop things](#8-stop-things) · [API summary](#api-summary) · [Frameworks](#frameworks-that-run) ·
[Troubleshooting](#troubleshooting) · [Limitations](#limitations)

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

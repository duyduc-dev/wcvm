# Limitations

wcvm vendors Node's own JavaScript but replaces everything native, so some things differ or are missing. The roadmap and the full list of deliberate differences are in [`PLAN.md`](https://github.com/duyduc-dev/wcvm/blob/main/PLAN.md).

## What works

`fs` (sync, callback, promises, streams, `watch`, `glob`), `stream`, `events`, `buffer`, `util`, `timers`, `readline`, `url`, `tty`, `perf_hooks`, `path`, `assert`, `querystring`, `module`, `os`, `child_process` (`spawn`, `exec`, `execFile`, `execSync`, `spawnSync`, `fork` with IPC), `net` (real TCP over a virtual network), `http`, `dgram` (UDP), `zlib`, `crypto` (hashing), `worker_threads`, CommonJS, ESM, `require(esm)`, `import.meta`, and an interactive REPL.

## What differs or is missing

- **Native add-ons.** `.node` files cannot load. WebAssembly builds work (esbuild-wasm, SWC, Rolldown's browser build).
- **`crypto`** is hashing, `randomBytes` and `randomUUID` only.
- **`zlib`** has no Brotli or Zstd.
- **DNS** is a fixed-address shim; there is no real name resolution.
- **No real network.** Sandbox `net` and `http` talk to other sandbox processes. Only the built-in `npm` and `wc.fs.fetch` reach the internet.
- **`npm` is minimal.** No lockfile, no lifecycle scripts, no workspaces, no real `npm`, `pnpm` or `yarn`.
- **`AsyncLocalStorage`** is a plain-JavaScript implementation that keeps one current value per instance, so concurrent requests that rely on it share state.
- **`vm` contexts** are emulated: no `instanceof` isolation across contexts.
- **V8 internals** with no JavaScript equivalent (Promise state, Proxy details, Map and Set iterator previews) are approximated.
- **Signals.** There is no `SIGINT`; `kill()` is `SIGTERM` or `SIGKILL`.
- **`detached` children** are accepted but not honored: a child always dies with its parent.

## Known runtime gaps

- **Worker deadlocks with WASI.** A napi-rs WebAssembly package that spawns a WASI worker whose file reads relay back to the thread that is blocked waiting on it can deadlock. This is why Nuxt (`oxc-parser`) does not run, and why Tailwind v4's scanner and Angular's parser needed workarounds.
- **`child_process.fork` worker pools** may hang; set `JOBS=1` where a tool supports it.
- **Vite 8** needs Rolldown, which has no WebAssembly build here. Stay on Vite 7.

## Requirements

- A cross-origin isolated page (`SharedArrayBuffer`).
- A Content-Security-Policy that allows `blob:` workers.
- A browser with OPFS support if you use `persist`.
- Node 24 for developing wcvm itself (the unit tests rely on `URLPattern` and `CloseEvent`).

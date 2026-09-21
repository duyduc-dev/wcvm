# wcvm implementation plan

Reference design: `~/workspace/duck/vivari` (MIT). See its `ARCHITECTURE.md`.
`PROGRESS.md` describes the OLD `duckwc` implementation, which no longer exists
in this tree; treat it as history.

## Current state

- `boot()` throws `ERR_NOT_ISOLATED` unless cross-origin isolated, creates one
  kernel worker, returns `{ spawn, diagnostics }`.
- Kernel worker: router with `boot` and `process:spawn` only. `process:spawn`
  is a stub that immediately posts `process:exit` code 0.
- `IKernelHost` is empty. No tests. Nothing consumes the `ready` message yet.
- Docs (`README`, `AGENTS`, `packages/core/README`) still say `duckwc`/`bootWC`.

## Architecture to build (from vivari)

- One SAB per process worker: 16-byte control (`STATE`, `OPCODE`, `REQ_LEN`,
  `RES_LEN`) + 1 MiB data window. Worker writes a request and parks on
  `Atomics.wait`; a servicer answers and `Atomics.notify`s. This is what makes
  sync `fs` / `execSync` possible.
- Request frame: `[flags:u32][fieldCount:u32]([len:u32][bytes])*`. Errors are a
  UTF-8 errno string (`ENOENT`, ...).
- Everything must fit the 1 MiB window: chunk large fs I/O (512 KiB); downloads
  bypass the window by streaming into the VFS.
- Fs opcodes -> File System Worker (owns the VFS). All other opcodes (spawn,
  kill, listen, accept, respond, fetch) -> Kernel worker. Some are deferred
  (caller stays parked until the event arrives).
- Kernel owns the PID table; one worker per process (`Process Worker PID N`);
  killing a process kills its subtree.
- stdout/stderr/exit/fs-watch events go out-of-band via `postMessage`, never
  through the SAB.
- Runtime is testable headless under Node `worker_threads`.

## Phases

Each phase ends with something demonstrable and tested (vitest, beside the
module: `Thing.test.ts`).

### Phase 0 - Housekeeping
- Commit the `boot:exit` -> `ready` rename; expose `ready: Promise<void>` from
  `boot()`, with a boot timeout (`ERR_BOOT_TIMEOUT` already exists).
- Settle the public name; fix or remove stale docs; trim `PROGRESS.md` to an
  archive note and track new work here.
- Confirm the worker URL in `bridges/service.ts` resolves from both `src/`
  (playground) and `dist/`.
- Add tests: router, state, bridge request/reject, diagnostics.

### Phase 1 - Syscall protocol + sync bridge
- `src/protocol/syscall.ts`: layout, states, frame encode/decode, errno errors.
- Client `call(opcode, request)` with the park loop; servicer-side decoder.
- Tests with two `worker_threads`: echo opcode, oversize request throws, error
  response.

### Phase 2 - File system worker + VFS
- `workers/fs` + `FsServer` owning an inode VFS (dirs, files, symlinks, stat,
  rename, fd layer, errno errors). Start with a TS in-memory VFS behind an
  interface; Rust/Wasm + compression can replace it later.
- Public API: `readFile`, `writeFile`, `mkdir`, `readdir`, `rm`, `mount(tree)`.
- Sync fs client for process workers.

### Phase 3 - Real processes (replaces the stub)
- Kernel PID table, `createProcess`, `finalize` (subtree kill).
- `MessageChannel` from each process to the FS worker as its doorbell.
- `spawn()` gets stdout/stderr streams, stdin, `kill()`, real exit code; keep
  the `{ processId, exit }` shape and extend it.
- Minimal built-ins: `echo`, `cat`, `ls`, `pwd`, `mkdir`, `rm`.

### Phase 4 - Node runtime in the process worker
- Sync CommonJS loader (`node_modules` resolution), per-process event loop
  (nextTick, microtasks, timers, setImmediate), builtins: `process`, `fs`,
  `path`, `events`, `buffer`.
- Decision required: vendor Node's real `lib/` + `internalBinding` shims
  (vivari "Path B") vs hand-written builtins. Recommendation: Path B, after
  Phases 1-3 are solid.

### Phase 5 - Shell
- Small `sh`: `;` `&&` `||`, pipes, redirects, `node <file>`. Interactive REPL
  later.

### Phase 6 - Network + preview
- Kernel port registry: `listen`/`accept`/`respond` (chunk large bodies).
- Service Worker relay + iframe preview; `listen` events on the host handle.

### Phase 7 - Fetcher worker, real npm, persistence
- Fetcher worker streaming into the VFS; parallel async fetches capped ~10.
- Real npm CLI, vendored as one packed asset unpacked in a single batched write.
- OPFS mirror (write-behind), restored before serving syscalls.

### Phase 8 - Dev servers
- Vite dev + HMR over a WebSocket tunnel, `fs.watch`, templates.
- Known from old notes: Vite 8/Rolldown hit an upstream Wasm trap; Vite 7 with
  esbuild worked.

Later: Python (Pyodide), Bun shim, debugger, Studio UI.

## First milestone

Phases 0-3: `spawn("echo", ["Hello, World!"])` produces real stdout and exit
code, and a script can `readFileSync` a file the host wrote. This proves
host -> kernel -> process worker -> SAB -> FS worker -> back.

## Open decisions

1. Public name: `wcvm` or `duckwc`.
2. Node runtime: vendored real `lib/` (A) vs hand-written builtins (B).
3. Port vivari JS wholesale vs rewrite in strict TS using it as reference
   (recommended: rewrite; vendor only Rust crates and Node `lib/` later).

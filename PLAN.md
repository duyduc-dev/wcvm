# wcvm implementation plan

Reference design: `~/workspace/duck/vivari` (MIT). See its `ARCHITECTURE.md`.
`PROGRESS.md` describes the OLD `duckwc` implementation, which no longer exists
in this tree; treat it as history.

## Current state

Done: Phases 0-2. `boot()` returns `{ spawn, fs, diagnostics, ready }`; a kernel
worker boots a File System Worker (in-memory `Vfs` behind a syscall server) and
serves `wc.fs.*` (incl. `mount`, files > 1 MiB, errno `code` on errors) over the
SAB protocol. Verified by Vitest and by Playwright in real Chromium.

Not done: `process:spawn` is still a stub that immediately reports exit 0 (Phase 3).

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

### Phase 0 - Housekeeping  (DONE)
- Commit the `boot:exit` -> `ready` rename; expose `ready: Promise<void>` from
  `boot()`, with a boot timeout (`ERR_BOOT_TIMEOUT` already exists).
- Settle the public name; fix or remove stale docs; trim `PROGRESS.md` to an
  archive note and track new work here.
- Confirm the worker URL in `bridges/service.ts` resolves from both `src/`
  (playground) and `dist/`.
- Add tests: router, state, bridge request/reject, diagnostics.

### Phase 1 - Syscall protocol + sync bridge  (DONE)
- `src/protocols/syscall.ts`: layout, states, frame encode/decode, errno errors.
- Client `call(opcode, request)` with the park loop; servicer-side decoder.
- Tests with two `worker_threads`: echo opcode, oversize request throws, error
  response.

### Phase 2 - File system worker + VFS  (DONE)
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

## Lessons learned (keep in mind for later phases)

- Node accepts things browsers reject. `TextDecoder.decode()` throws on a view
  over a SharedArrayBuffer in Chromium but not in Node, so unit tests under
  Node passed while every fs call failed with EIO in the browser. Anything that
  touches shared memory needs a real-browser check: run
  `pnpm --filter playground e2e` (Chromium) before calling a phase done.
- The kernel must not block on `Atomics.wait` before its nested worker has
  reported `ready`; boot awaits the fs worker for this reason.
- `fs`-heavy tests can run on one thread with `testing/loopbackFs.ts` (the
  doorbell services the request synchronously). Cross-thread behavior is
  tested with real `worker_threads` via `testing/spawnFixtureWorker.ts`.

## First milestone

Phases 0-3: `spawn("echo", ["Hello, World!"])` produces real stdout and exit
code, and a script can `readFileSync` a file the host wrote. This proves
host -> kernel -> process worker -> SAB -> FS worker -> back.

## Decisions

1. Public name: `wcvm` (decided).
2. Port vs rewrite: rewrite in strict TS using vivari as reference; vendor only
   Rust crates and Node `lib/` later (decided).
3. OPEN - Node runtime (needed at Phase 4): vendored real `lib/` (A, recommended)
   vs hand-written builtins (B).

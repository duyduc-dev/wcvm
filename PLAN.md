# wcvm implementation plan

Reference design: `~/workspace/duck/vivari` (MIT). See its `ARCHITECTURE.md`.
An older, much larger implementation (`duckwc`) once lived in this repo; it is gone from the
tree but recoverable from git history (see `git show 5e7e388:PROGRESS.md`).

## Current state

Done: Phases 0-5. `boot()` returns `{ spawn, fs, diagnostics, ready }`.
- Kernel worker boots a File System Worker (in-memory `Vfs`) and serves `wc.fs.*`.
- `spawn(command, args, { cwd, env })` runs a command in its own `Process Worker PID N`
  (own SAB + doorbell port to the fs worker) and returns `stdout`/`stderr`/`stdin` streams,
  `exit` and `kill()`. Built-ins: `echo cat ls pwd mkdir rm sleep true false` and **`node`**
  and **`sh`**.
- `sh -c "..."` / `sh script.sh` (`programs/sh/`): `;` `&&` `||` sequencing (short-circuiting,
  exit status is the last pipeline that actually ran), `|` pipes (in-memory, no real OS pipes -
  everything is one worker), `>`/`>>`/`<` file redirects, and `cd` as a shell builtin (mutates
  only this script's own cwd). Runs entirely over the existing built-in registry, including
  `node` and recursively `sh` itself. No `$` expansion, globbing, subshells, or control-flow
  keywords or `&` background jobs - not in scope. `sh` with no `-c`/script is an interactive REPL
  (`runReplSh` in `sh.ts`): reads commands one line at a time off stdin
  (`programs/sh/lineReader.ts` turns an `IStdinHost`'s arbitrary chunk boundaries into whole
  lines), running each through the same `parse`+`runPipeline` machinery as a script file, with
  `cwd` threaded across lines so `cd` persists. A syntax error on one line is reported and the
  session keeps going (unlike a script file, which aborts on its first error). `exit`/`exit N`
  ends the session (bash semantics: no arg keeps the last command's status). No multi-line
  continuation (an open quote or trailing `\` doesn't span lines).
- `stdin` is a real, open pipe (Phase 3's stdin, closed out): open until the host closes it
  or the process exits, delivered out-of-band via `postMessage` (kernel/processes.ts's
  `writeStdin`/`endStdin`), never through the SAB. `process.stdin` only refs the event loop
  while actually flowing (`resume()`/a `'data'` listener), mirroring a real handle's
  readStart/readStop - a script that never touches it can still exit on its own. `cat` with
  no args streams it for real now, too. `child_process`'s `child.stdin` reuses the exact same
  kernel-level plumbing (see below).
- `node script.js [args]` / `node -e code` run Node's real vendored `lib/` (v24.18.0):
  `path events buffer util stream timers console fs os assert readline child_process net dgram`
  + the internals they need, on our own `internalBinding` layer, with a libuv-shaped event loop,
  a real `process`, and a CommonJS loader (node_modules, package.json `main`/`exports`, JSON,
  cycles).
- `fs` (sync, callback, `fs.promises`, streams, `opendir`, FileHandle) and `os` are Node's real
  modules over `bindings/fs.ts`; errors have Node's exact message/errno/code/syscall/path/dest.
- `assert`/`readline`/`readline/promises` are Node's real modules; `assert`'s no-message path
  (`assert(x)`) never shows the literal failing expression (see "Known differences" below).
- `child_process.spawn`/`exec`/`execFile` are Node's real modules: a child is another real
  Process Worker, supervised by the kernel (`kernel/processes.ts`'s `parentPid`) and reached from
  inside a running script via `pipe_wrap`/`process_wrap`/`stream_wrap` bindings
  (`runtime/bindings/childProcess.ts`) instead of real libuv handles. `net`/`dgram` are vendored
  only because `internal/child_process.js` requires them unconditionally (they wrap each stdio
  pipe in a `net.Socket`); real TCP/UDP/DNS are still Phase 6, not supported (`tcp_wrap`/
  `udp_wrap`/`tty_wrap`/`cares_wrap` are inert stubs). `child.stdin.write()`/`.end()` deliver for
  real now (routed parent-worker -> kernel -> child-worker as ordinary `writeStdin`/`endStdin`,
  the same path top-level stdin uses). Killing (or the natural exit of) a process kills its whole
  subtree (`kernel/processes.ts`'s `finalize`'s `cascade` recursion over `childrenOf`): a
  `child_process` has no live parent left to answer to once its ancestor is gone, so it would
  otherwise strand a Process Worker in the tab forever. `detached` is accepted by the vendored
  options but not honoured, so there's no opt-out from this yet. `execSync`/`spawnSync` are also
  Node's real modules now (see below); not done: `fork()`/IPC.
- ESM (`import`/`export`): real ESM, not a CJS transpile - `runtime/esm/` resolves the static
  import graph itself (Node's own resolution algorithm, simplified: no extension guessing or
  directory-index fallback for relative specifiers; `package.json` "exports" with
  `import`/`node`/`default` conditions for bare specifiers, `main`/`index.js` as a fallback only
  when a package has no "exports" at all), rewrites each module's specifiers to `blob:` URLs
  (parsed with Node's own vendored acorn, dependency-first so a module is only blobbed once
  every static dependency already has one), then lets the browser's real dynamic `import()` do
  the actual linking/evaluation - real live bindings, real circular-import semantics (among
  non-cyclic modules), real top-level await, none of it reimplemented. A `node:` builtin or a
  plain CJS file imported from ESM gets a synthetic wrapper module (`export default <value>;`
  plus one `export const <key> = <value>[key];` per enumerable own key, for named-import
  parity); same idea for a `with { type: "json" }` import. Dynamic `import()` calls (literal or
  computed argument) are rewritten to a runtime bridge function that resolves lazily, so they
  have none of static import's limits. Genuinely circular static imports (A statically imports
  B which statically imports A) throw `ERR_CIRCULAR_ESM_NOT_SUPPORTED` instead of silently
  breaking live bindings: a Blob's content is fixed at creation, unlike a real fetchable URL a
  server could answer lazily, so creating A's blob needs B's URL and vice versa - a dynamic
  `import()` breaks the cycle instead, same as it does in real bundled/served ESM. See "Known
  differences" for `import.meta.url`.
- `node` with no script and no `-e` is an interactive REPL (`runtime/repl.ts`), and so is `sh`
  with no `-c`/script (see above). Real Node's own `repl` module isn't vendored - it needs
  raw-mode TTY, ANSI cursor control and tab-completion machinery `tty_wrap` deliberately stubs
  out (see "Known differences" below) - so this is a small loop of our own, built on the
  already-vendored, TTY-independent `readline` (proven to work over a plain non-terminal
  `Readable` by the existing readline test, below). Each line is evaluated with indirect
  `eval()` against the process's own real global object, so declared names persist across lines
  the way Node's own REPL's reused context makes them persist - see "Known differences" for why
  top-level `let`/`const` need a small rewrite to `var` first (`runtime/replTransform.ts`) for
  this to actually work. `.exit` or stdin EOF (Ctrl-D) ends the session; a thrown error prints
  `Uncaught <inspected error>` and the session keeps going, matching Node's real REPL.
- `child_process.execSync`/`spawnSync` are Node's real modules too, backed by a genuinely
  synchronous `spawn_sync` binding (`runtime/bindings/childProcess.ts`'s `createSpawnSyncBinding`)
  - unlike async `spawn()`'s `pipe_wrap`/`process_wrap`, this really blocks the calling Process
  Worker (`Atomics.wait`) until the child has fully exited. It uses a SECOND per-process SAB
  (`OP_SPAWN_SYNC`, `protocols/syscall.ts`) whose servicer runs directly in the Kernel Worker,
  not the FS Worker (`kernel/spawnSyncServer.ts` - process supervision lives in the kernel, a
  different thread from the fs SAB's FS Worker servicer). `kernel/processes.ts`'s `onExit` hook
  buffers the child's whole stdout/stderr (instead of streaming it live to a parent worker or the
  host) and delivers it all at once, when the child exits, alongside its status/signal - real
  `spawnSync` semantics need the complete output atomically, not a stream. The `input` option is
  written to the child's stdin, which is then always ended (no interactive follow-up - matches
  real batch semantics); `timeout` kills the child with SIGTERM via a plain `setTimeout` in the
  kernel (not a virtual event loop - the Kernel Worker doesn't run one). See "Known differences"
  for the two simplifications (output must fit the SAB window; only default `stdio: 'pipe'` is
  honoured). `fork()`/IPC remains not done - see below.
Verified by Vitest (427) and Playwright in real Chromium (61), including a script reading a
file the host wrote and the host reading what the script wrote.

Not done: `child_process.fork` (IPC - needs vendoring `internal/child_process/serialization` and
`NODE_CHANNEL_FD`/`_forkChild` bootstrap wiring; structurally an async IPC problem, not a
blocking one, so it doesn't reuse `spawnSync`'s new SAB channel), real `http`/`net` (TCP/UDP/DNS),
`worker_threads`, `fs.watch`/`watchFile` (ENOSYS), `process.binding`, `node -p`.

### How the Node runtime is put together (src/runtime/)
- `node/lib/**`: Node's own files, VERBATIM, generated by `scripts/vendor-node-lib.mjs` from
  `node/manifest.json`; `node/vendor.lock.json` holds upstream sha256 and a test re-checks it
  offline. Never hand-edit these. Add a module by naming it in the manifest, or run
  `node --import ./src/testing/registerTsResolve.mjs scripts/discover-node-lib.mjs <id...>`
  to add everything it needs automatically.
- `primordials.ts`: runs Node's real `per_context/primordials.js`. `loader.ts`: Node-style
  builtin loader. `bindings/`: our `internalBinding` (buffer, types, util, errors, timers,
  task_queue, async_wrap, `pipe_wrap`/`process_wrap`/`stream_wrap` for `child_process`, ...).
  `shims.ts`: hand-written stand-ins ONLY for modules that are C++ bootstrap/parsers, live outside
  `lib/` (so our `lib/`-only vendoring pipeline can't fetch them), or are dead code on every path
  this sandbox exercises: `internal/bootstrap/realm`, `internal/url`, `internal/encoding`,
  `internal/blob`, `internal/deps/acorn/acorn/dist/acorn` (assert's source-expression quoting),
  `internal/perf/observe` (net.js's unconditional top-level require; only called from `connect()`).
- `eventLoop.ts` + `runtime.ts`: libuv-phase loop (timers -> immediates -> ticks) and Node's
  bootstrap order. `cjs.ts`: user module loader. `process.ts`: the `process` object.

### Known differences from real Node (all deliberate; see the comments where they live)
- V8 introspection with no JS equivalent: `util.inspect` shows every Promise as `<pending>`,
  cannot see Proxies, and cannot preview Map/Set iterators (`bindings/util.ts`, `types.ts`).
- `process.exit()` unwinds by throwing `ProcessExit`; user code that swallows every exception
  can catch it.
- A tick queued from a promise job runs on a macrotask after the microtask queue drains
  (exact for ordering; V8 offers no synchronous microtask drain).
- `fs`: async calls do their work immediately and only defer the *completion* to the loop
  (the syscall blocks the worker for its short duration either way). There are no owners:
  `chown` family succeed if the target exists; `fchmod` only validates the descriptor;
  uid/gid report 1000. `fs.watch` needs the kernel's OP_WATCH (not built yet).
- fd numbers come from one VFS table shared by all processes (each process's fds are closed
  when it exits or is killed, checked in Chromium), so they are not 3,4,5... per process.
- The process worker bundle is ~1.6 MB because it contains the whole runtime (acorn, vendored
  for ESM, is real added weight); every process pays to parse it even for `echo`. Split `node`
  into its own worker entry if that shows up.
- `assert`'s "show the failing expression" enrichment (`assert(x)` with no message) tokenizes the
  failing line with Node's real vendored acorn (`internal/deps/acorn`, outside `lib/` - vendored
  via `scripts/vendor-node-lib.mjs`'s `repoPathFor`, added for ESM's own parsing needs; see
  "ES modules" above) via `internal/errors/error_source.js`'s `getFirstExpression`. That part is
  real. What's not: `internalBinding('errors').getErrorSourcePositions` (`bindings/misc.ts`) gets
  real file/line/column from V8's `Error.prepareStackTrace`, but has no way to recover the
  literal source text a `v8::Message` would carry, so `sourceLine` is always `""` - the real
  tokenizer runs on an empty string, correctly yields zero tokens, and the enrichment degrades to
  a plain message. `assert(x)` still throws `AssertionError` either way.
- ESM's `import.meta.url` is the module's `blob:` URL (what it was actually `import()`ed from),
  not its real VFS path as a `file://` URL - a Blob has no path of its own to report
  (`runtime/esm/loader.ts`).
- The REPL doesn't vendor Node's real `repl` module (raw-mode TTY/ANSI/tab-completion needs
  `tty_wrap` deliberately stubs out - see "Lessons learned"). It's TTY-independent, built on
  `readline`, with indirect `eval()` giving cross-line persistence for `var`/function
  declarations for free (same real global object every line, inside a real Worker). Top-level
  `let`/`const` are rewritten to `var` first (`runtime/replTransform.ts`) so declared names
  aren't lost - two separate `eval()` calls do NOT share lexical bindings the way Node's real
  REPL's reused `vm.Context` does (confirmed in Chromium). Side effects: a `let`/`const`
  redeclared on a later line doesn't throw like real Node's REPL would, and `const`'s
  reassignment protection is lost once rewritten. No multi-line continuation (an unfinished
  expression across lines, `.editor` mode) and no tab completion/history - only `.exit` is
  supported as a dot-command.
- The REPL's `require(...)` (exposed as a real global for the session, via `modules.require` -
  `runtime.ts`'s `runRepl`) has no accompanying `module`/`exports`/`__filename`/`__dirname`
  parity the way a real Node REPL's context provides - deliberately out of scope for now.
- `spawnSync`/`execSync`'s captured stdout+stderr must fit in the second SAB's single 1 MiB data
  window (`EMSGSIZE` otherwise) - unlike fs's chunked big reads, there's no multi-round-trip
  retrieval for large synchronous output. A custom `stdio` array isn't honoured either: stdout
  and stderr are always piped and captured regardless of what the caller asked for (`inherit`,
  `ignore`, a numeric fd, ...) - only the default `stdio: 'pipe'` behavior is implemented
  (`runtime/bindings/childProcess.ts`'s `createSpawnSyncBinding`). `killSignal` is restricted to
  `SIGTERM`/`SIGKILL` like async `kill()` already is; anything else is coerced to `SIGTERM`.

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
- stdin/stdout/stderr/exit/fs-watch events go out-of-band via `postMessage`, never
  through the SAB.
- Runtime is testable headless under Node `worker_threads`.

## Phases

Each phase ends with something demonstrable and tested (vitest, beside the
module: `Thing.test.ts`).

### Phase 0 - Housekeeping  (DONE)
- Commit the `boot:exit` -> `ready` rename; expose `ready: Promise<void>` from
  `boot()`, with a boot timeout (`ERR_BOOT_TIMEOUT` already exists).
- Settle the public name; fix or remove stale docs (the old `PROGRESS.md` was removed) and
  track new work here.
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

### Phase 3 - Real processes (replaces the stub)  (DONE)
- Kernel PID table, `createProcess`, `finalize` (subtree kill: killing or naturally exiting a
  process cascades to its `child_process` children too - see "Current state").
- `MessageChannel` from each process to the FS worker as its doorbell.
- `spawn()` gets stdout/stderr streams, stdin, `kill()`, real exit code; keep
  the `{ processId, exit }` shape and extend it.
- Minimal built-ins: `echo`, `cat`, `ls`, `pwd`, `mkdir`, `rm`.
- stdin delivered out-of-band (`postMessage`), not through the SAB, since a running process
  is not parked on it (done; see "Current state").

### Phase 4 - Node runtime in the process worker  (DONE)
- Sync CommonJS loader (`node_modules` resolution), per-process event loop
  (nextTick, microtasks, timers, setImmediate), builtins: `process`, `fs`,
  `path`, `events`, `buffer`.
- Decided: vendor Node's real `lib/` + our `internalBinding` (vivari "Path B").
- Done: `fs`, `fs/promises`, `os`, `string_decoder`, `stream`, `assert`, `readline`,
  `readline/promises`, `child_process.spawn`/`exec`/`execFile` (async), `child_process.execSync`/
  `spawnSync` (genuinely blocking, over a second SAB - see "Current state"), ESM (`import`/
  `export`, real via the browser's own `import()` - see "Current state").
- Remaining: `child_process.fork` (IPC), real `http`/`net` (Phase 6).

### Phase 5 - Shell  (DONE)
- Small `sh`: `;` `&&` `||`, pipes, redirects, `node <file>`, an interactive REPL (done; see
  "Current state").
- Not done: `$` expansion, globbing, subshells, control-flow keywords, `&` background jobs.

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

- Terminate the worker BEFORE detaching its fs client, or the fs worker may be asked
  to service a client that no longer exists (see `kernel/processes.ts`).
- `process:exit` carries `exitCode` (and `signal` when killed). `errorCode` is a different
  thing: the errno on an error *reply* (`WcvmError.code`).

## First milestone (reached at the end of Phase 3)

Phases 0-3: `spawn("echo", ["Hello, World!"])` produces real stdout and exit
code, and a script can `readFileSync` a file the host wrote. This proves
host -> kernel -> process worker -> SAB -> FS worker -> back.

## Decisions

1. Public name: `wcvm` (decided).
2. Port vs rewrite: rewrite in strict TS using vivari as reference; vendor only Rust crates
   and Node `lib/` (decided).
3. Node runtime: vendored real `lib/` on our own `internalBinding` (decided; implemented).

## Lessons learned (runtime)

- `Buffer.prototype.slice()` returns a VIEW, unlike `Uint8Array.prototype.slice()`. Any code
  in `bindings/` that must copy uses `copyBytes` (explicit prototype call). This bit twice
  (string_decoder flush, shared-memory decode).
- Node stripping of `.ts` (used by worker_threads test fixtures and the discovery script) needs
  erasable syntax: no parameter properties, and interfaces imported with `type`.
- When unsure what real Node does, run it: this machine has Node 24 (e.g. `fstat`'s
  `shouldNotThrow` only spares ENOENT; `readFileSync(badFd)` throws `EBADF ... fstat`).
- Path arguments to the fs binding may be Buffers (rimraf); normalised in `acceptingBufferPaths`.
- A binding module must never call a global (`queueMicrotask`, `setTimeout`, ...) by its bare
  name: `globalObject: self` installs Node's own same-named globals onto the real worker global,
  so an unqualified reference resolves to Node's wrapper instead of the platform's, and if that
  wrapper calls back into the binding, it recurses until the stack overflows. `eventLoop.ts`
  already captured `nativeSetTimeout`/`nativeClearTimeout` at import time for this; `bindings/
  loop.ts`'s `enqueueMicrotask` didn't, and every `node` process silently never called
  `internalBinding('task_queue').enqueueMicrotask` from real Chromium until `child_process`
  did (a `Pipe`'s `close()` callback) - Vitest never caught it because there `globalObject` is
  never `self`, so Node's globals land on a wrapper object, not the real `globalThis`.
- A module that must resolve a builtin by name (`sh` resolving other builtins, including
  itself) is inherently circular with whatever module owns that registry. That's fine for a
  live *binding* referenced inside a function (`programs/sh/sh.ts`'s own `import { resolveProgram
  }` is safe, since it's only read at call time, long after every module has finished loading) -
  but a plain object-literal property (`builtins.ts`'s old `{ ..., sh, ... }`) captures whatever
  value the import happened to hold AT THAT LINE, which is `undefined` if anything reaches the
  circularly-imported module first. This is load-order dependent, so it can pass in one bundler
  and fail in another (it did: broke when a test imported `sh.ts` directly, before `builtins.ts`
  had a chance to load it first and "happen" to work). Fixed with a getter (`get sh() { return
  sh; }`), which defers to the live binding at access time instead of snapshotting it.
- Two separate indirect `eval()` calls in the same realm do NOT persist `let`/`const` bindings
  between them (confirmed in real Chromium: `(0,eval)("let x=1")` then `(0,eval)("x")` throws
  `ReferenceError`) - only `var`/function declarations attach to the real global object. That
  cross-line persistence Node's own REPL shows for `let`/`const` is a `vm.Context`/DevTools
  "REPL mode" feature, not a property of plain `eval()`; the REPL rewrites top-level
  `let`/`const` to `var` first to compensate (`runtime/replTransform.ts`).
- Throwing `ProcessExit` synchronously from inside a `readline` `"line"`/`"close"` listener risks
  the vendored stream internals that invoked that listener intercepting it instead of it
  reaching `runtime.ts`'s own uncaught-exception handling - surfaced as a wrong exit code, only
  in real Chromium. Defer with `process.nextTick(() => process.exit())` so the throw happens
  from a clean call stack (`runtime/repl.ts`).
- `require("child_process")` builds its `pipe_wrap`/`process_wrap` router (`ChildRouter`)
  eagerly at module load - it throws `ENOSYS` immediately if `childProcess` isn't wired, even
  for a script that only ever calls `execSync`/`spawnSync`. Real process workers always wire
  both capabilities unconditionally, so this is invisible in production; it only bit a test
  (`runtime/spawnSync.test.ts`) that supplied `spawnSync` without a `childProcess` fake too.
- A servicer's `service(clientId)` must wrap request decoding in try/catch and respond with an
  error instead of letting a bad frame throw uncaught (`fs/FsServer.ts`'s existing pattern;
  `kernel/spawnSyncServer.ts` mirrors it) - the doorbell handler that calls it has no other
  safety net, so an unhandled throw there would take down the whole Kernel Worker, not just the
  one caller. A quick test with a malformed opcode/body catches this immediately.

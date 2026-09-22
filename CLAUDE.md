# wcvm - context for a fresh session

Read this first, then `PLAN.md` (roadmap + known differences) and `AGENTS.md` (conventions).
An older implementation (`duckwc`) once lived here; its notes (`PROGRESS.md`) were removed but are in
git history: `git show 5e7e388:PROGRESS.md`.

## What this is

`wcvm` (`packages/core`) is a WebContainer-style sandbox: Node.js projects run 100% in the browser
tab, in Web Workers, with no backend. Public API: `boot()` -> `{ spawn, fs, diagnostics, ready }`.
The design follows `vivari` (an MIT open-source WebContainer, a sibling checkout at
`~/workspace/duck/vivari` on the original machine - reference only, not a dependency). We rewrote in
strict TypeScript; we did NOT copy vivari's JS.

## Status (update this when it changes)

Done and verified in real Chromium:
- Boot handshake, kernel worker, File System Worker (in-memory `Vfs`), `wc.fs.*`, `mount`.
- Real processes: one Web Worker per PID, own SAB + doorbell port, stdout/stderr/stdin streams,
  `kill`. `stdin` is a real open pipe (out-of-band via `postMessage`, never the SAB): open until
  the host closes it or the process exits, and only refs the event loop while actually being
  read (`resume()`/a `'data'` listener) - a script that never touches it still exits on its own.
  Killing (or the natural exit of) a process kills its whole subtree: a `child_process` with no
  live parent left would otherwise strand a Process Worker in the tab forever (`detached` is
  accepted but not honoured, so there is no opt-out yet).
- Built-ins: `echo cat ls pwd mkdir rm sleep true false node sh`. `cat` with no args streams real
  stdin.
- `sh -c "..."` / `sh script.sh` (`programs/sh/`): `;`/`&&`/`||` sequencing, `|` pipes (in-memory,
  everything is one worker), `>`/`>>`/`<` redirects, `cd` as a shell builtin. Runs over the same
  built-in registry as everything else, including `node` and recursively `sh` itself. No `$`
  expansion, globbing, subshells, control flow or `&` background jobs. `sh` with no `-c`/script is
  an interactive REPL: reads commands one line at a time from stdin (`programs/sh/lineReader.ts`),
  `cwd` persisted across lines so `cd` sticks; `exit`/`exit N` ends it.
- `node script.js` / `node -e`: Node v24.18.0's own `lib/` (vendored verbatim) on our own
  `internalBinding`, libuv-shaped event loop, `process`, CommonJS loader, `fs`, `fs/promises`, `os`,
  `stream`, `events`, `buffer`, `util`, `timers`, `console`, `string_decoder`, `path`, `assert`,
  `readline`, `readline/promises`, `child_process.spawn`/`exec`/`execFile` (real Node code; a
  child is another real Process Worker the kernel supervises - see `kernel/processes.ts`'s
  `parentPid` and `runtime/bindings/childProcess.ts`). `child.stdin.write()`/`.end()` deliver for
  real, over the same stdin plumbing as top-level processes.
- ESM (`import`/`export`, `runtime/esm/`): real ESM via the browser's own `import()` of `blob:`
  URLs, not a CJS transpile - we resolve the static import graph and rewrite specifiers
  ourselves, but the browser does the actual linking/live-bindings/top-level-await. A `node:`
  builtin or plain CJS file imported from ESM gets a synthetic default+named-export wrapper; a
  genuinely circular static import throws `ERR_CIRCULAR_ESM_NOT_SUPPORTED` (a dynamic `import()`
  breaks the cycle instead). See PLAN.md "Current state" and "Known differences"
  (`import.meta.url` is the module's blob URL, not its real path).
- `node` with no script/`-e` is an interactive REPL (`runtime/repl.ts`): built on the vendored,
  TTY-independent `readline`, not Node's real `repl` module (that needs raw-mode TTY/tab-completion
  machinery `tty_wrap` deliberately stubs out). Variables persist across lines via indirect
  `eval()` against the process's own real global object (only correct inside a real Worker - see
  "Known differences" in PLAN.md), with top-level `let`/`const` rewritten to `var` first
  (`runtime/replTransform.ts`, using the vendored acorn) since two separate `eval()` calls do NOT
  share lexical bindings the way Node's real REPL's reused `vm.Context` does.
- `child_process.execSync`/`spawnSync` (real Node code): genuinely blocking, unlike async
  `spawn()`'s `pipe_wrap`/`process_wrap` - the calling Process Worker parks on a SECOND, per-process
  SAB (`OP_SPAWN_SYNC`, `protocols/syscall.ts`) whose servicer runs directly in the Kernel Worker
  (`kernel/spawnSyncServer.ts`), not the FS Worker, since process supervision lives there
  (`kernel/processes.ts`'s `onExit` buffers the child's full stdout/stderr instead of streaming it,
  and delivers it all at once when the child exits). The `input` option is delivered then the
  child's stdin is always ended (no interactive follow-up input, matching real batch semantics);
  `timeout` kills the child with SIGTERM via a plain `setTimeout` in the kernel. Combined
  stdout+stderr must fit the 1 MiB SAB window (`EMSGSIZE` otherwise, not chunked); only the default
  `stdio: 'pipe'` is honoured (a custom `stdio` array is ignored - stdout/stderr are always
  captured). `fork()`/IPC remains not done (needs vendoring `internal/child_process/serialization`
  plus `NODE_CHANNEL_FD`/`_forkChild` bootstrap wiring - a structurally different, async problem).
- Tests: 427 Vitest + 61 Playwright (Chromium). See "Verifying".

Not done (roadmap order, see PLAN.md): `child_process.fork` (IPC), real `http`/`net` (TCP/UDP/DNS)
+ preview Service Worker, fetcher worker + real `npm`, OPFS persistence, Vite dev server/HMR,
`fs.watch`, Python/Bun, Studio UI.

## Architecture in one page

```
main thread: boot() (src/boot.ts) -> KernelBridge (src/bridges/) -- postMessage -->
Kernel Worker (src/workers/kernel/): router + handlers; hosts the kernel (src/kernel/):
   - createKernelHost: starts the FS Worker, holds a BLOCKING fs client, owns the process table
   - processes.ts: PID table; spawns a Process Worker per PID; forwards stdout/stderr/exit
     (to the host, or to a parent worker for a `child_process`-spawned child - see `parentPid`)
FS Worker (src/workers/fs/): FsServer (src/fs/) services syscalls against one in-memory Vfs
Process Worker (src/workers/process/): runProcess -> a built-in program (src/programs/)
   `node` program -> createRuntime (src/runtime/) = the Node runtime
```

- **Sync bridge (the core trick).** Guest code needs synchronous calls (`readFileSync`). Each process has
  its own SharedArrayBuffer (`src/protocols/syscall.ts`): 24-byte control + 1 MiB data window; the
  process writes a request and parks on `Atomics.wait`; the FS worker answers and `Atomics.notify`s.
  Everything must fit the 1 MiB window; big reads/writes are chunked in `fs/fsClient.ts`.
  Out-of-band events (stdout, exit) use `postMessage`, never the SAB. Every process also gets a
  SECOND SAB for `execSync`/`spawnSync` (opcodes >= `KERNEL_OPCODE_MIN`), whose servicer runs
  directly in the Kernel Worker, not the FS Worker (`kernel/spawnSyncServer.ts`, registered next to
  the fs client in `kernel/index.ts`'s `attachSyncClient`) - process supervision lives there.
- **Requires cross-origin isolation** (COOP `same-origin` + COEP `require-corp`); `boot()` throws
  `ERR_NOT_ISOLATED` otherwise.
- **Node runtime** (`src/runtime/`):
  - `node/lib/**` is Node's source, VERBATIM, generated by `scripts/vendor-node-lib.mjs` from
    `node/manifest.json`; `node/vendor.lock.json` has upstream sha256 and a test re-checks it offline.
    NEVER hand-edit those files. An id under `internal/deps/` (e.g. acorn) is a real repo path
    OUTSIDE `lib/` (`deps/<rest>.js`, not `lib/deps/<rest>.js`) - `vendor-node-lib.mjs`'s
    `repoPathFor` handles that mapping; it still lands under `node/lib/internal/deps/` locally.
  - `primordials.ts` runs Node's real per-context script. `loader.ts` is a Node-style builtin loader.
  - `bindings/` is our `internalBinding` (buffer, types, util, errors, timers, task_queue, async_wrap,
    fs, string_decoder, os, ...). Implement binding members with Node's exact semantics/return codes.
  - `shims.ts`: hand-written stand-ins ONLY where Node's module is C++ or a C++ parser:
    `internal/bootstrap/realm`, `internal/url`, `internal/encoding`, `internal/blob`,
    `internal/perf/observe`.
  - `eventLoop.ts` (timers -> immediates -> ticks) + `runtime.ts` (Node's bootstrap order) +
    `cjs.ts` (user module loader) + `process.ts`.
- **Adding a Node module**: name it in `manifest.json`, run `node scripts/vendor-node-lib.mjs`; or run
  `node --import ./src/testing/registerTsResolve.mjs scripts/discover-node-lib.mjs <id...>` to add
  everything a target needs automatically (it reports missing bindings instead of skipping them).

## Verifying (do this before calling anything done)

```bash
cd packages/core
npx tsc --noEmit -p .                    # typecheck
npx vitest run                           # unit tests (Node worker_threads for cross-thread ones)
pnpm --filter wcvm build                 # tsup: builds dist/ incl. the 3 worker bundles
cd ../../examples/playground && pnpm exec playwright test   # REAL Chromium; needs the build above
```

The Chromium run is mandatory for anything touching workers/SAB/`eval`: **Node accepts things
browsers reject** (e.g. `TextDecoder.decode` on a view over a SharedArrayBuffer threw `EIO` in every
fs call while all Node tests passed). Run `pnpm build` first: the playground uses `dist/`.

## Hard-won gotchas (each cost real time)

- `Buffer.prototype.slice()` returns a VIEW (unlike `Uint8Array#slice`). Copy with `copyBytes`
  (`bindings/buffer.ts`) or `Uint8Array.prototype.slice.call`.
- Files loaded directly by Node (worker fixtures, the discovery script) need ERASABLE TypeScript:
  no parameter properties, no enums, and `import type`/`type` for interfaces. (`FsServer` bit us.)
- The kernel must not `Atomics.wait` before its nested workers report `ready`.
- Terminate a process worker BEFORE detaching its fs client. The fs server closes a client's open fds
  when it is unregistered (otherwise killed processes leak fds; there is a Chromium test for it).
- V8 introspection with no JS equivalent is approximated (see PLAN.md "Known differences"):
  Promise state, Proxies, Map/Set iterator previews.
- A `types` binding brand check must actually throw for the wrong kind (`flags` getter did not;
  use `global`). Every check has a negative test.
- When unsure what Node does, RUN it: real Node 24 is installed locally (`node -e ...`).
- Network from the sandbox needs the proxy: `curl` honours `https_proxy`, Node's `fetch` does not.
  `scripts/vendor-node-lib.mjs` shells out to curl for that reason.
- A binding must never call a global (`queueMicrotask`, `setTimeout`, ...) by its bare name.
  `globalObject: self` puts Node's own same-named globals on the real worker global, so an
  unqualified reference resolves to Node's wrapper, not the platform's - and if that wrapper
  calls back into the binding, it recurses until the stack overflows. Capture the native
  function at module-import time instead (`eventLoop.ts`'s `nativeSetTimeout`, `bindings/loop.ts`'s
  `nativeQueueMicrotask`). Vitest can't catch this: there, `globalObject` is never `self`.
- `process.stdin` has no backing handle to hook readStart/readStop on for event-loop ref
  counting (unlike real Node's TTY/pipe handle), so `runtime.ts` refs the loop off the
  `Readable`'s own `resume`/`pause`/`end` events instead. Get this wrong (e.g. ref whenever a
  stdin host merely exists) and every spawned process - not just ones reading stdin - stops
  exiting on its own the moment the public API always wires one up.
- A module that resolves a builtin by name and can be asked for itself (`sh` running `sh -c
  "sh -c ..."`) is circular with whatever module owns the registry. A plain object-literal
  property (`builtins.ts`'s `{ ..., sh, ... }`) captures whatever the circular import happened
  to hold AT THAT LINE - `undefined` if anything reaches the far module first - which is
  load-order dependent, so it can pass under one bundler/test runner and fail under another.
  Use a getter (`get sh() { return sh; }`) so the property reads the live binding at access
  time instead of snapshotting it at module-init time.
- The Playwright webServer runs a production build (`vite build && vite preview`), not `vite
  dev` (`examples/playground/playwright.config.ts`). `vite dev` special-cases any
  `new Worker(url, {type:"module"})` - how every wcvm worker is created - and injects its HMR
  client into it. That client's own WebSocket-reconnect `setInterval` runs in the worker's
  global scope, where `globalObject: self` has installed Node's own `setInterval` over the
  real one, so the call gets captured and permanently refs our event loop - hanging any process
  that exits by going idle rather than calling `process.exit()` (this is how ESM's hang bug was
  found: a script whose whole body is one `import` has nothing else to call `process.exit()`).
  Real usage (the built `dist/`, no dev server) never sees this; building for e2e tests just
  matches that and is also faster to boot per test run.
- Two separate indirect `eval()` calls in the same realm do NOT share `let`/`const` bindings
  (confirmed in real Chromium: `(0,eval)("let x=1")` then `(0,eval)("x")` throws
  `ReferenceError`) - only `var`/function declarations attach to the real global object and
  persist. That's a V8/DevTools/`vm.Context`-specific "REPL mode" feature, not a property of
  plain `eval()`. The REPL (`runtime/repl.ts`) works around it by rewriting top-level
  `let`/`const` to `var` before evaluating (`runtime/replTransform.ts`). Vitest can't catch this
  either way - it only shows up once you actually run two lines through a real REPL session.
- Throwing `ProcessExit` synchronously from inside a `readline` `"line"`/`"close"` listener (e.g.
  a naive `.exit` handler calling `process.exit()` directly) can get intercepted by the vendored
  stream internals that called that listener, instead of reaching `runtime.ts`'s own
  uncaught-exception handling - it surfaced as a wrong exit code, only in real Chromium, never in
  Vitest. Defer with `process.nextTick(() => process.exit())` instead, so the throw happens from
  a clean call stack.
- `require("child_process")` builds its `pipe_wrap`/`process_wrap` router (`ChildRouter`) eagerly
  at module load, regardless of whether a script ever calls async `spawn()` - it throws `ENOSYS`
  immediately if `childProcess` isn't wired, even for a script that only wants `execSync`. Real
  process workers always wire both `childProcess` and `spawnSync` unconditionally, so this only
  bites test setups that supply one without the other (`runtime/spawnSync.test.ts` needs a
  no-op `childProcess` fake even though it never exercises async spawn).

## Conventions

Strict TS, 2-space indent, semicolons, double quotes, `I`-prefixed interfaces. Tests sit beside the
module (`Thing.test.ts`). Test-only helpers are in `src/testing/` (`loopbackFs` = a real fs client wired
straight to a real `FsServer` on one thread; `fakeFsWorker`, `fakeProcessWorker`,
`spawnFixtureWorker`) and `src/runtime/{testing,harness}.ts`. Commit style: short imperative subject,
body explaining why; end with the attribution lines the session provides. Update `PLAN.md` when a
capability changes.

## Decisions already made (do not re-litigate)

Name `wcvm`; rewrite in strict TS with vivari as reference; vendor Node's real `lib/` on our own
`internalBinding` ("Path B"); in-memory TS `Vfs` first (Rust/Wasm later if needed); process exit
status field is `exitCode`, and `errorCode` on error replies is the errno.

## Loose ends worth knowing

- `.github/workflows/deploy-docs.yml` builds `apps/docs`, which does not exist in this tree (it will
  fail on push). `PUBLISHING.md` is outdated (still says `duckwc`).
- The process worker bundle is ~1.6 MB (acorn added real weight, for ESM parsing) and every
  process parses it, even `echo`; split `node` into its own worker entry if startup cost matters.
- `fs.watch`/`watchFile` return ENOSYS until the kernel has a watch operation.
- Typing a bare `node` (or `sh`) at an interactive `sh` REPL's prompt to nest one REPL inside
  another isn't supported: `IStdinHost.onData` only keeps the ONE most recently registered
  handler (see `workers/process/worker.ts`), so the child's runtime silently steals the parent
  `sh` REPL's own stdin registration; when the child exits, the parent's `lineReader` is left
  holding a stale handler reference and stops receiving further input. The playground's terminal
  demo (`examples/playground/src/terminal.ts`) sidesteps this by only ever spawning one
  interactive program directly (a picker, not nesting) - fixing it for real needs some kind of
  stdin-ownership handoff/stack in the kernel, not attempted yet.

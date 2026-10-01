# wcvm - context for a fresh session

Read this first, then `PLAN.md` (roadmap + known differences), `HISTORY.md` (detailed
per-feature implementation history and postmortems - this file only keeps a short inventory),
and `AGENTS.md` (conventions).
An older implementation (`duckwc`) once lived here; its notes (`PROGRESS.md`) were removed but are in
git history: `git show 5e7e388:PROGRESS.md`.

## What this is

`wcvm` (`packages/core`) is a WebContainer-style sandbox: Node.js projects run 100% in the browser
tab, in Web Workers, with no backend. Public API: `boot()` -> `{ spawn, fs, diagnostics, ready,
preview }`.
The design follows `vivari` (an MIT open-source WebContainer, a sibling checkout at
`~/workspace/duck/vivari` on the original machine - reference only, not a dependency). We rewrote in
strict TypeScript; we did NOT copy vivari's JS.

## Status (update this when it changes)

Done and verified in real Chromium. Full implementation history, design rationale, and the real
bugs found along the way (exact root causes, fixes, and test counts) now live in `HISTORY.md` -
read the relevant section there before touching that area, or before re-deriving a "why is this
built this way" that was probably already answered by a real bug.

- Boot handshake, kernel worker, File System Worker (in-memory `Vfs`), `wc.fs.*`, `mount`.
- Real processes: one Web Worker per PID, own SAB + doorbell port, stdout/stderr/stdin streams,
  `kill`, subtree-kill on exit.
- Built-ins: `echo cat ls pwd mkdir rm sleep clear true false node sh npm`.
- `sh`: `;`/`&&`/`||`, `|` pipes, `>`/`>>`/`<` redirects, `cd`, an interactive REPL, `PATH`-resolved
  executables (incl. shebang scripts).
- `node script.js`/`node -e`: Node v24.18.0's own `lib/` vendored verbatim, most core builtins
  (`fs` incl. `globSync`/`glob` - `internal/deps/minimatch` vendored, `stream`, `events`, `buffer`,
  `util`, `timers`, `readline`, `url`, `tty`, `perf_hooks`, `path`, `assert`, `querystring`,
  `module`, ...), `child_process` (`spawn`/`exec`/`execFile`/`execSync`/`spawnSync`/`fork()`+IPC),
  and an interactive REPL.
- Real ESM (`import`/`export`) via the browser's own `import()` of rewritten `blob:` URLs; real
  `import.meta` (the module's actual `file://` URL/filename/dirname/resolve); dynamic `import()`
  from CJS too. Genuinely circular static ESM imports ARE now supported (a strongly-connected-
  component-aware rewrite - `runtime/esm/loader.ts`, `runtime/esm/cyclic.ts` - merges each cycle
  into live getter-based bindings instead of one Blob URL per module); this used to be a hard gap
  (hit for real in zod v4's and Svelte's own compilers) - see HISTORY.md for the full writeup.
- Synchronous `require(esm)` like Node 24 (`runtime/esm/syncRequire.ts` + `cjs.ts`): a `.mjs`, a
  `.js` under `"type": "module"`, or a `.js` whose CJS compile fails with ESM syntax (Node's own
  syntax detection) is rewritten into a plain function body (imports -> live getters over a
  synchronous `__wcvm_import_sync__`, resolved with the ESM "import" conditions; top-level await ->
  `ERR_REQUIRE_ASYNC_MODULE`). Also new: `npx <local bin>` (no registry), `/tmp` (Studio creates it
  at boot; core's VFS root stays empty), legacy no-`"exports"` package subpaths, Node's
  `PATTERN_KEY_COMPARE` for `exports` patterns (both loaders), `import(URL)`, the global
  `MessageChannel` once `worker_threads` loads, and `Error.prepareStackTrace` call sites whose
  `getFileName()` works (`runtime/callSiteFileNames.ts`).
- `fs.watch`/`fs.watchFile` (real push events + polling).
- `net` (real TCP over a virtual in-kernel network), `http` (real vendored `http.js` plus a
  hand-written HTTP/1.1 wire parser), `dgram` (real UDP).
- `zlib` (real vendored `zlib.js` over the native `CompressionStream`/`DecompressionStream`; no
  Brotli/Zstd), `crypto` (a hashing-only hand-written shim over `SubtleCrypto`, plus
  `randomBytes`/`randomUUID`), `worker_threads` (real Node code over a real `MessageChannel`).
- Preview: a Service Worker relay (`wc.preview.*`) serving a virtual port's `http.createServer()`
  into a real `<iframe>`, plus a WebSocket tunnel (for HMR) and absolute-path routing.
- OPFS persistence (`boot({ persist })`), write-behind mirrored, restored before the first syscall;
  `wc.fs.sync()` to await the mirror catching up; symlinks persisted via a side-channel manifest.
- A minimal built-in `npm install`/`npm run`/`npm create`/`npm init` (NOT real npm - see "Real npm:
  feasibility findings" in PLAN.md) - enough to run an unmodified Vite dev server with HMR,
  esbuild-wasm, React (with Fast Refresh) and Vue projects, and plain Node/Express servers, all
  installed from the real npm registry.
- A real native browser `Worker` and `fetch()` of `file:` URLs (needed by WASM-loading packages
  like Rolldown's browser build).
- The playground (`examples/playground`) has four working dev-server examples (Vite+React,
  Vite+Vue, `npm create vite@latest` with real interactive prompts, plain Node+Express). Studio's
  own template picker (`apps/studio`) separately offers React/Vue/Vanilla/Static/Bootstrap 5/
  Preact/Lit/Solid/Qwik/TanStack Router/Svelte/Tailwind CSS/Ember (JS and TS)/Angular/Rectify, plus a Backend tab (Express JS/TS, NestJS - `apps/studio/.../templateProjects/backendRecipes.ts`; TS is built with `tsc` and run with `node`, no watch) and a Fullstack tab (Next.js TS/JS on webpack + the WASM SWC, SvelteKit, React Router 7, Astro 6 - `fullstackRecipes.ts`; each verified in the real preview iframe: SSR, hydration, a server endpoint, client navigation; `/` is each framework's OWN starter page as its scaffolder writes it with default options (`fullstackStarters.ts`, compared pixel-for-pixel against the real scaffold - see HISTORY.md "Starter fidelity check"), and the recipes add a `/demo` page + `/api/hello` (SvelteKit is the `sv create` demo app instead - its own About/Sverdle pages, no `/demo`); Nuxt is a greyed-out "soon" card: `oxc-parser`'s WASM binding hits the napi-rs worker deadlock, and Nuxt 4 needs Vite 8) - Svelte was PARKED, then
  re-verified working once the circular-ESM gap above was fixed; Tailwind CSS v4 hit a real
  `@napi-rs/wasm-runtime` deadlock (any native `Scanner` call spanning more than one line of input
  in a single call freezes the whole thread - a spawned WASI worker's own file reads relay back to
  the creator thread, which is itself already frozen waiting on that same worker), fixed by
  patching `@tailwindcss/vite`'s own plugin to call `Scanner.scanFiles()` once per line instead of
  once per file (see PLAN.md's "Tailwind CSS v4: feasibility findings" and HISTORY.md). Ember 7.3
  (Vite blueprint, `@embroider/vite`) runs too - its build forks `ember build --watch`, which shells
  out to `npx vite build` - and needs `JOBS=1` in the environment (Studio's shells set it) or
  broccoli-babel-transpiler's worker pool hangs; see HISTORY.md "Ember". Angular 22 (`ng serve`) runs
  too: it needed the event loop to stop exiting before promise continuations ran, `process.versions.
  webcontainer` (Piscina's worker pool hangs without it), `sh` fd redirects and more - see HISTORY.md
  "Angular"; Studio's shells set `NG_BUILD_BABEL_LINKER`/`NG_BUILD_OPTIMIZE_CHUNKS`.
- Studio's editor (`apps/studio/.../Editor/ide`): Prettier formatting (Format button, ⇧⌥F, command
  palette, Monaco's own Format Document - `controller/format.service.ts`, lazy-loaded, honours the
  project's `.prettierrc`), Monarch grammars for Vue/Svelte/Astro/Ember `.gjs`/`.gts` (`controller/
  languages.ts`, built on Monaco's own html/js/ts grammars), and per-file-type icons (`fileIcon/`).
  `.gjs`/`.gts` formatting uses `content-tag` directly (the community plugin can't be bundled);
  `vite.config.ts` aliases `prettier` to its browser build for prettier-plugin-svelte.
- Tests: 1091 Vitest (run under Node 24 - on Node 22, 19 fail only because `URLPattern`/`CloseEvent`
  are missing; `~/.nvm/versions/node/v24.18.0/bin` here) + 161 Playwright (Chromium; the ones needing
  the real npm registry are opt-in: `WCVM_E2E_VITE=1`). See "Verifying".

Not done (roadmap order, see PLAN.md): npm workspaces and the rest of `npm exec` (arbitrary local/
registry commands, not just `create`), DNS (`dns.lookup()` is a fixed-address shim, low-value in a
single virtual host with no real network to resolve a name against), real `npm` (investigated and
DEFERRED - its fetch stack has no path to a real network from inside wcvm's virtual `net`/`http`; a
minimal built-in `npm install`/`npm run`/`npm create` exists instead - see above and PLAN.md's "Real
npm: feasibility findings"), Python/Bun, Studio UI.

## Architecture in one page

```
main thread: boot() (src/boot.ts) -> KernelBridge (src/bridges/) -- postMessage -->
Kernel Worker (src/workers/kernel/): router + handlers; hosts the kernel (src/kernel/):
   - createKernelHost: starts the FS Worker, holds a BLOCKING fs client, owns the process table
   - processes.ts: PID table; spawns a Process Worker per PID; forwards stdout/stderr/exit
     (to the host, or to a parent worker for a `child_process`-spawned child - see `parentPid`)
FS Worker (src/workers/fs/): FsServer (src/fs/) services syscalls against one in-memory Vfs
   - optional OPFS persistence (boot({persist}) only): restored before "ready", then
     fs/opfsPersistence.ts mirrors every change back to OPFS write-behind
Process Worker (src/workers/process/): runProcess -> a built-in program (src/programs/)
   `node` program -> createRuntime (src/runtime/) = the Node runtime
Fetcher Worker (src/workers/fetcher/): one persistent worker, own fs client like a process's -
   fetcherRuntime.ts does real fetch()es (capped ~10 concurrent), streamed into the VFS
```

- **Sync bridge (the core trick).** Guest code needs synchronous calls (`readFileSync`). Each process has
  its own SharedArrayBuffer (`src/protocols/syscall.ts`): 24-byte control + 1 MiB data window; the
  process writes a request and parks on `Atomics.wait`; the FS worker answers and `Atomics.notify`s.
  Everything must fit the 1 MiB window; big reads/writes are chunked in `fs/fsClient.ts`.
  Out-of-band events (stdout, exit) use `postMessage`, never the SAB. Every process also gets a
  SECOND SAB for `execSync`/`spawnSync` (opcodes >= `KERNEL_OPCODE_MIN`), whose servicer runs
  directly in the Kernel Worker, not the FS Worker (`kernel/kernelSyncServer.ts`, registered next to
  the fs client in `kernel/index.ts`'s `attachSyncClient`) - process supervision lives there. The
  same SAB also carries `OP_ZLIB_SYNC` (zlib's `*Sync` functions - see the `zlib` Status entry).
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
- `setupChannel`'s (fork() IPC) own `channel.onread` checks the raw ArrayBuffer's truthiness
  for EOF (`if (arrayBuffer) {...} else {...disconnect...}`), unlike the generic stdout/stderr
  Readable wrapping (`internal/stream_base_commons.js`'s `onStreamRead`), which keys off
  `streamBaseState[kReadBytesOrError]`'s sign instead. `Pipe.deliver()` used to pass a real (if
  empty) `ArrayBuffer` for EOF either way - harmless for the generic case, but meant
  `setupChannel` never saw a disconnect. Fixed to pass `undefined` for EOF; verified safe for
  the other consumers first (they don't check the buffer's truthiness).
- A real OS pipe closing its local end signals EOF to the other end automatically; ours doesn't
  exist, so `Pipe.close()` must say so explicitly. Found via `fork()`: `child.disconnect()`'s
  real vendored implementation calls `channel.close()` directly (not `shutdown()`, which is
  where the other endStdin/endIpc plumbing lived) - the forked child's `process.on('disconnect',
  ...)` silently never fired until `close()` was also taught to call `host.endIpc()` for the ipc
  case. Only the mandatory Chromium e2e caught this (a fake-host Vitest test can't tell the
  difference between "no real corresponding process" and "forgot to notify it").
- The `_forkChild`/`NODE_CHANNEL_FD` bootstrap glue skipped for `fork()` (no real fd to give it -
  `runtime.ts` calls `setupChannel` directly instead) turned out to hide MORE than a fd-open
  call: `setupChannel` itself never wires `channel.ref()`/`.unref()` to anything - real
  `_forkChild` does that separately, right after calling `setupChannel`
  (`process.on('newListener'/'removeListener', (name) => { if (name==='message'||
  name==='disconnect') control.refCounted()/unrefCounted(); })`). Miss that one extra piece and
  `Pipe.ref()` (wired to `loop.ref()` in `createForkIpcPipe`) simply never gets called - a forked
  child with nothing but `process.on('message', ...)` exits immediately instead of staying alive,
  defeating fork()'s entire purpose. Found by literally counting calls to the override (zero) in
  a Vitest test that raced the runtime against a real timeout, after two "it just returns empty
  output sometimes" flaky-looking Vitest failures turned out to be this, not a timing race at
  all: without the ref, whether a queued reply got processed before the idle process exited was
  luck, not a guarantee. Lesson: when deliberately skipping a piece of real Node bootstrap
  because part of it doesn't apply to this sandbox (no fd here), re-read the WHOLE skipped
  function for other, unrelated things it also did - don't assume "the fd-related part was the
  only part."
- `fs.writeFileSync`'s default flag is `O_CREAT|O_TRUNC`, and it's entirely fd-based here (`open`
  then `write` then `close`, matching real Node's own C++ fast path) - a naive `fs.watch` change
  hook on BOTH `open()`'s O_TRUNC branch and `write()` reported two `'change'` events for one
  logical save. A plain Vitest assertion of one event per write caught this immediately (no
  Chromium needed - it's pure Vfs/FsServer logic, no worker/SAB/timer involved). Fix: `open()`'s
  own truncation doesn't report a change by itself; only a write that follows does. `fs.truncateSync`
  isn't affected - it already goes through `open('r+')` + `ftruncate()`, which does report.
- A real `uv_tcp_t` is ref'd from the moment it starts *connecting*, not just once connected -
  `TCP.connect()` (`runtime/bindings/net.ts`) forgetting to `ref()` immediately meant a script
  doing nothing but `net.connect(port, cb)` saw an idle event loop (nothing else pending yet)
  and exited before the inherently-async connect result could ever arrive; `cb` silently never
  ran. Caught by a plain Vitest test asserting the callback fired - it just hung until the
  default test timeout, no Chromium needed. The fix mirrors `fs.watch`'s FSEvent and a listening
  TCP server: ref on the operation that STARTS async work, not on its eventual success.
- `require('net')` transitively hits the exact same "eager router construction throws ENOSYS
  without a childProcess host" gotcha `child_process.js` already has (below): `net.js` also
  requires `stream_wrap`/`pipe_wrap` unconditionally at module load, and both are built by
  `childProcess.ts`'s own `ChildRouter`, which throws if no host is wired - regardless of
  whether the script (or test) ever touches `child_process` itself.
- `HTTPParser.execute()` (`runtime/bindings/http.ts`) originally wrapped its call into the real
  parser (`HttpMessageParser.execute()`, `httpParser.ts`) in a blanket `try { ... } catch (error)
  { return error instanceof Error ? error : new Error(...); }` - meant to turn a genuine malformed-
  message error into the "parse failed" value real vendored `_http_server.js`/`_http_client.js`
  expect `execute()` to be able to return. But `HttpMessageParser.execute()`'s own call stack runs
  straight through to `onHeadersComplete`, which is how the real request/response handler chain
  gets invoked (`server.emit('request', req, res)`, eventually the user's own handler) - so
  *anything* that handler does synchronously, including calling `process.exit()`, throws up
  through that same stack and got silently caught and downgraded to a returned `Error` instead of
  propagating. Real llhttp has no such JS-level catch in the middle of its native call stack, so
  this was purely an artifact of this sandbox's own wrapper. Symptom: a server's request handler
  ran (its own `console.log`s appeared), `process.exit(0)` was reached, and the process just hung
  forever instead of exiting - no uncaught-exception handler ever fired either, since the throw
  never got that far. Not caught by the parser's own unit tests (`httpParser.test.ts` - pure
  parsing logic, no user callbacks in the loop) nor by typecheck/lint; only surfaced once an
  actual `http.createServer()` handler was integration-tested end-to-end. Fixed by narrowing the
  catch to only `HttpParseError` (the parser's own genuine error type) and rethrowing everything
  else untouched.
- A `net.TCP` handle's `.port` field is NOT a reliable "is this the listening server" check: an
  ACCEPTED connection's own handle also gets `.port` set to the server's virtual port, purely for
  `getsockname()` (`runtime/bindings/net.ts`'s `NetRouter.dispatch`'s `"incoming"` case). Checking
  only `port !== null` in `close()` meant destroying any ONE accepted connection (e.g. an ordinary
  HTTP response ending its socket) silently unregistered and unlistened the WHOLE server for every
  future request - a real bug only visible once something kept reacting to `net:listen`/
  `net:unlisten` events over time (the preview iframe UI's `onListen()`; a single request/response
  test never notices the listener vanish afterward). Fixed with a separate `isListening` flag, set
  only by a real successful `listen()`. Debugging this needed the SANDBOXED SCRIPT's own vendored
  `console.log` (routes to real stdout) - neither `page.on("console")` nor even a Kernel Worker's
  `worker.on("console")` surfaces a Process Worker's own output, since it's a worker spawned BY the
  Kernel Worker, a grandchild-of-page target CDP doesn't auto-attach to.
- A Service Worker's `respondWith()`-relay-through-a-window-client trick (preview relay) breaks for
  an `<iframe>` NAVIGATING straight to the intercepted URL, as opposed to the top page calling
  `fetch()` itself: `event.clientId` is empty for a navigation, and `event.resultingClientId` names
  a client that doesn't exist yet at fetch time for a genuine cross-document load -
  `sw.clients.get(resultingClientId)` never resolves in real Chromium (a hang). Fix: relay through
  whichever client has `frameType === "top-level"` (`sw.clients.matchAll({ type: "window" })`)
  instead - always the actual host page, regardless of who's making the request. Separately, a page
  with `Cross-Origin-Embedder-Policy: require-corp` (needed for `SharedArrayBuffer`) refuses to
  embed an iframe whose OWN response doesn't also declare a COEP header (`net::ERR_BLOCKED_BY_RESPONSE`,
  independent of same-origin-ness) - invisible to a plain `fetch()` of the same URL, since that
  check is specific to a nested browsing context's own navigation.
- OPFS persistence's write-behind mirror must apply changes to OPFS strictly in the order they
  happened in the vfs, not in whatever order their own async work happens to resolve - two quick
  writes to the SAME path, mirrored as two independent, unordered promises, can have the FIRST
  write's slower OPFS round trip finish AFTER the second's faster one, leaving OPFS with a stale
  result. Fixed with a single serialized queue (`chain = chain.finally(() => task().catch(...))`)
  instead of firing each mirror op independently. Restoring from OPFS must also happen BEFORE
  `vfs.onChange` is wired to the mirror (i.e. before `FsServer` is even constructed) - recreating
  OPFS's own tree in a fresh Vfs is itself a sequence of mutations, and if the mirror were already
  listening, it would immediately write everything it just read straight back to OPFS, a pointless
  (though not incorrect) round trip on every single boot.
- Being ORDERED (the gotcha above) doesn't mean being CAUGHT UP: the write-behind mirror answers a
  syscall before its own OPFS write finishes, and had no way to tell a caller "everything so far has
  actually landed" - so a real reload right after a big write (an `npm install`'s many small files,
  say) could lose whatever was still mid-flight, with nothing to indicate it. Found from a real
  Studio bug report ("packages aren't installed anymore after a reload"), then reproduced directly
  (not just inferred): a two-file npm install followed by an immediate `page.reload()` lost one of
  the two files. Fixed with `wc.fs.sync()` (see "Status") - not a delay, a real completion signal
  the mirror's own queue can report. Lesson: "answers immediately, mirrors in the background" is a
  correct design, but it's only actually safe for a caller to walk away if there's also a way to
  ask "are you done yet" - fire-and-forget with no way to wait for the fire is a real gap, not a
  simplification, the moment anything outside the process (a reload, a tab close) can race it.
- The real global `FileSystemDirectoryHandle`/`FileSystemFileHandle` (OPFS) don't structurally
  satisfy a hand-picked subset interface typed against them: `entries()`'s real declared return
  type isn't narrowed to file/dir handles specifically, and `write()`'s real param type doesn't
  accept a bare `Uint8Array` whose generic type param defaults to `ArrayBufferLike` (which includes
  `SharedArrayBuffer`, which real DOM `ArrayBufferView` types don't accept) - the same
  generic-TypedArray friction `httpParser.ts`'s own `buffer` field and
  `PreviewServiceWorker.ts`'s `result.body as BufferSource` already hit. Cast once, at the single
  real boundary (`fs/opfsPersistence.ts`'s `getOpfsRoot`), with a comment explaining why, rather
  than trying to make the interface itself structurally match everywhere it's used.
- `bindings/zlib.ts`'s `drain()` used `this.pendingOutput ?? new Uint8Array(0)` to default a `null`
  "nothing computed yet" to an empty array for the arithmetic, then unconditionally wrote that
  result BACK to `this.pendingOutput` - silently turning `null` into a merely-empty-but-non-null
  array the very first time `drain()` ran, even on the branch that hadn't computed anything yet.
  Since `null` vs. "computed, possibly empty" is exactly the signal `write()`/`writeSync()` use to
  decide whether the whole-buffer `CompressionStream`/`DecompressionStream` pass has already run,
  this made a real finish-flagged call silently skip actually compressing/decompressing and just
  "drain" the empty result instead - a `Gzip`→`Gunzip` pipe test caught it immediately (`gunz`
  received zero bytes and failed to decompress them), but neither `runZlibOnce`'s own direct tests
  nor the sync path noticed, since neither exercises the exact "buffer across multiple calls, then
  compute once" state transition a real streaming `Transform` pair does. Fix: only ever reassign
  `pendingOutput` from within a branch that already knows it's non-null.
- A promise chain's `.then(fn).catch(fn2).then(fn3)` is NOT the same as `.then(onSuccess,
  onFailure)` when `fn3` must never run after `fn2` already handled an error: `bindings/zlib.ts`'s
  async `write()` used to call `this.fail(error)` (routing to `onerror`/`self.destroy(error)`)
  inside a `.catch()`, but the chain then continued on to ALSO drain/report state/invoke the real
  vendored `processCallback` for that same failed operation - real Node's native zlib binding
  treats success and failure as mutually exclusive outcomes for one `write()`, and doing both left
  a `zlib.gunzip()` callback seeing neither a clean error nor a clean result. Fixed with a
  two-armed `.then(onSuccess, onFailure)` so only one path ever executes.
- A real platform `MessagePort`/`MessageChannel` (browser or Node's own global ones) has NONE of
  three things real Node's native C++ `MessagePort` binding provides for free: it never calls
  `port[onInitSymbol]()` during construction (`internal/worker/io.js`'s own `oninit()`, which sets
  up the `NodeEventTarget` state `.on()` needs, so it must be called manually - see `worker_threads`
  in "Status"); it has no `.ref()`/`.unref()`/`.hasRef()` at all (event-loop keep-alive, same
  concept a timer already has - install them directly on the global prototype); and, the subtlest
  one, its real native message delivery has no way to reach `internal/event_target.js`'s own
  `NodeEventTarget` (a COMPLETE, independent, hand-written reimplementation, not `extends` the real
  platform `EventTarget` at all) - `.on()`/`.addEventListener()` calls after `internal/worker/io.js`'s
  own prototype swap just write to a private, JS-only listener store nothing native ever reads, so
  a message can be sent, received, and STILL never reach a registered listener, with no crash or
  error anywhere to point at the cause. Real Node's own native binding cooperates with
  `NodeEventTarget` by calling a specific, well-known hook on every incoming message
  (`port[Symbol.for('nodejs.internal.kHybridDispatch')](data, type)`) - bridge it yourself with a
  REAL, native `addEventListener()` (captured before anything swaps the prototype) that calls this
  same hook manually. A port that crosses a REAL transfer needs ALL of this done again, in the
  receiving realm - `oninit()`'s effects don't survive a transfer - and since you can't always
  predict every site a transferred port might arrive at (vendored code can itself relay one deeper
  into its own protocol, invisibly), make the bridge itself recursively re-initialize every port
  riding along in any message it already sees (`event.ports`), not just the ones you know to expect.
- `worker_threads` cannot be exercised under Vitest/Node at all - real Node's own internal
  `node:internal/per_context/messageport` wiring is active in every plain Node process regardless
  of whether the script under test ever touches `worker_threads` itself, and conflicts outright
  with this sandbox's own `MessagePort.prototype` mutations the moment `new Worker(...)` is
  constructed. Test the wire protocol (kernel routing, pid/threadId minting) with plain object
  fakes under Vitest as usual; anything touching a real `MessagePort` is Chromium-only, more so
  than the project's general "workers/SAB/`eval`" rule already implies.
- Real Node's vendored `internal/worker.js` `Worker` class `extends EventEmitter` (plain,
  old-style - NOT `NodeEventTarget`), so `this.emit('exit'/'error'/'online', ...)` has none of
  `NodeEventTarget`'s own try/catch-and-route-to-`emitUncaughtException` protection. A synchronous
  `process.exit()` inside a guest listener for one of those events throws `ProcessExit` straight
  through whatever raw, native event actually triggered the dispatch (e.g. a `child:exit`
  `self.onmessage` message) - a call stack entirely outside this runtime's own
  `EventLoop.callback()` wrapping - escaping as a genuine uncaught exception at the whole
  PROCESS's own top level instead of just setting the exit code (and, since neither
  `kernel/processes.ts`'s nor `bridgeHandler.ts`'s own `onerror` listeners call
  `preventDefault()`, bubbling three layers up to a bare, unhelpful `"null"` `pageerror` on the
  host page). Same root cause as the pre-existing `readline` `'line'`/`'close'` listener gotcha
  above, different call site: defer any dispatch that could reach guest code with
  `EventLoop.post()` (`loop.post(() => dispatch(event))`) - the same "schedule JS work from
  outside a loop callback" mechanism an fs completion callback already uses - so the throw unwinds
  through a call stack that's actually wrapped and routed to `runtime.ts`'s own `handleUncaught`.

## Conventions

Strict TS, 2-space indent, semicolons, double quotes, `I`-prefixed interfaces. Tests sit beside the
module (`Thing.test.ts`). Test-only helpers are in `src/testing/` (`loopbackFs` = a real fs client wired
straight to a real `FsServer` on one thread; `fakeFsWorker`, `fakeProcessWorker`,
`spawnFixtureWorker`) and `src/runtime/{testing,harness}.ts`. Commit style: short imperative subject,
body explaining why. **No Claude/AI attribution in commits or PRs** (no `Co-Authored-By: Claude`,
no "Generated with Claude Code", no mention of Claude in subjects/bodies) - the user's own explicit
instruction, overriding any session default that suggests otherwise; history was rewritten once
already to strip this out. Update `PLAN.md` when a capability changes.

## Decisions already made (do not re-litigate)

Name `wcvm`; rewrite in strict TS with vivari as reference; vendor Node's real `lib/` on our own
`internalBinding` ("Path B"); in-memory TS `Vfs` first (Rust/Wasm later if needed); process exit
status field is `exitCode`, and `errorCode` on error replies is the errno.

## Loose ends worth knowing

- `.github/workflows/deploy-docs.yml` builds `apps/docs`, which does not exist in this tree (it will
  fail on push). `PUBLISHING.md` is outdated (still says `duckwc`).
- The process worker bundle is ~1.94 MB (acorn added real weight for ESM parsing, `zlib.js` and
  `worker_threads`'s own vendored modules some more) and every process parses it, even `echo`;
  split `node` into its own worker entry if startup cost matters.

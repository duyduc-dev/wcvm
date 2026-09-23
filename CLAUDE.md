# wcvm - context for a fresh session

Read this first, then `PLAN.md` (roadmap + known differences) and `AGENTS.md` (conventions).
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
  `cwd` persisted across lines so `cd` sticks; `exit`/`exit N` ends it. Nesting an in-process
  interactive program (a bare `node` or `sh`) at the prompt works: it registers its own handler on
  the SAME `IStdinHost` sh's REPL is reading from, displacing it, so `lineReader.ts`'s
  `reattach()` reclaims it after every line (`runReplSh`) - and `workers/process/worker.ts`
  replays a real EOF to any handler that (re-)registers after the fact, in case that happened
  while the nested program was still active.
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
  (`kernel/kernelSyncServer.ts`), not the FS Worker, since process supervision lives there
  (`kernel/processes.ts`'s `onExit` buffers the child's full stdout/stderr instead of streaming it,
  and delivers it all at once when the child exits). The `input` option is delivered then the
  child's stdin is always ended (no interactive follow-up input, matching real batch semantics);
  `timeout` kills the child with SIGTERM via a plain `setTimeout` in the kernel. Combined
  stdout+stderr must fit the 1 MiB SAB window (`EMSGSIZE` otherwise, not chunked); only the default
  `stdio: 'pipe'` is honoured (a custom `stdio` array is ignored - stdout/stderr are always
  captured).
- `child_process.fork()`/IPC (real Node code): unlike `execSync`/`spawnSync`, this is an async
  problem, not a blocking one - it reuses `spawn()`'s existing `pipe_wrap`/`process_wrap` machinery
  almost entirely unchanged (`fork()` itself just calls `spawn("/bin/node", [...execArgv,
  modulePath, ...args], options)`). The one genuinely new piece: `Pipe` gained a `kind: "stdio" |
  "ipc"` tag so its writes route through new `IChildProcessHost.writeIpc`/`endIpc` methods instead
  of `writeStdin`/`endStdin` (the kernel needs to route the two differently); `bindings/
  childProcess.ts`'s `createForkIpcPipe` builds the CHILD's own side (its channel to its own
  parent) by reusing the SAME `ctx` object already passed to `createInternalBinding`, since
  `setupChannel`'s `channel.onread` reads the realm's shared `streamBaseState`. `runtime.ts` calls
  `setupChannel(process, pipe, "json")` directly, bypassing vendored `_forkChild`/`NODE_CHANNEL_FD`
  entirely (no real fd to pass around) - see "Hard-won gotchas" for three real bugs this surfaced
  (`Pipe.deliver()`'s EOF signal, `Pipe.close()` needing to propagate to the other side, and
  `_forkChild`'s own `process.on('newListener'/'removeListener', ...)` ref-counting wiring having
  to be reimplemented too, not just `setupChannel` itself - otherwise a live `'message'` listener
  never keeps the process alive, defeating the entire point of `fork()`).
  Vendored `internal/child_process/serialization` for real (was missing); only `serialization:
  'json'` (the real default) works - `'advanced'` needs a real V8 serializer (`runtime/shims.ts`'s
  `v8` stub only exists so the module loads, never actually used for json mode). fork()'s default
  `stdio` is `'inherit'` (real fd-sharing this sandbox can't do) - pass `{ silent: true }` to get
  piped/captured stdout+stderr, same as real Node already lets you.
- `fs.watch`/`fs.watchFile` (real Node code, `internal/fs/watchers.js`): `watchFile` is pure local
  polling (a native timer repeatedly calling `fs.stat`, `bindings/fs.ts`'s `StatWatcher`) - no
  worker/kernel plumbing needed. `watch` is real push events: `Vfs.ts` gained a public `onChange`
  hook every mutating method calls (including the fd-based ones, since `fs.writeFileSync` is
  entirely fd-based here too - `open`+`write`+`close`, matching real Node's own C++ fast path);
  `fs/FsServer.ts` owns the watch registry (two new opcodes, `OP_WATCH_START`/`STOP`) and dispatch;
  the fs worker reaches the right process worker via a new unprompted `self.postMessage`
  (`kernel/index.ts`'s `fsWorker.onmessage`, previously only used for the ready handshake, now
  routes it to `kernel/processes.ts`'s new `notifyWatch`) - the same "kernel already has a
  postMessage channel to every process worker" shape `spawnSync`/`fork()` used. Verified in real
  Chromium not just for a process watching its own writes, but for the host's `wc.fs.*` waking a
  process's watch, and one process's write waking a different process's watch.
- `net.createServer`/`net.connect` (real `net.js`, over a real `tcp_wrap`): a virtual network
  entirely inside the kernel - a "connection" is two Process Workers' own `TCP` handles
  (`runtime/bindings/net.ts`) relayed byte-for-byte through `kernel/netServer.ts`, the same
  postMessage shape `child_process`'s stdin/stdout/ipc already use. `listen()` alone needs a
  synchronous, globally-coordinated answer (port `0` -> the real assigned port; an explicit port
  already taken -> real `EADDRINUSE`) - a THIRD per-process SAB (`OP_NET_LISTEN`), serviced by
  the kernel exactly like `spawnSync`'s own second one. `connect()`/reads/writes are ordinary
  async postMessage relay. `stream_wrap`'s shared `streamBaseState` (real read/write completions,
  one array per realm) moved out of `child_process.ts` into `runtime/bindings/streamBaseState.ts`
  so `net.ts` can share the exact same instance real `net.js` itself expects. No IPv6, no
  Unix-domain sockets; `require('net')` needed two small new shims (`runtime/shims.ts`):
  `dns.lookup()` (net.js's own default host, `'localhost'`, needs *something* to resolve it) and
  `cluster.isPrimary` (`Server.listen()` checks it unconditionally) - both fixed answers, since
  this sandbox has no real network or multi-process clustering to speak of. Verified in real
  Chromium for a real client and server process (different Process Workers) exchanging data,
  `listen(0)` assigning different real ports across processes, a real `EADDRINUSE`, and a real
  `ECONNREFUSED`.
- `http.createServer`/`http.request`/`http.get` (real vendored `http.js`/`_http_server.js`/
  `_http_client.js`/`_http_outgoing.js`/`_http_common.js`/`_http_agent.js`/`_http_incoming.js`):
  runs entirely on top of `net` (above) - `http` opens no socket of its own, it drives a real
  `net.Socket`/`net.Server`. Real Node's own HTTP parsing is `llhttp`, a native C++/Wasm binding,
  so unlike everything else in this sandbox `internalBinding('http_parser')` isn't vendorable -
  `runtime/bindings/httpParser.ts`'s `HttpMessageParser` is a genuinely new, hand-written
  incremental HTTP/1.1 wire-format parser (start-line, flat header pairs, `Content-Length`/
  chunked/close-delimited body framing, keep-alive, pipelining, Upgrade/CONNECT detection),
  wrapped by `runtime/bindings/http.ts`'s `HTTPParser` class to match the numeric callback-slot/
  `ConnectionsList`/`methods` shape real vendored `_http_common.js` expects. HEAD responses and
  1xx/204/304 status codes are given no body regardless of `Content-Length`, implemented directly
  rather than via llhttp's callback-return-value pause protocol (not implemented - unneeded for
  ordinary GET/POST/response handling; an Upgrade/CONNECT is still detected via the parser's own
  "stop at headers" path). Verified in real Chromium for a real client process GETting from a
  real server process (status/headers/body round-tripping) and a real client process POSTing a
  body a real server process streams and echoes back.
- Preview Service Worker relay, plus a real iframe pane wired into the playground UI:
  `wc.preview.enable()` registers a real Service Worker (`workers/preview/PreviewServiceWorker.ts`,
  built to `dist/workers/preview/PreviewServiceWorker.js` - `package.json`'s `"./preview-sw"` export
  already pointed here, a leftover from the old `duckwc` implementation that happened to name the
  right path) that intercepts a same-origin `fetch()` to `wc.preview.url(port, path)`
  (`/__wcvm_preview__/<port>/<path>`) and relays it into whatever real `http.createServer()` a
  script has listening on that virtual port - `kernel/previewRelay.ts` opens one real virtual TCP
  connection per fetch (via the SAME `kernel/netServer.ts` a real process's own `net.connect()`
  uses, under a reserved `PREVIEW_PID = 0` sentinel - never a real pid), writes a hand-encoded
  HTTP/1.1 request, and parses the response with the ALREADY-BUILT `HttpMessageParser`
  (`runtime/bindings/httpParser.ts` - no new parsing logic needed). `wc.preview.onListen(handler)`
  (`src/apis/Preview.ts`, moved here from a top-level `src/preview.ts` to match the existing
  `apis/Fs.ts`/`apis/Process.ts` convention - `IPreviewApi` is now exported from `index.ts` too,
  like `IFs`) fires whenever any guest `net`/`http` server starts or stops listening on a virtual
  port, with no polling: `kernel/netServer.ts`'s `service()`/`unlisten()`/`releasePid()` gained an
  `onListenChange` hook, wired in `kernel/index.ts` to `emit({ type: "net:listen" | "net:unlisten",
  pid, port })` - a new unprompted kernel-worker-to-host push, the same "the kernel worker already
  has a postMessage channel to the host" shape `"ready"`/`"kernel:error"` already use
  (`bridges/bridgeHandler.ts`'s `emit` routes any non-`"kernel-response"` message to
  `kernelBridge.on(type, handler)` listeners). `examples/playground/src/preview.ts` wires this to a
  real `<iframe>` pane (`index.html`'s `#preview-frame`): clicking "enable preview" calls
  `enable()` then `onListen()`, pointing the iframe at `url(port)` the instant a script's `.listen()`
  succeeds, and resetting it to `about:blank` if that same port stops listening.
  - **Real bug found and fixed (Service Worker relay)**: `netServer.connect()` notifies the
    connecting side (`net:connectResult`) BEFORE the listening side (`net:incoming`) - harmless for
    every other caller, where `notify` is always an async `postMessage` to a real process worker,
    so the listener's own notification is already in flight by the time that process could react.
    `PREVIEW_PID`'s own `notify` is a direct, SYNCHRONOUS call (kernel/index.ts) - `previewRelay`
    writing the request immediately raced ahead of `netServer.connect()`'s own still-pending
    `net:incoming` call, so the real server saw `net:data` for a connection it hadn't registered
    yet and silently dropped it. Only surfaced against a REAL listening server, not the
    connection-refused case - fixed with a `queueMicrotask` deferral in `previewRelay.ts`, see its
    comment. A real Chromium e2e test caught this; nothing at the Vitest/fake-net level could
    (the fake net in `previewRelay.test.ts` doesn't reproduce the synchronous-vs-async timing
    difference unless deliberately modeled, which the tests now do explicitly).
  - **Real bug found and fixed (Service Worker relay for a NAVIGATING iframe, as opposed to a
    top-level page's own `fetch()`)**: `respondFromGuest` used to relay through
    `sw.clients.get(event.clientId || event.resultingClientId)` - correct for the top page's own
    `fetch()` (`clientId` IS that page already), but wrong for an `<iframe>` NAVIGATING straight to
    a preview URL: `clientId` is empty for a navigation and `resultingClientId` names a client that
    doesn't exist yet at fetch time for a genuine cross-document load - `clients.get()` on it never
    resolves in real Chromium (a hang, not a hypothetical - confirmed by instrumenting the SW with
    `console.log`, which routes to the SW's own DevTools target, not `page.on("console")`, since a
    dedicated Worker's console output doesn't bubble to a grandchild-of-page target either - only a
    Node-side vendored `console.log` reaching the guest's own stdout, or Playwright's
    `context.on("serviceworker")`, actually surfaces it). Fixed by always relaying through
    whichever client has `frameType === "top-level"` (`sw.clients.matchAll({ type: "window" })`) -
    that's always the wcvm host page itself (an iframe's own browsing context is `"nested"`),
    regardless of whether the request came from that page's own `fetch()` or a preview iframe's
    navigation or its own later subresource fetches.
  - **Real bug found and fixed (COEP blocks the iframe, independently of the above)**: the
    playground's own page needs `Cross-Origin-Embedder-Policy: require-corp` for
    `crossOriginIsolated`/`SharedArrayBuffer` - real Chromium then refuses to embed an `<iframe>`
    whose OWN response doesn't also declare a COEP header, regardless of same-origin-ness
    (`net::ERR_BLOCKED_BY_RESPONSE`). The guest server has no idea it's being iframed into a COEP
    page, so `PreviewServiceWorker.ts`'s `previewResponse()` helper adds
    `Cross-Origin-Embedder-Policy: require-corp` to every response it hands back (success or
    error) - invisible to a plain top-level `fetch()` of the same URL, since that check only
    applies to a nested browsing context's own navigation, which is exactly why the earlier
    fetch()-only preview tests never caught it.
  - **Real bug found and fixed (the actual root cause of a THIRD, harder symptom - a still-mysterious
    `net::ERR_ABORTED` that survived both fixes above)**: `runtime/bindings/net.ts`'s `TCP.close()`
    used `this.port !== null` to decide whether a handle being closed is a *listening server* that
    should be unregistered/unlistened. But an ACCEPTED connection's own handle ALSO gets `.port` set
    to the same virtual port its server listens on, purely for `getsockname()`/`getpeername()`
    reporting (`NetRouter.dispatch`'s `"incoming"` case: `accepted.port = event.port`) - so
    destroying any ONE accepted connection (an ordinary `Connection: close`-style socket end, e.g.
    the preview relay's own one-shot HTTP fetch finishing) silently unregistered and unlistened the
    WHOLE STILL-RUNNING SERVER, `pid`+`port` matching exactly. `preview.ts`'s own `onListen()`-driven
    UI reacted correctly to this: a real `net:listen` event was immediately followed by a real, if
    spurious, `net:unlisten` for the same port - which is what made the iframe's own in-flight
    navigation abort (the UI's own `onListen` handler reset `frame.src` to `about:blank` on the
    bogus "unlisten"). No previous test caught this because every prior `net`/`http`/`preview` test
    either used a single request-response with no reason to notice the listener disappearing
    afterward, or explicitly called `server.close()` itself (where `isListening` was already true
    for the RIGHT reason). Found by exhaustively tracing (stack traces printed via the SANDBOXED
    script's own vendored `console.log`, which reaches real stdout - `page.on("console")` and even
    `worker.on("console")` on the Kernel Worker do NOT surface a nested Process Worker's own
    console output, since it's a worker-of-a-worker, a grandchild target CDP doesn't auto-attach
    to). Fixed with a new `isListening` flag, set true only inside a real, successful `listen()`
    call and checked alongside `port !== null` in `close()`. Regression test:
    `runtime/net.test.ts`'s "destroying an accepted connection does not unlisten the still-running
    server" (verified it actually fails without the fix by temporarily reverting `net.ts` and
    re-running).
  - Also found: Vite's default `assetsInlineLimit` (4 KiB) inlined the built SW file (2.39 KB) as
    a `data:` URL when referenced via `new URL(..., import.meta.url)` from a small enough consumer
    bundle - `navigator.serviceWorker.register()` rejects a `data:` URL (opaque origin). Fixed in
    `examples/playground/vite.config.ts` with `build.assetsInlineLimit: 0`.
  - Playground `vite.config.ts` also updated: `Service-Worker-Allowed: /` now matches any path
    containing `PreviewServiceWorker` (the exact hashed/nested path isn't fixed), replacing the
    stale `duckwc`-era `/dwc-preview-sw.js` middleware; the leftover `examples/playground/public/
    dwc-preview-sw.js` / `dist/dwc-preview-sw.js` build artifacts (both gitignored, unrelated old
    protocol) were deleted.
  - Verified: `kernel/previewRelay.test.ts` (5 Vitest, fake net), `workers/kernel/handlers/
    preview.test.ts` (3 Vitest), `kernel/netServer.test.ts` (6 Vitest, the new `onListenChange`
    hook), `apis/Preview.test.ts` (5 Vitest, `url()`/`onListen()` against a fake kernel bridge), and
    the new regression test above all pass; 4 Playwright tests under `examples/playground/e2e/
    boot.spec.ts` (the original GET round-trip/POST body/502-for-nobody-listening 3, plus a new
    `test.describe("preview UI", ...)` exercising the real iframe end-to-end: click "enable
    preview", spawn a real `http.createServer()`, assert the iframe's `src` and rendered content,
    kill the server, assert the pane resets) all pass. A full, clean `pnpm exec playwright test`
    run (78/78) and `vitest run` (507/507) confirm no regressions.
- Fetcher worker (`wc.fs.fetch(url, path)`, Phase 7's first piece): a dedicated, persistent worker
  (`workers/fetcher/worker.ts`, one for the kernel's whole lifetime - not one per request, like the
  FS Worker) doing real `fetch()` calls, capped at 10 in flight at once (`MAX_CONCURRENT` in
  `workers/fetcher/fetcherRuntime.ts`, a plain bounded-concurrency queue - real overlap comes from
  several concurrent `fetch()` promises on ONE thread, not OS parallelism, so no pool of worker
  threads was needed), each response streamed straight into the VFS via the SAME fd-based
  open/write/FD_CHUNK-split/close path `fs.writeFileSync` itself uses, rather than buffered whole
  in memory first. Architecturally mirrors the FS Worker exactly: the Fetcher Worker gets its own
  real fs client (a SharedArrayBuffer + MessageChannel pair registered with the FS Worker via
  `kernel/index.ts`'s `attachFsClient` - now factored out as a small shared function, reused by
  both a real process's own client and this one - under a reserved `FETCHER_FS_CLIENT_ID = -1`,
  never a real pid, the same idea as `PREVIEW_PID`), and boot awaits its own "ready" before
  completing, the same "must not park on a SAB before its nested worker is up" rule the FS Worker's
  boot already follows. `kernel/fetcher.ts` is the kernel-side half: turns one `wc.fs.fetch()` call
  into one `{type:"fetch", id, url, path}` postMessage and a promise resolved/rejected by the
  matching `fetch:done`/`fetch:error` reply (an id-keyed pending-map, the same one-shot-async-op
  shape `previewRelay.ts` already uses). Rejects (without writing `path`) on a non-2xx response
  (`code: "EHTTP<status>"`) or a real network error; like `writeFile`, does not create `path`'s
  parent directories. `workers/fetcher/fetcherRuntime.ts` is kept free of `self` (fetch/fs client
  are injected) so its queueing/streaming/chunking logic is fully Vitest-testable, mirroring
  `workers/process/run.ts`'s own split between testable core and thin `self.onmessage` wiring.
  Verified: `fetcherRuntime.test.ts` (6 Vitest: success/non-2xx/network-error/no-body/chunk-split/
  concurrency-cap, the last using a manually-resolved fetch mock to prove the cap holds even when
  more requests are queued than it allows), `kernel/fetcher.test.ts` (4 Vitest), `workers/kernel/
  handlers/fetcher.test.ts` (3 Vitest), and 5 new `kernel/index.test.ts` cases (boot/dispose/
  fetch-routing, mirroring the existing per-process fs client tests) all pass; 2 Playwright tests
  (a real same-origin fetch into the VFS matching a plain `fetch()` of the same URL, and a real
  connection refusal that rejects without writing the destination) - neither a real fetch() from
  inside a dedicated Worker nor a real cross-worker SAB write can be exercised outside Chromium.
  A full, clean `pnpm exec playwright test` run (80/80) and `vitest run` (523/523) confirm no
  regressions from adding a worker every boot now depends on.
- OPFS persistence (Phase 7's second piece): `boot({ persist: true | { root: string } })` mirrors
  `wc.fs.*` to the real Origin Private File System, write-behind, and restores from it before the
  FS Worker ever serves its first syscall - must be decided at boot, so it's a `boot()` option, not
  a post-boot `enable()` (unlike preview/fetch, which don't need that guarantee). `true` uses a
  default root name (`"wcvm"`); an explicit `root` keeps two wcvm instances on the same origin
  (different demos, or just two tabs) from sharing storage unless they deliberately choose the same
  one. `fs/opfsPersistence.ts` has both directions, kept free of `self`/any real OPFS global (a
  hand-picked subset of the real `FileSystemDirectoryHandle`/`FileSystemFileHandle` API is typed
  locally, so a fake in-memory implementation can stand in for Vitest - OPFS doesn't exist under
  Node): `restoreFromOpfs(vfs, root)` walks OPFS once, before `FsServer` is even constructed (so
  the write-behind mirror, wired up only afterward, never turns around and writes straight back
  what it just read). `createOpfsMirror(vfs, root)` becomes `FsServer`'s new third constructor
  param (`onPersist`, called from the SAME `vfs.onChange` closure watch dispatch already uses -
  `FsServer` itself still knows nothing about OPFS, it just forwards the raw change events) -
  write-behind means answer the syscall first, mirror after; each change re-syncs its own path
  (mirrors a file, or - to correctly handle a non-empty directory rename in one step - recursively
  re-mirrors a whole directory's subtree) against a SERIALIZED queue (`chain.finally(...)`, one
  change at a time, in the order they actually happened - otherwise two quick writes to the same
  path could race and leave OPFS with an OLDER result than the vfs's own current one). OPFS has no
  symlinks, so a script's own symlinks are simply not persisted (a documented simplification - real
  npm installs, the main reason for this feature, mostly don't need them for what actually has to
  survive a reload). `workers/fs/worker.ts` gained the same "init" -> (async work) -> "ready"
  handshake the Fetcher Worker already has (previously it posted "ready" unconditionally, at
  import time, with no handshake at all - fine for a purely in-memory Vfs, not once restoring from
  OPFS needs to happen first) - `kernel/index.ts` now posts `{type:"boot", persist}` before
  awaiting it, same ordering as everywhere else this pattern is used.
  Verified: `fs/opfsPersistence.test.ts` (11 Vitest against a fake OPFS directory handle -
  restore, mirror-on-write/mkdir/delete/directory-rename, write-ordering, symlinks skipped, a
  failed persist not blocking later ones), plus new/updated `kernel/index.test.ts`,
  `workers/kernel/handlers/boot.test.ts` and `boot.test.ts` cases covering the `persist` option's
  path from `boot()` down to the exact message the fs worker receives. 2 Playwright tests (a file
  written with `persist` enabled survives a REAL `page.reload()`; a file removed before reload
  does not come back) - neither a real `navigator.storage.getDirectory()` nor a real page reload
  reading back a PREVIOUS load's writes can be exercised outside Chromium. The playground's
  `main.ts` now also exposes `window.wcvmBoot` (the `boot` function itself, not just its own
  default no-persist instance) so a test can boot an independently-configured second instance
  without disturbing the page's own. A full, clean `pnpm exec playwright test` run (82/82) and
  `vitest run` (539/539) confirm no regressions from a boot handshake every existing test also now
  depends on (even with `persist` never set).
- `zlib` (Phase 7's third piece, and the first of real npm's two missing-builtin blockers resolved
  - see PLAN.md's "Real npm: feasibility findings"): Node's real vendored `lib/zlib.js`, unmodified,
  over `internalBinding('zlib')` (`runtime/bindings/zlib.ts`) backed by the browser's real, native
  `CompressionStream`/`DecompressionStream` - not a WASM/pure-JS zlib port. Covers
  `Deflate`/`Inflate`/`Gzip`/`Gunzip`/`DeflateRaw`/`InflateRaw`/`Unzip`: the streaming `Transform`
  classes (`zlib.createGzip()` etc., pipeable) and the convenience functions (async callback,
  promisified, and the blocking `*Sync` family), plus `zlib.crc32()`. Brotli/Zstd aren't
  implemented - the Compression Streams API supports neither format - and true mid-stream flush
  (`.flush()`/`Z_SYNC_FLUSH`/...) is a no-op, since that API only offers `close()` (ends the stream
  for good), not "flush and stay open"; see PLAN.md's "Known differences" for the full list
  (including `windowBits`/`memLevel`/`strategy`/`dictionary` being accepted but ignored).
  - **Key design simplification**: real zlib's own C streaming API (`avail_in`/`avail_out`, many
    small calls each draining a bounded output buffer) has no equivalent in the Compression Streams
    API anyway (push bytes in, read whatever's ready, close to finish) - and every real caller that
    matters here (a piped `Transform`, and the `*Sync` functions) only truly needs output once the
    whole input is known. So the `Zlib` class accumulates every input chunk across calls and only
    actually runs `CompressionStream`/`DecompressionStream` **once**, on a finish-flagged call
    (`runZlibOnce(format, direction, wholeInput)`, a small shared, stateless codec core also used by
    the sync path below) - write the whole thing, close, drain the reader fully. That single result
    is handed out across possibly-multiple `write()`/`writeSync()` calls, bounded by each call's own
    `out_len`, which is exactly the "not done, call me again" loop the *unmodified* vendored
    `zlib.js` (`processCallback` for async, `processChunkSync` for sync) already drives - the
    binding only reports `state[0]`/`state[1]` honestly and, for async, invokes the real
    `processCallback` captured at `init()` time, the same "implement the low-level step, let
    vendored JS own the state machine" split `httpParser.ts` already used. Trade-off: output arrives
    once, on finish, not dribbled out per chunk - fine for whole-package-sized data.
  - **Sync path**: `Atomics.wait`-blocking the caller while also `await`-ing a Promise on the same
    thread is a deadlock, so `*Sync` needs a second real thread - the same problem `execSync`/
    `spawnSync`/`net.listen()` already solved. Unlike `net.listen()`, zlib has no cross-process
    state to coordinate, so rather than a fourth per-process SAB it reuses the existing sync one
    (`protocols/syscall.ts`'s new `OP_ZLIB_SYNC = KERNEL_OPCODE_MIN + 2`, alongside
    `OP_SPAWN_SYNC`) - `kernel/spawnSyncServer.ts` was renamed `kernel/kernelSyncServer.ts`
    (`createKernelSyncServer`) since it now dispatches between two unrelated blocking capabilities
    by opcode, and its `serviceZlibSync` runs `runZlibOnce` directly in the Kernel Worker's own
    realm (`CompressionStream` is an ordinary Worker global there too), `respondOk`/`respondErr`-ing
    once the promise settles - the same "service() kicks off async work, responds later" shape
    `OP_SPAWN_SYNC` already has via `onExit`.
  - **Two real bugs found and fixed, both only surfaced by an actual Gzip→Gunzip pipe** (not by
    `runZlibOnce`'s own direct tests, nor the sync path): `drain()` used to unconditionally reassign
    `this.pendingOutput` (via `?? new Uint8Array(0)`) even on the "just buffering, nothing computed
    yet" branch - turning `null` ("nothing computed") into a merely-empty-but-non-null array the
    very first time it ran, which is exactly the signal `write()`/`writeSync()` use to decide
    whether the whole-buffer compression has already happened. This made the real FINISH-flagged
    call silently take the "already computed, just drain" branch instead of ever calling
    `runZlibOnce` at all - `gz.end(str)` quietly produced zero bytes, and `gunz` failed to
    decompress an empty finish-only call ("incorrect header check"). Fixed by leaving
    `pendingOutput` untouched when it started `null`. Separately: on a `runZlibOnce` rejection, the
    async path called `this.fail(error)` (routing to `onerror`/`self.destroy(error)`) but then let
    the promise chain continue on to *also* drain/report state/invoke `processCallback` for the same
    failed operation - real Node's native binding treats success and failure as mutually exclusive
    outcomes for one write, and doing both left a `zlib.gunzip()` callback seeing neither a clean
    error nor a clean result. Fixed with a two-armed `.then(onSuccess, onFailure)` instead of a
    `.then().catch().then()` chain. Neither bug was catchable testing `runZlibOnce` in isolation (no
    state to get confused) or via the sync path (whose caller throws immediately on error, before
    ever consulting post-error state) - only a real multi-call streaming sequence through a real
    vendored `Transform` pair exercises the exact call pattern that exposed them.
  - Also found, testing-environment-only (not a bug in this code): under plain Node/Vitest, Node's
    own global `DecompressionStream` is itself a shim over Node's own native `zlib` Gunzip stream
    (`node:internal/webstreams/adapters`) - a malformed-input rejection there can surface as a
    process-level unhandled-rejection warning if nothing has attached a handler to the internal pump
    promise yet, purely an artifact of Node's own polyfill's internal timing (a real browser's
    `DecompressionStream` is a native, unrelated implementation). Fixed defensively in `runZlibOnce`
    with a same-tick no-op `.catch()` on the pump promise, independent of when the real, still
    -propagated rejection is actually awaited.
  - Verified: `runtime/bindings/zlib.test.ts` (12 Vitest - `runZlibOnce` round-trips and
    malformed-input rejection directly against Node's own real `CompressionStream`/
    `DecompressionStream`; the streaming/callback/`util.promisify`/`Unzip` auto-detect/error paths;
    the `*Sync` path against a fake `spawnSync` client backed by Node's own `zlib` module, same
    "prove the wire protocol, not the real servicer" spirit `spawnSync.test.ts`'s own fake already
    established; `crc32` against known vectors and Node's own output), `kernel/
    kernelSyncServer.test.ts`'s new `OP_ZLIB_SYNC` cases. 2 new Playwright tests in real Chromium (a
    streaming `createGzip()`/`createGunzip()` pipe round trip; a `gzipSync`/`gunzipSync` round trip
    proving the real kernel-mediated blocking path) - neither the real native browser
    `CompressionStream` nor the genuine cross-thread `Atomics.wait` blocking path can be exercised
    outside Chromium. A full, clean `pnpm exec playwright test` run (85/85) and `vitest run`
    (553/553) confirm no regressions.
- `crypto` (hashing only, Phase 7's fourth piece, and the second of real npm's two missing-builtin
  blockers resolved - see PLAN.md's "Real npm: feasibility findings"): unlike almost everything
  else in this sandbox, **not vendored source** - real Node's own `crypto.js` unconditionally
  requires ~15 internal modules just to be `require()`-able at all (cipher, sig, hash, x509,
  certificate, kem, webcrypto, random, argon2, pbkdf2, scrypt, hkdf, keygen, keys,
  diffiehellman), most needing native-crypto features (KeyObject/PEM export, X.509 certificates,
  DiffieHellman groups, scrypt, argon2) the Web Crypto API has no equivalent for at all - a
  vendoring job far bigger than real npm's own actual need (sha512/sha1 package integrity checks)
  justifies. Scoped down to hashing only with the user first (offered as one of three options - a
  narrow hand-written shim, full vendoring plus binding stubs for the whole surface, or resolving
  the harder real-internet-access question before touching crypto at all - the narrow shim won).
  `runtime/shims.ts`'s `cryptoShim` is a small hand-written module, in the same "deliberately
  simplified real module" category `dns`/`cluster` already are there: `createHash`/`Hash`
  (`.update()`/`.digest()`, chainable, matching real Node) backed by the real, native
  `SubtleCrypto.digest()` via a new `internalBinding('crypto')` (`bindings/crypto.ts`) - only
  SHA-1/256/384/512, exactly what `SubtleCrypto.digest()` itself supports (no md5/sha224/sha3-*/
  blake2*) - plus `randomBytes`/`randomUUID`, backed directly by the real
  `crypto.getRandomValues()`/`crypto.randomUUID()` globals (already synchronous, no bridging
  needed at all, unlike digest). `Hash.digest()` is synchronous but `SubtleCrypto.digest()` isn't,
  so digest needs the exact same kernel-mediated sync bridge `zlib`'s own `*Sync` family already
  uses - a new `OP_CRYPTO_DIGEST_SYNC` opcode (`protocols/syscall.ts`), serviced by `kernel/
  kernelSyncServer.ts` right alongside `OP_SPAWN_SYNC`/`OP_ZLIB_SYNC` on the same shared SAB (no
  cross-process state to coordinate here either, same reasoning as zlib's own sync path). The
  stray `crypto.js`/`manifest.json`/`registry.ts`/`vendor.lock.json` edits an earlier exploratory
  `discover-node-lib.mjs crypto` run left behind (it fetches the file and updates those three
  before probing whether the module can actually load, which is where it failed here with `Node.js
  is not compiled with OpenSSL crypto support`) were reverted - this module is deliberately NOT
  going down the real-vendoring path. Everything else real npm doesn't need (ciphers,
  DiffieHellman, X.509 certificates, KeyObject, ...) is simply absent - the same honest "not a
  function"/"not a constructor" failure shape `zlib.ts`'s own missing Brotli/Zstd support already
  has. Verified: `bindings/crypto.test.ts` (7 Vitest, against a fake `OP_CRYPTO_DIGEST_SYNC`
  servicer backed by Node's own `crypto.createHash` - proves the wire protocol, the same spirit
  `zlib.test.ts`'s own fake already established - including a known SHA-256 vector, chunked
  `update()` calls matching one big call, and a clear error for an unsupported algorithm),
  `kernel/kernelSyncServer.test.ts`'s new `OP_CRYPTO_DIGEST_SYNC` cases (a real digest via
  `SubtleCrypto.digest()`, since Node has it globally too). 2 new Playwright tests in real
  Chromium (a `createHash('sha512')` digest cross-checked against Node's own `crypto.createHash`
  for the same input; `randomBytes`/`randomUUID` producing real, distinct values) - the real
  browser `SubtleCrypto`/`crypto.getRandomValues()` can't be exercised outside Chromium. A full,
  clean `pnpm exec playwright test` run (87/87) and `vitest run` (562/562) confirm no regressions.
- `dgram` (real UDP): Node's real vendored `lib/dgram.js`/`internal/dgram.js`, unmodified, over a
  real `internalBinding('udp_wrap')` (`runtime/bindings/udp.ts`), mirroring `tcp_wrap`'s own "no
  real sockets, relay through the kernel" design but connectionless - just `bind()` (claim a port)
  and `send()` (fire-and-forget to whoever, if anyone, is bound to the destination port; a real OS
  UDP socket drops silently when nobody's listening, so this does too). UDP and TCP are separate
  port namespaces (`kernel/netServer.ts`'s own separate `udpBindings` map/ephemeral allocator, the
  same file that already hosts TCP's `listeners`). Real `dgram.js`'s own `bind()` calls
  `state.handle.bind()` SYNCHRONOUSLY and returns its error code directly (unlike TCP, where the
  port-conflict check is deferred to `listen()` specifically) - so `bind()` needs the exact same
  globally-coordinated, kernel-mediated answer `OP_NET_LISTEN` gives TCP; rather than a new
  per-process SAB, it reuses that one under a new opcode (`OP_UDP_BIND`) - `kernel/netServer.ts`'s
  `service()` now dispatches between the two by opcode, same "one shared SAB, multiple unrelated
  opcodes" shape `kernel/kernelSyncServer.ts` already established. Only udp4 (`bind6`/`connect6`/
  `send6` fail `EAFNOSUPPORT`, matching `tcp_wrap`'s own IPv6 stance); multicast/broadcast are
  accepted no-ops (nothing for either to mean in a single virtual host). `handle.lookup` needed no
  new work: real `internal/dgram.js`'s own `newHandle()` already binds it straight to the
  already-shimmed `dns.lookup()`.
  - **Real bug found and fixed**: an incoming datagram's `onmessage` callback was handed a plain
    `Uint8Array`, not a real (sandbox) `Buffer` - real Node's native binding constructs one before
    ever calling into JS, but `dgram.js`'s own `onMessage(nread, handle, buf, rinfo)` just re-emits
    `buf` as-is with no wrapping step of its own, so this binding has to do that wrapping itself.
    Symptom: `msg.toString()` in a guest `'message'` handler printed comma-joined byte values
    (`TypedArray.prototype.toString`'s own inherited join behavior) instead of decoding text.
    Fixed in `UdpRouter.dispatch()` with the sandbox's own vendored `Buffer.from(...)` (via
    `requireBuiltin("buffer")`, the same pattern `childProcess.ts`'s exec()/execFile() output
    already uses) before handing the chunk to `onmessage`. Caught by a quick manual smoke test
    with a real `.toString()` call, before any formal test coverage was even written.
  - Verified: `runtime/udp.test.ts` (6 Vitest), `kernel/netServer.test.ts`'s new UDP cases (6). 4
    new Playwright tests in real Chromium (a real client sending a datagram to a real server which
    echoes it back; `bind(0)` auto-assigning different real ports across two processes; a real
    `EADDRINUSE` for a second bind; a datagram to an unbound port being silently dropped, not a
    hang) - the actual cross-Process-Worker postMessage relay can't be exercised in the
    single-threaded Vitest suite. A full, clean `pnpm exec playwright test` run (91/91) and
    `vitest run` (574/574) confirm no regressions.
- Tests: 574 Vitest + 91 Playwright (Chromium). See "Verifying".

Not done (roadmap order, see PLAN.md): DNS (`dns.lookup()` is a fixed-address shim, low-value in a
single virtual host with no real network to resolve a name against), real `npm` (investigated and
DEFERRED - its fetch
stack has no path to a real network from inside wcvm's virtual `net`/`http`, confirmed by reading
the actual installed source; see PLAN.md's "Real npm: feasibility findings" before picking this
back up), Vite dev server/HMR, Python/Bun, Studio UI.

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
- The process worker bundle is ~1.9 MB (acorn added real weight for ESM parsing, and vendored
  `zlib.js` some more) and every process parses it, even `echo`; split `node` into its own worker
  entry if startup cost matters.

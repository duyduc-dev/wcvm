# wcvm - detailed implementation history

This is the detailed, per-feature implementation history that used to live in CLAUDE.md's
`## Status` section, moved here once CLAUDE.md grew past the `/memory` editor's 150k-char
limit. CLAUDE.md now keeps only a short capability inventory; this file has the full story for
each one - design rationale, and every real bug found (in real Chromium, not just Vitest) along
the way, with its exact root cause, fix, and the tests that pin it down. Read the relevant
section here before touching that area, or before re-deriving a "why is this built this way"
that was probably already answered by a real bug.

Sections, in build order:
1. [Core sandbox runtime](#1-core-sandbox-runtime) - boot, processes, built-in programs, `sh`,
   `node` script execution, ESM, the REPL, `execSync`/`spawnSync`, `fork()`/IPC, `fs.watch`,
   `net`, `http`.
2. [Preview relay + OPFS persistence](#2-preview-relay--opfs-persistence).
3. [zlib, crypto, dgram, worker_threads](#3-zlib-crypto-dgram-worker_threads).
4. [The Vite dev-server pipeline](#4-the-vite-dev-server-pipeline) (Phase 8, part 1).
5. [npm run, playground examples, npm create](#5-npm-run-playground-examples-npm-create)
   (Phase 8, part 2).

## 1. Core sandbox runtime

- Boot handshake, kernel worker, File System Worker (in-memory `Vfs`), `wc.fs.*`, `mount`.
- Real processes: one Web Worker per PID, own SAB + doorbell port, stdout/stderr/stdin streams,
  `kill`. `stdin` is a real open pipe (out-of-band via `postMessage`, never the SAB): open until
  the host closes it or the process exits, and only refs the event loop while actually being
  read (`resume()`/a `'data'` listener) - a script that never touches it still exits on its own.
  Killing (or the natural exit of) a process kills its whole subtree: a `child_process` with no
  live parent left would otherwise strand a Process Worker in the tab forever (`detached` is
  accepted but not honoured, so there is no opt-out yet).
- Built-ins: `echo cat ls pwd mkdir rm sleep clear true false node sh npm` (`clear` just writes the
  standard ANSI erase-display/home-cursor sequence - `\x1b[2J\x1b[3J\x1b[H` - there's no TTY/
  terminfo database here to shell out a real `clear` to; any ANSI-compatible consumer of stdout,
  xterm.js included, renders it as a real clear). `cat` with no args streams real
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
  `readline`, `readline/promises`, `url`, `querystring`, `tty`, `perf_hooks`, `process`,
  `child_process.spawn`/`exec`/`execFile` (real Node code; a
  child is another real Process Worker the kernel supervises - see `kernel/processes.ts`'s
  `parentPid` and `runtime/bindings/childProcess.ts`). `child.stdin.write()`/`.end()` deliver for
  real, over the same stdin plumbing as top-level processes.
- ESM (`import`/`export`, `runtime/esm/`): real ESM via the browser's own `import()` of `blob:`
  URLs, not a CJS transpile - we resolve the static import graph and rewrite specifiers
  ourselves, but the browser does the actual linking/live-bindings/top-level-await. A `node:`
  builtin or plain CJS file imported from ESM gets a synthetic default+named-export wrapper; a
  genuinely circular static import throws `ERR_CIRCULAR_ESM_NOT_SUPPORTED` (a dynamic `import()`
  breaks the cycle instead). See PLAN.md "Current state" and "Known differences"
  (`import.meta` is rewritten to the module's REAL `file://` URL/filename/dirname/resolve - see
  the `import.meta` Status entry below).
  - **Two real ESM-loader bugs found while adding new "Start from template" frameworks to
    `apps/studio`** (Preact/Lit/Solid/Qwik/TanStack Router/Static/Bootstrap 5, alongside the
    existing React/Vue/Vanilla/Rectify - a completely different app from `examples/playground`,
    but the bugs themselves are generic runtime bugs, not Studio-specific, and would hit any app
    spawning `node`/`vite` against the same real npm packages). Both surfaced as the exact same
    symptom - a bare, stackless `SyntaxError: Unexpected token 'import'` with no indication of
    which module - because the invalid syntax lived in a SYNTHESIZED string this sandbox itself
    builds at runtime, not in any real file on disk, so `parseModule`'s own try/catch (which
    reports `"<filename>: <message>"`) never got a chance to run and localize it.
    1. **Preact**: `@preact/preset-vite`'s `transform-hook-names.mjs` loads `zimmerframe` (an
       ESM-only dep) via `const importEsm = new Function("specifier", "return
       import(specifier)");` then `importEsm("zimmerframe")` - a real, documented npm-ecosystem
       idiom (the package's own comment: "Keep zimmerframe loading as a native dynamic import even
       in the CommonJS build. TypeScript rewrites `import()` to `require()` when compiling CJS").
       `import(specifier)` inside a string passed to the `Function` constructor is completely
       invisible to `dynamicImportCalls`'s AST walk of the ENCLOSING file - it's not a syntactic
       `ImportExpression` there at all - so it reached the browser's own native `import()`
       entirely unrewritten, which can't resolve a bare specifier with no import map, and threw
       exactly the error this idiom exists to prevent. Fixed by recognizing this exact shape at
       parse time (`ast.ts`'s `nativeDynamicImportFunctions`: a `new Function(...)`/`Function(...)`
       call whose last argument is a string that, RE-PARSED as its own function body, contains a
       dynamic import of one of the declared parameters) and rewriting the whole call to an arrow
       function that calls the real dynamic-import bridge directly (`rewrite.ts`) - a bound
       closure, not a re-parsed string, so nothing stays hidden from it. `rewriteModule` grew an
       optional `acorn` parameter for this (both `loader.ts` call sites now pass it), so it also
       covers a CJS module using the same idiom (`rewriteScript`'s existing dynamic-import
       rewriting shares the same function).
    2. **Solid**: `vite-plugin-solid`'s own `vite.config.ts` failed even earlier - "failed to load
       config", not a runtime transform error - tracked down (by patching a debug `fs.writeFile`
       into vite's own vendored `bundleConfigFile`/`loadConfigFromBundledFile`, then bisecting
       which single import broke by loading each of `vite-plugin-solid`'s direct dependencies
       standalone via `node -e "import('<pkg>')"` in a real terminal) to `@babel/types`, reached
       transitively through `solid-refresh/babel` -> `@babel/generator` -> `@babel/types`.
       `@babel/types` is CommonJS (no `"exports"` field, `"type": "commonjs"`) and genuinely
       exports a property named `import` (its real AST-builder for the `Import` node type, e.g.
       `t.import(...)`) - a real, long-standing part of Babel's public API, confirmed to have zero
       "import" substring anywhere in its own source tree (the giant list of exported names near
       the end of a modern `@babel/types` build is what makes this property easy to have and easy
       to miss). `esm/loader.ts`'s `namedReexports` - the CJS-to-ESM interop shim `prepare()`
       builds from a REQUIRED module's OWN enumerable keys at runtime, one `export const <key> =
       ...` per key - filtered candidate keys only by `IDENTIFIER.test(key)` (do the characters
       LOOK like an identifier), never checking whether `key` is a RESERVED WORD, so it happily
       emitted `export const import = __read("import");` - a hard syntax error, since `import` is
       a reserved word as a BINDING identifier even though it's a perfectly legal EXPORTED name
       (real Node's own require()-from-ESM interop never hits this, since it only ever creates a
       NAMESPACE property, never a bare top-level binding). Fixed with a static `RESERVED_WORDS`
       set (every ECMAScript keyword plus the strict-mode-only reserved words and `await`, reserved
       at a module's own top level): a reserved-word key is now emitted as `const
       __reserved_export_N = __read("import"); export { __reserved_export_N as import };` instead
       - same externally-visible name, valid binding underneath. `namedReexports` is now exported
       from `loader.ts` for direct unit testing (`loader.test.ts`) - everything else in that file
       needs a full fs-client/acorn/event-loop context to exercise, but this one piece is pure
       string-in/string-out.
    Both fixes verified two ways: `rewrite.test.ts`/`loader.test.ts` (Vitest, exact-string
    assertions on the rewritten output, one round-trip test that re-parses the rewritten shim as
    real ESM), AND live in real Chromium - a fresh `preact-ts`/`solid-ts` project through the
    Studio template picker, `npm run dev`, and the real dev-server preview: Preact's own
    `useState`-based counter and Solid's own signal-based counter both increment for real.
    - **Qwik was also attempted, hit a different, NOT YET DIAGNOSED problem, and was left for a
      later session** (unlike Svelte's PARKED writeup above, this one isn't resolved either way
      yet - revisit before assuming either the symptom or the cause below is still accurate). Its
      dev server printed `Unable to load native binding qwik.linux-x64-gnu.node. Falling back to
      wasm build. Invalid or unexpected token`, which LOOKS fatal but isn't: calling
      `@builder.io/qwik/optimizer`'s own `createOptimizer()` directly (`node -e`, standalone,
      outside Vite entirely) prints the exact same warning and then still resolves successfully -
      Qwik's own native-binding-then-wasm-fallback sequence is designed to warn and recover, and
      does, in this sandbox as much as anywhere else. The dev server's real, fatal error came
      after: `[plugin:vite-plugin-qwik] context method emitFile() is not supported in serve mode.
      This plugin is likely not vite-compatible` - `emitFile()` is a real, build-time-only Rollup
      plugin-context API; Vite's own (real, vendored, unmodified) dev-mode plugin container
      deliberately doesn't support it, and this warning string is Vite's OWN, not something this
      sandbox generates. Not yet determined whether `vite-plugin-qwik`'s plain `qwikVite()` calling
      it during `serve` is a genuine upstream Qwik/Vite dev-mode incompatibility (in which case
      real Vite outside this sandbox would hit the exact same thing) or something specific to how
      this sandbox's own Vite dev server invokes plugin hooks - needs checking against a real,
      non-sandboxed `npm create vite@latest -- --template qwik-ts` + `npm run dev` before doing
      any more work here.
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

## 2. Preview relay + OPFS persistence

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
- `wc.fs.sync()`: resolves once OPFS persistence (if enabled) has actually caught up with every fs
  change so far - closes a real, confirmed data-loss race in the write-behind mirror above, found
  investigating a Studio bug report ("packages aren't installed anymore after a reload"). The
  mirror is entirely fire-and-forget from the outside: a caller has no way to know when it's
  actually safe to reload/navigate away without losing whatever hasn't landed in OPFS yet.
  Reproduced directly, not just suspected: a real two-file npm install (`is-odd`), followed
  IMMEDIATELY by `page.reload()` with zero artificial delay, lost one of the two files - the exact
  shape of what a user hits clicking away or reloading the instant a "Done" toast appears.
  `fs/opfsPersistence.ts`'s `createOpfsMirror` now returns `{ notify, flush }` instead of a bare
  function (`notify` is the same write-behind callback as before, wired to `Vfs.onChange`; `flush()`
  returns the mirror's own current queue tail, resolving once every `notify()` call queued so far
  has settled - a later `notify()` starts a NEW tail that flush doesn't need to wait for, which is
  correct: "everything so far", not "forever"). Plumbed the same way every other kernel <-> FS
  Worker unprompted event already is: `workers/fs/handler.ts` gained a `{type: "flushPersistence",
  id}` request the FS Worker always answers with a matching `{type: "flushPersistence:done", id}`
  reply (even with no mirror at all - persist wasn't enabled - so a caller waiting on it never
  hangs); `kernel/persistenceFlusher.ts` is the kernel-side id-keyed promise map, the same
  one-shot-async-op shape `kernel/fetcher.ts` already established; `workers/kernel/handlers/fs.ts`
  registers `"fs:sync"` calling `kernel.flushPersistence()` directly (not an `IFsClient` op - there's
  no such syscall, same reasoning `"fetcher:fetch"` already has for not being one either);
  `apis/Fs.ts` exposes it as `fs.sync(): Promise<void>`. Wired into all three of Studio's own
  project-creation flows (`blankTemplateProject.ts`/`viteTemplateProject.ts`/
  `rectifyTemplateProject.ts`) right before reporting success, so "project created" now genuinely
  means "safely durable" - the actual fix for the reported bug. Verified: `fs/
  opfsPersistence.test.ts`'s 2 new cases (`flush()` waits for real queued writes with no arbitrary
  delay; `flush()` never rejects even when a queued write failed), `workers/fs/handler.test.ts`'s 2
  new cases (a real flush()-then-reply round trip; a silent no-op with no persistence configured),
  `kernel/persistenceFlusher.test.ts` (3 Vitest, mirroring `kernel/fetcher.test.ts`'s own shape),
  `workers/kernel/handlers/fs.test.ts`'s new case, `apis/Fs.test.ts`'s updated case. 1 new
  Playwright test reusing the exact repro above but with `wc.fs.sync()` inserted before the reload
  (opt-in, `WCVM_E2E_VITE=1` - needs a real npm install) - confirmed the file count survives
  intact; commented in the test that removing the `sync()` call reproduces the loss again, the same
  way the OPFS write-ordering regression test already documents its own "verified to actually fail
  without the fix" check. A full, clean `pnpm exec playwright test` run (122 passed, 8 opt-in
  skipped) and `vitest run` (907/907) confirm no regressions.
- OPFS persistence for symlinks: a SEPARATE bug from `wc.fs.sync()` above, found from the same
  Studio report followed further - `npm run dev` worked, a reload happened, and the next
  `npm run dev` failed with a plain `sh: vite: command not found`, even with `sync()` already
  called. Root cause confirmed directly: OPFS has no symlinks at all, so npm's own bin-linking
  (`node_modules/.bin/vite`, a real symlink) was NEVER mirrored in the first place - not a timing
  race `sync()` could fix, a structural gap (previously a documented, but wrong-in-practice,
  simplification: "real npm installs create very few symlinks"). Reproduced directly: installed a
  package with a real bin, confirmed the bin was a symlink, called `sync()`, reloaded - the
  PACKAGE's own files survived, but the bin symlink was gone. Fixed in `fs/opfsPersistence.ts` with
  a small side-channel manifest (`__wcvm_symlinks__.json`, one JSON file of `{path: target}` pairs
  directly under the OPFS root, outside the vfs's own mirrored tree so it never shows up in
  `wc.fs.readdir("/")`): `resyncSubtree` now records a symlink into the manifest instead of
  silently skipping it (both when the changed path IS the symlink, and when one is found while
  walking a directory's children during a subtree resync, e.g. a rename); a path's removal (or a
  removed directory's whole subtree) drops any manifest entries at or under it; `restoreFromOpfs`
  replays every manifest entry as a real `vfs.symlink()` call once the normal file/directory walk
  finishes (directories/files must already exist for a symlink to usefully point at) - a symlink
  whose own path is somehow already occupied (a theoretical case, not a real npm one) is logged and
  skipped rather than failing the whole restore. Verified: `fs/opfsPersistence.test.ts`'s 3 new
  cases (a real npm-bin-shaped symlink survives a fresh restore, byte-for-byte target and
  `lstat().kind`; removing a symlink drops it from what's restored; renaming a directory carries
  its nested symlink to the new location, not the old one) plus the existing "does not mirror a
  symlink as an OPFS file entry" test (still true - only the wording changed, since it's now
  tracked separately rather than not tracked at all). 1 new Playwright test (opt-in,
  `WCVM_E2E_VITE=1`): a real `npm install` of a package with a real bin, confirmed to be a symlink,
  survives a real reload, and the bin file GENUINELY RUNS afterward (through `sh`, the same way
  `npm run <script>` would reach it) - not just that `lstat()` still reports "symlink". A full,
  clean `pnpm exec playwright test` run (122 passed, 9 opt-in skipped) and `vitest run` (910/910)
  confirm no regressions.
- OPFS persistence's write-behind mirror was slow: `wc.fs.sync()` after a real npm install could
  take many seconds. Found and fixed in two layers, each confirmed with real before/after timing
  (not just "should be faster" - 33 files installed by a real `npm install cowsay is-odd chalk`):
  - **Cross-path concurrency (`createOpfsMirror`'s own queue)**: the mirror used ONE global
    `chain`, so every changed path - across entirely unrelated files/packages - was mirrored to
    OPFS strictly one at a time, even though only repeated changes to the EXACT SAME path actually
    need that ordering (two quick writes to `/a.txt` racing could otherwise leave OPFS with an
    older result than the vfs's own current one - the ONLY reason the ordering guarantee exists).
    Replaced the single `chain` with a `Map<path, Promise>` (`pathChains`) - each path gets its own
    small serial queue, dropped once it drains; different paths now mirror concurrently. The
    symlink manifest (a SINGLE shared file every symlink-affecting path reads-modifies-writes) is
    the one exception: it keeps its own separate serial queue (`manifestChain`) regardless of how
    many different paths trigger it now, or two concurrent updates could each read the same stale
    manifest and clobber each other. 33 files: 11.8s -> 5.4s (~2.2x).
  - **Directory-handle caching (`createDirHandleCache`)**: even with cross-path concurrency, 33
    files 3 directories deep (the realistic npm shape - many files sharing a few package
    directories) took over 20x longer than the same 33 files flat at the root, everything else
    identical - confirmed directly, not assumed. Root cause: every single file mirror re-walked
    (`getDirectoryHandle` round trip per segment) its own FULL ancestor path from the OPFS root,
    even though sibling files under the same directory redundantly re-resolve the exact same
    handles over and over. Fixed with a small in-memory cache, scoped to one mirror's lifetime,
    memoizing the PROMISE (not just the eventually-resolved handle) per directory path - real npm
    installs fire many concurrent top-level `notify()` calls (a `mkdir` plus several sibling
    files' own writes) that all need the same shared ancestor AT ONCE, so caching only the settled
    value would still let every one of them race to resolve it before any had cached it (confirmed
    directly: with a settled-value-only cache, one shared directory was still resolved 3 separate
    times for 3 concurrent callers - fixed by caching the in-flight promise itself, so the second
    concurrent caller reuses the first's own request). `invalidate(path)` drops a removed
    directory's cache entries (and everything nested under it) so a later `ensureDir` for the same
    name can't hand back a handle to something OPFS no longer has - a narrower case (removing and
    IMMEDIATELY recreating the identical directory path, not a realistic npm shape) isn't fully
    closed and is documented in the code as a known, low-risk edge case (worst case: a
    caught-and-logged write failure, not silent corruption) rather than chasing full generality.
    33 files, 3 directories deep: 5.4s -> 1.7s on top of the concurrency fix (~3.1x further, ~6.8x
    total from the original 11.8s). A real `npm create vite@latest --template react-ts` install
    (its real dependency tree, wasm-swapped esbuild/rollup) now syncs in ~3.5s.
  Verified: `fs/opfsPersistence.test.ts`'s 4 new cases (unrelated paths mirror concurrently, not
  one at a time - confirmed to actually fail with a single shared chain, the same "verified to
  fail without the fix" rigor as the write-ordering regression test; a shared directory is
  `getDirectoryHandle`-resolved exactly once across several sibling writes; the SAME, resolved only
  once even when several concurrent top-level changes race for it at the same time - confirmed to
  actually fail with a settled-value-only cache (3 calls instead of 1) before switching to
  promise-level memoization; a removed-then-recreated directory's new content is what survives a
  restore, not the old). All pre-existing OPFS persistence Playwright tests (including the two
  `wc.fs.sync()`/symlink regression tests above, which depend on `flush()` correctly waiting for
  the now-concurrent, now-cached work) still pass unchanged. A full, clean
  `pnpm exec playwright test` run (122 passed, 9 opt-in skipped) and `vitest run` (914/914) confirm
  no regressions.
- **A real, self-inflicted regression from the symlink-manifest fix above, found from a live bug
  report** (`Uncaught WcvmError: Kernel did not become ready within 10000ms`): `loadSymlinkManifest`
  only ever caught `NotFoundError` (an absent manifest - a fresh root, treated as "no symlinks
  yet") - any OTHER failure, including `JSON.parse` throwing on a manifest a page reload had
  interrupted mid-write (a real, easy way to hit given how often OPFS-persisted sessions get
  reloaded), propagated straight up, UNCAUGHT, through `restoreFromOpfs` and the FS Worker's own
  `boot()`. Since that FS Worker `boot()` has no top-level catch of its own, the exception meant it
  never reached its own `self.postMessage({type: "ready"})` line - so the FS Worker never sent
  "ready", the KERNEL's own boot handshake (which awaits exactly that message) hung forever waiting
  for it, and 10 seconds later the HOST's own unrelated `ERR_BOOT_TIMEOUT` fired instead - nothing
  in that error pointed anywhere near the real cause. Reproduced directly in real Chromium (not
  just inferred): wrote real OPFS content, corrupted `__wcvm_symlinks__.json` with truncated JSON
  (exactly what an interrupted write leaves behind), reloaded - confirmed the kernel never became
  ready. Fixed by making `loadSymlinkManifest` treat ANY read/parse failure the same way a missing
  manifest already was: log it and return `{}` (best-effort persistence, matching the philosophy
  every other part of this write-behind mirror already follows - never able to block booting
  itself). Verified: `fs/opfsPersistence.test.ts`'s new case (a truncated manifest resolves
  `restoreFromOpfs` normally instead of rejecting, logs the failure, and the REST of the tree still
  restores correctly) - confirmed to actually reproduce the original uncaught rejection before the
  fix, the same "verified to actually fail without the fix" rigor used elsewhere in this file. 1
  new Playwright test: a real corrupted manifest written directly to real OPFS, followed by a real
  `page.reload()`, boots well under the old 10s hang (the real regression) with the rest of the
  filesystem intact. A full, clean `pnpm exec playwright test` run (123 passed, 9 opt-in skipped)
  and `vitest run` (915/915) confirm no regressions.
- **The SAME `ERR_BOOT_TIMEOUT` class of bug persisted after the fix above, from a live follow-up
  report** - because it was only half the fix: `loadSymlinkManifest` was made resilient, but
  `restoreFromOpfs`'s own MAIN loop (restoring ordinary files/directories, not just the symlink
  manifest) had no error handling at all. Any single unreadable OPFS entry - the exact same root
  cause (a page reload interrupting some OTHER file's own write, not necessarily the manifest) -
  threw uncaught out of the same `restoreFromOpfs` call, out of the FS Worker's own `boot()`, past
  its `postMessage({type:"ready"})` line, hanging the kernel's boot the identical way. Fixed at two
  layers this time, not one: (1) `restoreFromOpfs`'s own loop now wraps EACH entry's own
  restoration in its own try/catch - a single bad file/directory is logged and skipped, and
  everything else in the tree still restores normally, rather than losing the whole thing over one
  bad entry; (2) `workers/fs/worker.ts`'s `boot()` now ALSO wraps the entire
  `getOpfsRoot`+`restoreFromOpfs`+`createOpfsMirror` sequence in a top-level try/catch, as a final
  safety net for anything even (1) doesn't anticipate (`getOpfsRoot` itself failing - a genuine
  quota/permission error, say) - `mirror` simply stays `undefined` (booting without persistence
  for that session, same as `persist` never being set) rather than the FS Worker failing to boot at
  all. The invariant going forward: this worker must ALWAYS eventually reach "ready", no matter
  what OPFS is holding - booting with an incomplete (even entirely empty) filesystem is always
  better than a 10-second timeout with no indication of why. Verified:
  `fs/opfsPersistence.test.ts`'s new case (one corrupted file among several is skipped and logged,
  the rest of the tree - including a nested, unrelated directory - restores correctly) - confirmed
  to actually reproduce the original uncaught rejection before the fix, same rigor as the manifest
  regression test. `vitest run` (916/916) and a full, clean `pnpm exec playwright test` run (123
  passed, 9 opt-in skipped) confirm no regressions.

## 3. zlib, crypto, dgram, worker_threads

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
- `worker_threads` (real Node code, `internal/worker.js`/`internal/worker/io.js`/`internal/worker/
  messaging.js`/`internal/locks.js`, plus real vendored `internal/perf/event_loop_utilization` and
  `internal/error_serdes`): a `new Worker(...)` is another real, separate Process Worker
  (`kernel/processes.ts`'s existing `spawn()`, the same subtree-kill/`parentPid` machinery
  `child_process` already gets), reached over a REAL, native `MessageChannel`
  (`bindings/worker.ts`'s `WorkerHandle` mints it locally, synchronously, at `new Worker()`
  construction time - `.messagePort` is available immediately, matching real Node's own contract).
  `pid` is kernel-minted (own range, `WORKER_THREAD_PID_START = 4_000_000_000`) since it names a
  real Process Worker slot the kernel tracks, same as any other spawn; `threadId` is a genuinely
  separate small monotonic counter starting at 1 (0 reserved for the main thread) - but unlike
  `pid`, it CANNOT be kernel-minted (async, a round trip) because real vendored `internal/worker.js`
  reads `this.threadId` synchronously, immediately after constructing its own native handle, before
  ever calling `startThread()`. Solved with a SharedArrayBuffer-backed atomic counter
  (`IProcessInit.threadIdCounterSab`, handed to every spawned process, not just worker threads
  themselves, since any process might spawn its own nested one) and a plain `Atomics.add` -
  the same shape real Node's own `internal/worker.js` already uses for its own `cwdCounter`.
  `filename`/`doEval`/`workerData` are deliberately absent from the wire protocol between
  `bindings/worker.ts` and the kernel: real vendored `internal/worker.js` already sends the real
  LOAD_SCRIPT message carrying them over `.messagePort` *before* it ever calls `startThread()` -
  real `MessagePort` buffering means the not-yet-alive child still receives it once it starts
  listening, so nothing here needs to duplicate that wire format. `runtime/bindings/worker.ts`'s
  `getEnvMessagePort()`, `internalBinding('locks')` (`bindings/locks.ts`, wrapping the real, native
  `navigator.locks` Web Locks API directly - Node's own `Lock`/`LockManager` are themselves modeled
  on the same spec) and `internalBinding('util').constructSharedArrayBuffer` round out the binding
  surface real vendored code needs. `workers/process/runWorkerThread.ts` is this project's own
  hand-written bootstrap for a worker thread's process (no `internal/main/worker_thread.js` to
  vendor - Node's own bootstrap entry scripts are tightly coupled to its C++ startup order, the same
  reason `runtime.ts` already hand-writes `runMain`/`runEval`/`runRepl` instead of vendoring theirs).
  Not implemented (no browser primitive exists at all): `cpuUsage()`, `startCpuProfile()`/
  `stopCpuProfile()`, `startHeapProfile()`/`stopHeapProfile()`, `getHeapSnapshot()` (V8 Inspector/
  profiler access) - report a clean, honest rejection instead of pretending; `getHeapStatistics()`
  is a best-effort approximation from the non-standard `performance.memory`, not real V8 heap data.
  `resourceLimits` are accepted and reported back but never enforced - no way to configure a
  Worker's own V8 heap limits from plain JS either. An uncaught exception inside a worker thread
  ends it with an ordinary nonzero exit code, not real Node's own `'error'` event on the parent:
  that needs `internal/error_serdes.js`'s `serializeError()`/`deserializeError()`, which need real
  `v8.serialize()`/`v8.deserialize()` - deliberately left `notImplemented` (`runtime/shims.ts`'s
  `v8Shim`), the same scope decision `fork()`'s own "advanced" IPC serialization mode already made.
  No real stdio piping via `options.stdout`/`options.stderr` (`internal/worker/io.js`'s own
  `ReadableWorkerStdio`/`WritableWorkerStdio` aren't wired up) - a worker thread's own stdout/stderr
  instead flows straight through the SAME `child:stdout`/`child:stderr` → kernel → parent-process
  path a real `child_process`'s output already uses, which happens to land in the right place
  anyway: real Node's own DEFAULT (`options.stdout`/`stderr`: `false`) already pipes a worker's
  stdout/stderr straight to the parent's own, so an unpiped worker thread's output ends up
  observably correct without needing the full `ReadableWorkerStdio` machinery - only the OPT-IN
  "capture it as a readable stream on `w.stdout`/`w.stderr` instead" mode is missing.
  - **A genuine, three-layer platform gap, found and fixed in this order (real Chromium, not
    Node/Vitest - see "Hard-won gotchas" for why worker_threads can't be exercised under Vitest at
    all)**: real Node's native `MessagePort` C++ binding (1) calls `port[onInitSymbol]()`
    automatically during construction, which `internal/worker/io.js` relies on to set up
    `this[kEvents]` etc.; (2) provides `.ref()`/`.unref()`/`.hasRef()` (event-loop keep-alive); and
    (3) is written so real Node's native message delivery calls a specific, well-known hook
    (`port[Symbol.for('nodejs.internal.kHybridDispatch')](data, type)`) that
    `internal/event_target.js`'s own `EventTarget`/`NodeEventTarget` - a COMPLETE, independent,
    hand-written reimplementation, not `extends` the real platform `EventTarget` at all - exposes
    for exactly this purpose. A real platform `MessagePort` (browser or otherwise) has NONE of the
    three: (1) crashed `new Worker(...)` immediately (`.on()` reading `this[kEvents]` off
    `undefined`); (2) crashed one step later (`setupPortReferencing()`'s own `port.unref()` calling
    a method that didn't exist); (3), once (1) and (2) were fixed, caused no crash at all - just
    total silence: a worker posted a message, exited cleanly, and the parent's own
    `.on('message', ...)` handler simply never ran, since `.addEventListener()`/`.on()` calls
    after the swap only ever write to `NodeEventTarget`'s own private, JS-only listener store,
    which the browser's real, native message dispatch has no way to know exists or read from.
    Fixed by, in `runtime/bindings/messaging.ts`: wrapping `MessageChannel`'s own constructor to
    call `oninit()` on both resulting ports; installing real `ref()`/`unref()`/`hasRef()` directly
    on the global `MessagePort.prototype`, backed by `EventLoop.ref()` exactly like this file's own
    `broadcastChannel()` helper already does per-handle; and registering a REAL, native
    `addEventListener('message'/'messageerror', ...)` (captured at this factory's own top, before
    `internal/worker/io.js` - which requires this binding first thing - has had any chance to swap
    the prototype) that manually calls `port[kHybridDispatch](data, type)` on every real incoming
    message, letting `internal/worker/io.js`'s own `[kCreateEvent]` override build the proper event
    object and `NodeEventTarget`'s own dispatch invoke whatever real listeners guest/vendored code
    registered. A port that arrives via a REAL transfer (crossing into a different realm) needs
    this done AGAIN there - `oninit()`'s effects are plain per-object JS state that doesn't survive
    a transfer - so `initReceivedPort()` is exposed for the few known bootstrap sites
    (`runWorkerThread.ts`'s own `publicPort`/`mainThreadPort`) to call explicitly; for the
    unbounded, unknowable set of OTHER ports that can arrive later (e.g. vendored
    `internal/worker/messaging.js`'s own `REGISTER_MAIN_THREAD_PORT` handling relaying a THIRD
    worker's own port through a second one - no call site of ours ever sees that one arrive), the
    native bridge listener itself recursively re-initializes every port in `event.ports` on any
    message it sees, which is safe because it makes every such port self-bridging too - this
    covers the whole transitive closure automatically, confirmed by a worker-thread-spawns-
    worker-thread test that only started passing once this recursive step was added.
  - **A second, unrelated real bug, found via `w.on('exit', (code) => process.exit(1))`**: real
    vendored `internal/worker.js`'s `Worker` class `extends EventEmitter` (plain, old-style, NOT
    `NodeEventTarget`) - `this.emit('exit', code)` has none of `[kHybridDispatch]`'s own
    try/catch-and-route-to-`emitUncaughtException` behavior, so `process.exit()`'s thrown
    `ProcessExit` sentinel, called synchronously from inside a guest `'exit'`/`'online'`/`'error'`
    listener, propagated all the way back up through `WorkerRouter.dispatch()` to whatever raw,
    native event actually triggered the dispatch (a `child:exit` `self.onmessage` message, entirely
    outside this runtime's own `EventLoop.callback()`-wrapped call stack) - escaping as a genuine
    uncaught exception at the WHOLE PROCESS's own top level instead of just setting the exit code.
    Symptom: the KERNEL WORKER itself appeared to crash (the exception bubbled: Process Worker →
    Kernel Worker's own `onerror` not calling `preventDefault()` → the host page, arriving as a
    bare `"null"` `pageerror` three layers removed from where it actually happened) - the exact
    same root cause as this project's own pre-existing "`ProcessExit` from inside a `readline`
    `'line'`/`'close'` listener" gotcha, just a different call site. Fixed by deferring
    `WorkerRouter`'s own event dispatch through `EventLoop.post()` (`loop.post(() => this.dispatch
    (event))`) - the same "schedule JS work from outside a loop callback" mechanism an fs
    completion already uses - so a synchronous `process.exit()` inside any worker-thread event
    listener unwinds through a call stack `EventLoop.callback()` properly wraps and routes to
    `runtime.ts`'s own `handleUncaught`.
  - **A third, smaller bug**: a worker thread's own `console.log` output never reached anywhere at
    all (silently dropped) - `child:stdout`/`child:stderr` always routed to the real `child_process`
    `ChildRouter`, which doesn't recognize a worker thread's own kernel-minted pid as one of its
    own tracked children. Fixed in `workers/process/worker.ts` by checking the same
    `workerThreadChildPids` set `child:exit` routing already uses, and forwarding straight through
    as if it were this process's own stdout/stderr when it's a worker thread's.
  - Also found, and fixed the same way as the analogous `startThread()`-with-no-host path already
    had: `bindings/worker.ts`'s own `ERR_WORKER_NOT_RUNNING` fallback used to pass a reason string
    to a real vendored error class (`errors[customErr](customErrReason)`) that takes ZERO
    constructor arguments - real vendored `internal/errors.js`'s own error-class machinery asserts
    the passed argument count against the message template's declared arity and throws
    `ERR_INTERNAL_ASSERTION` on a mismatch, which (via the same escaping-uncaught-exception path
    above) also crashed the whole realm instead of ever reaching the intended `'error'` event.
  - `worker_threads` genuinely cannot be exercised under Vitest/Node at all, only real Chromium
    (see "Hard-won gotchas"): real Node's own internal `node:internal/per_context/messageport`
    wiring - active in every plain Node process, Vitest included, regardless of whether the script
    under test ever touches `worker_threads` itself - conflicts with this sandbox's own
    `MessagePort.prototype` mutations and the real, native `worker_threads.Worker` construction
    path outright crashes with an unrelated internal error the moment `new Worker(...)` is
    constructed. `kernel/processes.test.ts`'s own `"worker_threads routing"` describe block still
    covers the KERNEL-side wire protocol (pid minting, threadId echoing, the shared
    `threadIdCounterSab` reaching every spawn, the never-handed-off port being closed on a failed
    spawn) with plain object fakes, no real `MessagePort` involved.
  - Verified: `kernel/processes.test.ts`'s `"worker_threads routing"` describe block (4 Vitest). 6
    new Playwright tests in real Chromium (message exchange over a real MessageChannel; `workerData`
    round-tripping; `new Worker(file)` from the VFS; `w.terminate()` actually stopping a still-
    running worker; an uncaught exception ending the worker with exit 1 and its stderr correctly
    piped to the parent's own; a worker thread spawning its own nested worker thread) - none of
    this (real `MessagePort`, real cross-Process-Worker structured clone/transfer, the whole
    three-layer platform gap above) can be exercised outside Chromium. A full, clean
    `pnpm exec playwright test` run (97/97, `--repeat-each=3` on the new tests specifically to rule
    out flakiness from the async, multi-hop event dispatch involved) and `vitest run` (578/578)
    confirm no regressions.

## 4. The Vite dev-server pipeline

- Preview WebSocket tunnel (Phase 8's first piece): a previewed page's own `new WebSocket(...)`
  reaches the guest server's real `http.Server` `'upgrade'` handler - e.g. Vite's HMR client's
  `new WebSocket("ws://" + location.host + ...)`. A Service Worker never sees WebSocket traffic, so
  the preview SW injects a shim (`workers/preview/webSocketShim.ts`'s `injectWebSocketShim`) as the
  first script of every HTML document a preview frame NAVIGATES to (after an early `<meta charset>`
  if any, so the browser's 1024-byte charset prescan still finds it; never into a page's own
  `fetch()` of HTML, nor a `Content-Encoding`-compressed body; the guest's `Content-Length` is
  dropped). The shim replaces `window.WebSocket` with a same-API class for URLs meaning "a preview
  server" (same host as the page -> this frame's own virtual port; an explicit
  `/__wcvm_preview__/<port>/...`; `ws://localhost:<port>`/`127.0.0.1:<port>` -> that port), falling
  back to the real `WebSocket` for everything else. It posts the embedding wcvm page (nearest
  same-origin ancestor or opener that isn't itself a preview document) an
  `IPreviewWebSocketRequest` with a transferred `MessagePort` for that one socket;
  `apis/Preview.ts`'s `createPreviewWebSocketRelay` (listening on `window` once `enable()` has
  run, same-origin senders only) mints the socket id and relays the port to the kernel
  (`preview:wsOpen`/`wsSend`/`wsClose`, fire-and-forget) and the kernel's `preview:ws` events back
  down it. `kernel/previewWebSocket.ts` is the real RFC 6455 CLIENT over a virtual TCP connection
  (the same `netServer.connect()` `previewRelay.ts` uses, under its own `PREVIEW_WS_PID = -1`
  sentinel so each module gets only its own net events): upgrade request, 101 validation (status,
  `Upgrade: websocket`, only an offered subprotocol), masked frames out, unmasked frames in via
  `kernel/webSocketFrames.ts`'s incremental `WebSocketReader` (fragmentation, 16/64-bit lengths,
  ping->pong, close handshake both directions with a 5 s timeout for a silent server, protocol
  errors -> 1002 to the server and 1006 to the page). Every outcome is an ordered EVENT, not a
  request reply - open() has no response, since a server that sends a message the instant it
  upgrades (Vite's does) would otherwise race it. The shim's `installPreviewWebSocketShim` is
  injected as SOURCE TEXT (`Function.prototype.toString`), so it must stay self-contained - no
  imports or module-level helpers, `declare`-only class fields, every DOM global via its `win`
  param; a Vitest case runs the injected text on its own to catch a violation, and the built SW
  was checked for esbuild helpers. The page's `pagehide` sends 1001 synchronously so a reloading
  page (HMR's full reload) doesn't leak its tunnel. Not implemented: `Sec-WebSocket-Accept`
  verification (the peer is always a guest in this sandbox), extensions (permessage-deflate is
  never offered), cookies; `error` fires before every unclean close. A guest server is
  unmodified (checked for a real `http.createServer()` `'upgrade'` handler in Vitest,
  `runtime/http.test.ts`). Verified: `kernel/webSocketFrames.test.ts` (17),
  `kernel/previewWebSocket.test.ts` (21), `workers/preview/webSocketShim.test.ts` (23),
  `apis/Preview.test.ts`'s relay cases (4), `workers/kernel/handlers/preview.test.ts` (3), and 2
  new Playwright tests in real Chromium (a real iframe page's WebSocket against a hand-rolled guest
  `'upgrade'` server - real SHA-1 accept, text+binary both ways, a clean close handshake with its
  code/reason seen by both ends; killing that server drops the page's socket with `error` then
  close 1006), `--repeat-each=3`. A full, clean `pnpm exec playwright test` run (99/99) and
  `vitest run` (647/647) confirm no regressions.
- Preview absolute-path routing (Phase 8's second piece): a previewed page's ABSOLUTE URLs -
  `<script src="/@vite/client">`, `import "/src/a.ts"`, `fetch("/api")`, a link to `/about` -
  resolve against the host page's origin root, not the `/__wcvm_preview__/<port>/` prefix, so they
  used to fall straight through to the host's own server (every Vite module URL is absolute). The
  preview SW now REDIRECTS (307, so a POST keeps its method/body) each one into the requesting
  page's own port prefix. A redirect, not a response under the original URL, so every resource has
  exactly one URL - `/src/a.ts` and `/__wcvm_preview__/5173/src/a.ts` would otherwise be two
  separate ES module instances - and a module's relative imports/`import.meta.url` stay inside the
  prefix. The decision logic is `workers/preview/previewRouting.ts` (pure, no SW globals):
  `respondWith()` must be called synchronously but `clients.get()` is async, so the port each
  client was served from is recorded when its navigation is seen (`resultingClientId` -> port, or
  `null` for a non-preview client), making every later request from it a synchronous decision; a
  client never seen before (the browser stops an idle SW after ~30s, wiping that in-memory map)
  gets one async `clients.get()` lookup, answered by a plain `fetch(event.request)` passthrough if
  it turns out not to be a preview. A navigation has no `clientId`, so its REFERRER decides (a
  preview page navigating to `/about`). A bare `/__wcvm_preview__/<port>` navigation is first
  redirected to its trailing-slash form (otherwise its own `./x` resolves outside the port).
  `findHostClient` now also skips a top-level window that is itself a preview document (a preview
  opened in its own tab). Verified: `workers/preview/previewRouting.test.ts` (11 Vitest), and 2 new
  Playwright tests in real Chromium: a guest page loading an absolute `<script type=module>` that
  imports both a relative and an absolute module, POSTs to an absolute `fetch()`, then follows an
  absolute link (the frame ends up at the prefixed URL; the guest server logs every path); and the
  same page still routed after `ServiceWorker.stopAllWorkers` (CDP) wipes the SW's map - confirmed
  to FAIL with the async lookup deliberately broken, so it really exercises that path. A full,
  clean `pnpm exec playwright test` run (101/101) and `vitest run` (658/658) confirm no regressions.
- `npm install` (Phase 8's third piece - getting Vite's packages into the VFS; a minimal
  installer, NOT real npm, which stays deferred - see PLAN.md's "Real npm: feasibility findings",
  revisited 2026-09-24): a built-in program (`programs/npm/`) that runs in a Process Worker and talks
  to the real registry with the browser's own `fetch()` - registry.npmjs.org answers
  `Access-Control-Allow-Origin: *` on packuments and tarballs, so a CORS-mode fetch passes the
  page's COEP (checked with curl, then for real in Chromium). `npm install` installs package.json's
  dependencies+devDependencies (+optional, +non-optional peers); `npm install <pkg>...` (`-D`,
  `--registry`, `npm_config_registry`) installs and saves them exactly the way npm 11 saves them
  (`^<installed>` unless that's looser than the typed range - checked against real npm). Pieces:
  `semver.ts` (npm's range semantics incl. the prerelease rule, hand-written, pinned by an ORACLE
  table generated from the real `semver` package: 60 ranges x 37 versions + maxSatisfying +
  invalid ranges), `tar.ts` (ustar + 155-byte prefix + pax `x`/`g` + GNU `L`/`K` + base-256 sizes,
  checksums verified; tested on a real `npm pack` tarball), `registry.ts` (abbreviated packuments via
  the CORS-safelisted `application/vnd.npm.install-v1+json` Accept - no preflight; SRI sha512 (or
  sha1 `shasum`) integrity via SubtleCrypto; gunzip via `DecompressionStream`'s own reader/writer,
  no Blob/Response), `install.ts` (breadth-first resolution with npm v3-style hoisting: reuse the
  nearest copy Node's resolution would find if it satisfies, nest under the requester if the
  nearest conflicts, hoist to the root if there's none - BFS makes a later hoist unable to shadow an
  earlier resolution; version picking like npm-pick-manifest: a dist-tag, else `latest` if it
  satisfies, else the highest match preferring non-deprecated; packuments prefetched as names are
  discovered so the network runs ahead of the deterministic placement; tarballs 8 at a time;
  `npm:` aliases; npm's flat `overrides` (`"esbuild": "npm:esbuild-wasm@^0.25.0"` swaps the native
  package for its wasm build on EVERY edge - a root alias alone can't, since a dependency on
  `esbuild` rejects a copy whose real name differs, exactly like npm; `"$name"` references work);
  bundled deps skipped; extraneous packages pruned (dot-dirs like Vite's
  `node_modules/.vite` never), a package whose installed package.json already matches is kept, and
  package.json is written LAST during extraction so an interrupted one never looks complete; bins
  linked as relative symlinks in the right `node_modules/.bin`). Native `fetch`/`crypto.subtle`/
  `DecompressionStream` are captured in `builtins.ts` at module load and injected (the "never call a
  global by its bare name" gotcha - a `node` run earlier in the same worker via `sh` replaces
  globals). Checked for real in Chromium against registry.npmjs.org (a one-off, proxied run - not a
  committed test, since CI has no guaranteed network): `npm install vite@7` got vite 7.3.6 plus 9
  dependencies in ~6s, skipped every native `@esbuild/*`/`@rollup/*` build, reported esbuild's
  unrun install script, and `node` could `require` all of it. See PLAN.md's "Known differences" for
  everything it deliberately doesn't do. Found along the way (pre-existing, next up - see PLAN.md
  Phase 8): dynamic `import()` from CommonJS/`node -e` code fails SILENTLY. Verified:
  `semver.test.ts` (139), `tar.test.ts` (7), `npm.test.ts` (17, the whole installer end to end on a
  real Vfs against `testing/fakeRegistry.ts` - real gzipped tarballs, real sha512), and 2 new
  Playwright tests against `e2e/fixtureRegistry.ts` (the same fake registry served over real HTTP on
  its own origin with CORS, a second Playwright `webServer`): install with a nested conflict, a
  skipped native optional, a bin, then `require`/ESM `import`/running the bin through `node`, and an
  up-to-date second run; a missing package failing with `E404`. A full, clean `pnpm exec playwright
  test` run (103/103) and `vitest run` (821/821) confirm no regressions.
- `import()` from CommonJS and `node -e` code (Phase 8's fourth piece; a pre-existing runtime gap
  the `npm install` e2e test found): only real ES modules used to get their `import()` calls
  rewritten to the runtime's dynamic-import bridge (`runtime/esm/rewrite.ts`) - an `import()` in a
  CJS module or `-e` source reached the browser's NATIVE `import()`, which can't resolve a bare
  specifier or VFS path, and the idle event loop exited before the rejection surfaced, so it failed
  SILENTLY. `cjs.ts`'s `compile()` now hands source to an optional `rewriteDynamicImports` hook
  (runtime.ts wires it to `esm/loader.ts`'s new `rewriteScript`, which parses the source as a
  SCRIPT - `esm/ast.ts`'s `parseScript`: top-level `return` and `#!` allowed, like the CJS wrapper
  makes legal - and reuses `rewriteModule` + the same bridge ESM uses, installing it if needed).
  Only source matching a cheap `/\bimport\s*\(/` pre-check is ever parsed, so a script that never
  calls `import()` still never loads acorn; unparseable source is passed through untouched for eval
  to report. A module resolves relative to its own file; `-e` code relative to `<cwd>/[eval]`, like
  real Node. Verified: `runtime/cjsDynamicImport.test.ts` (4 Vitest, the CJS side with a recording
  bridge - the bridge itself only exists as a true global inside a real Worker, so it can't run in
  Vitest) and `esm/ast.test.ts`'s `parseScript` cases (3); 2 new Playwright tests in real Chromium
  (a CJS module `import()`ing a relative `.mjs`, a `node:` builtin and a node_modules package; `-e`
  resolving from the cwd, with a missing module now REJECTING with `ERR_MODULE_NOT_FOUND`), plus
  the npm e2e test's original `import("esm-only")` from `-e`, which failed silently before. A full,
  clean `pnpm exec playwright test` run (105/105) and `vitest run` (828/828) confirm no regressions
  (one full Vitest run hit 3 unrelated 5 s timeouts under load, incl. the untouched fetcher; they
  passed alone and in two further full runs).
- The builtins Vite imports (Phase 8's fifth piece): a first real `node vite.js` run stopped at
  once on `node:perf_hooks`; probing every `node:` builtin Vite 7's own code imports against a real
  process found 9 missing. Vendored (Node's real lib/, via `discover-node-lib.mjs`): `process`,
  `querystring`, `url` (over new `bindings/url.ts`: `url_pattern` = the platform's own WHATWG
  `URLPattern`, `encoding_binding.toASCII` = IDNA via the platform `URL`, `url.format`'s C++ half;
  `internal/url`'s shim gained `fileURLToPathBuffer` and the legacy protocol tables), `tty` (over
  the existing inert `tty_wrap`: `isatty()` is always false), and `perf_hooks` - which also swapped
  the old hand-written `internal/perf/observe` stub for Node's REAL `observe.js` (a real
  `PerformanceObserver` for mark/measure), over a rewritten `bindings/performance.ts`: all of
  node_perf_common.h's milestone/entry-type constants, no-op GC/observer hooks (no native entries
  to push), and `Histogram`/`createELDHistogram` - an EXACT (value->count) stand-in for C++
  HdrHistogram following its percentile rules, pinned against real Node's own numbers;
  `monitorEventLoopDelay` samples on a native `setInterval` that never keeps the process alive,
  like Node's unref'd timer. Hand-written: `module` (`runtime/moduleBuiltin.ts`, over OUR cjs.ts -
  real lib/module.js fronts Node's own C++-backed loader: `createRequire` from a path or `file:`
  URL, `builtinModules` (the loader's new `publicIds()`), `isBuiltin`, cjs.ts's own `Module` class
  with the common statics; `register`/`registerHooks` deliberately ABSENT - no hook points here,
  and Vite checks for them and falls back cleanly), `tls`/`https` (must LOAD - Vite imports them
  statically - but no TLS stack exists here, so every real TLS operation throws real Node's own
  `ERR_NO_CRYPTO`; `https.Agent` stays constructible), `inspector` (throws
  `ERR_INSPECTOR_NOT_AVAILABLE` on require, exactly like a Node built without it). Verified:
  `runtime/viteBuiltins.test.ts` (5 Vitest, one of them DIFFERENTIAL - a script run under real
  Node 24 once, its stdout pinned; this runtime must print byte-for-byte the same: url.parse/
  format/resolve, fileURLToPath/pathToFileURL, IDNA, URLPattern, querystring, tty, process, histograms,
  mark/measure, PerformanceObserver), 1 Playwright test in real Chromium (native URLPattern/
  performance/timers inside a real worker). A full, clean `pnpm exec playwright test` run (106/106)
  and `vitest run` (834/834) confirm no regressions.
- `import.meta` as the module's REAL `file://` URL (Phase 8's sixth piece; used to be a documented
  known difference - it was the module's `blob:` URL). Vite locates its own files with
  `fileURLToPath(new URL("../..", import.meta.url))`, reads its package.json relative to it, and
  opens with `createRequire(import.meta.url)` - none of which can work against a blob URL.
  `esm/rewrite.ts` now also rewrites every `import.meta` (`esm/ast.ts`'s `importMetaProperties`,
  acorn `MetaProperty` nodes) to `__wcvm_import_meta__("<path>")`, a bridge (`esm/loader.ts`'s
  `importMeta`) returning ONE cached object per module - like Node's, so what code stores on it
  sticks - with `url` (`pathToFileURL`), `filename`, `dirname` and `resolve()` (resolving exactly
  like the module's own imports: `file://` URLs, `node:` for builtins). To make room, the dynamic
  `import()` rewrite now replaces only the `import(` prefix and the closing `)` instead of the
  whole call - otherwise an `import.meta` INSIDE an `import()` argument (`import(new URL("./x",
  import.meta.url).href)`) would be two overlapping edits; output is byte-identical for every
  existing case (the old rewrite tests pass unchanged). Verified: `esm/rewrite.test.ts`'s 2 new
  cases (incl. the nested one) and 1 Playwright test in real Chromium (url/filename/dirname,
  `readFileSync(new URL("../package.json", import.meta.url))`, `fileURLToPath`,
  `createRequire(import.meta.url)`, `import.meta.resolve`, a dynamic import built from it, identity
  across reads). A full, clean `pnpm exec playwright test` run (107/107) and `vitest run` (836/836)
  confirm no regressions.
- Vite's dev server RUNS (Phase 8's seventh piece, 2026-09-24): an unmodified Vite 7.3, installed
  from the real registry by `npm install` with `overrides` swapping in esbuild-wasm and
  `@rollup/wasm-node`, starts inside wcvm in ~1s, listens on its virtual port, and serves `/`
  (transformed index.html), `/main.js` and `/@vite/client` through the preview relay - checked in
  real Chromium with a one-off proxied probe (no committed test yet: it needs the real registry).
  What it took, found by running it and fixing each stop in turn:
  - package.json `"imports"` (`#specifiers`, Node's PACKAGE_IMPORTS_RESOLVE) in BOTH resolvers
    (`esm/resolve.ts`, `cjs.ts`), sharing exports' exact/longest-pattern matching and conditions;
    an imports target may also name another package or a builtin. Vite's own
    `#module-sync-enabled` resolves to `false.js` (no `module-sync` condition - this CJS loader
    can't require ESM synchronously, which is exactly what that flag reports).
  - `dns.promises` + `dns/promises` (the promise API's `{address, family}` shape), and an `http2`
    shim (loads - bundled code requires it at init - but every entry point throws
    `ERR_NO_CRYPTO`/`ERR_METHOD_NOT_IMPLEMENTED`; nghttp2 is C++).
  - `crypto`: `getRandomValues`, `randomFillSync`/`randomFill` (now chunked past Web Crypto's
    64 KiB per-call quota - `randomBytes` too), `timingSafeEqual` (its length error is C++-thrown
    in real Node, so built to match), one-shot `crypto.hash()`, `webcrypto`/`subtle` (the platform's
    own); the shim now uses the platform `crypto` captured at load, not the bare global. Checked
    against real Node's own output.
  - A builtin's ESM facade reads EVERY export eagerly (real Node's does too), so any throwing lazy
    getter broke every `import { x } from` that module. Vendored the pure-JS ones (`util.parseArgs`,
    `MIMEType`/`MIMEParams`, `util.diff`, `AsyncLocalStorage`, `buffer.File`), added an
    `internal/deps/undici/undici` stand-in (the platform's own `WebSocket`/`CloseEvent`/
    `MessageEvent` + `createFastMessageEvent` - undici itself is a 1MB+ bundled dependency), and made
    the facade tolerate the rest (`util.setTraceSigInt`, `net.BlockList`/`SocketAddress` need C++):
    such a name exports `undefined` instead of failing the whole import.
  - Found along the way, two real `worker_threads` `MessagePort` bugs (`bindings/messaging.ts`),
    now fixed and Chromium-tested: an EventTarget-style listener (`port.onmessage =`,
    `addEventListener("message")`) crashed, since building its event needed undici's
    `createFastMessageEvent`; and the platform's `close()` neither released the port's event-loop
    ref nor reported `'close'` - a closed port with a listener attached kept the whole process
    alive forever, and `port.close(cb)`'s `cb` never ran. Now `close()` releases the ref and
    reports `'close'` through io.js's own `handle_onclose` hook, like real Node.
  Still open then: esbuild-wasm's service stopping (fixed since - see the esbuild-wasm entry
  below), and the page/HMR in a real preview iframe.
  Verified: new cases in `esm/resolve.test.ts` (4), `runtime.test.ts` (1), `viteBuiltins.test.ts`
  (2 - dns.promises; crypto against real Node's output), 1 new Playwright test (MessagePort
  onmessage/addEventListener/close(cb) + clean exit). A full, clean `pnpm exec playwright test` run
  (108/108) and `vitest run` (843/843) confirm no regressions.
- esbuild-wasm runs, so Vite's full TS pipeline does (Phase 8's eighth piece): esbuild's JS API
  spawns `node esbuild-wasm/bin/esbuild --service` as a child and talks to it over stdio - its Go
  WebAssembly runtime reads requests with `fs.read(0, ...)` and answers with `fs.write(1, ...)`.
  Three real runtime bugs stood in the way, each fixed and tested:
  - `fs.read(0)` answered EOF at once (`bindings/fs.ts` treated fd 0 as an empty file), so the
    service exited on its first read ("The service was stopped"). An async `fs.read(0)` now waits
    on the process's real stdin - consuming from the SAME Readable `process.stdin` reads
    (`runtime.ts`'s `readStdin`: at most `length` bytes, the rest unshifted back, `null` at EOF), so
    the two never race for chunks - and holds the loop open meanwhile, as a pending libuv read does.
    `readSync(0)` returns what's buffered, 0 at EOF, else `EAGAIN` (real Node on a non-blocking
    pipe) - it used to report a false EOF.
  - `child.ref()`/`unref()` were no-ops (`bindings/childProcess.ts`'s `Process`): a running child
    always kept its parent alive, and esbuild deliberately unrefs its idle service - so any script
    using esbuild's API never exited. Now they toggle the child's event-loop ref (`ChildRouter.
    setProcessRef`), like `uv_ref`/`uv_unref` on a process handle.
  - A child spawned without a `cwd` option started at `/` instead of inheriting the parent's
    current directory (real libuv passes a NULL cwd; the OS inherits). `spawn` and `spawnSync` now
    pass the parent's `process.cwd()` (worker_threads already did). esbuild always passes `cwd`
    itself, so this surfaced only in the new e2e test's own plain `spawn("node", ["service.js"])`.
  Result, checked for real in Chromium against the real registry: `esbuild.transform()` of TS in
  ~0.5s, and Vite serving a `src/main.ts` (types stripped by esbuild) importing an npm package that
  Vite's dependency scan found and esbuild PRE-BUNDLED into `/node_modules/.vite/deps/`. Verified:
  2 new `runtime.test.ts` cases (async fd 0 reads with partial lengths/leftover/EOF, `readSync(0)`
  semantics), 2 new `childProcess.test.ts` cases (unref lets the parent exit mid-child; ref after
  unref holds it again), 1 new `spawnSync.test.ts` case (inherited cwd), and 1 Playwright test (an
  esbuild-shaped service child: requests over `fs.read(0)`, replies over `fs.write(1)`, unref'd so
  the parent exits while it still runs). Three pre-existing heavy tests (two boot a whole Node
  runtime, one pushes >1 MiB through the syscall window) got 20 s timeouts: ~2 s alone, they
  occasionally crossed the 5 s default under full-suite load. A full, clean `pnpm exec playwright
  test` run (109/109) and `vitest run` (848/848) confirm no regressions.
- Vite dev server + HMR, end to end (Phase 8's ninth piece - the headline): an OPT-IN Playwright
  test (`e2e/boot.spec.ts`'s "Vite dev server"; `WCVM_E2E_VITE=1 pnpm exec playwright test -g
  "Vite dev server"`, skipped otherwise) runs an unmodified Vite 7.3.6 from `npm install` to hot
  module replacement, entirely in the tab: wcvm's own `npm install` from the REAL registry (~5 MB;
  behind a proxy, playwright.config.ts hands `HTTPS_PROXY` to Chromium for this test only),
  esbuild/Rollup swapped for their wasm builds via `overrides`, Vite's real CLI, the playground's
  own preview pane pointing itself at it via `onListen()`, a TypeScript entry transformed and an
  npm dependency (`mitt`) pre-bundled by esbuild-wasm, then a CSS edit and a self-accepting module
  edit both HOT-applied - asserted to be the same page (a boot marker on the iframe's window
  survives) - and the pane resetting when the server is killed. Opt-in rather than always-on by
  the user's choice: every building block it relies on already has its own small offline test, and
  keeping it on by default meant committing a 5.4 MB recorded registry slice (tried, then dropped
  and squashed out of history before it could stick). HMR itself needed NO new code: the preview
  WebSocket tunnel, absolute-path routing and `fs.watch` (chokidar runs over it) built earlier were
  exactly enough. Verified: the opt-in test passes against the real registry (~10 s); a default
  full `pnpm exec playwright test` run is 109 passed, 1 skipped.
- React + TypeScript runs, with React Fast Refresh (Phase 8's tenth piece): the Vite `react-ts`
  shape (React 19, `@vitejs/plugin-react` - Babel, pure JS; the SWC plugin needs native binaries),
  62 packages from the real registry in ~10 s, a real `vite.config.ts`, renders, handles clicks,
  and an `App.tsx` edit hot-updates the component while its `useState` count survives. Two runtime
  fixes it took:
  - `file:` URL specifiers in the ESM resolver (`esm/resolve.ts`'s `resolveFileUrl`): Vite loads
    `vite.config.ts` by bundling it with esbuild and `import(pathToFileURL(tmp).href)`. A
    `?query`/`#hash` makes a separate module instance, as in real Node (the key carries it after a
    NUL - `modulePath()`/`moduleUrlSuffix()` get the file and suffix back; the loader reads, parses,
    resolves relative imports and builds `import.meta` from the path, `import.meta.url` keeps the
    query).
  - Hashing is now plain synchronous JS in the process (`bindings/hash.ts`: md5, sha1,
    sha224/256, sha384/512, incremental, `copy()`), replacing the `OP_CRYPTO_DIGEST_SYNC` kernel
    round trip (retired) - `SubtleCrypto.digest()` is async and one-shot, so the whole input went
    to the kernel in ONE sync-call message, and Vite's etag of the 1 MiB+ pre-bundled `react-dom`
    failed with `EMSGSIZE` (a 500, a blank page). SHA-2 constants are DERIVED from their FIPS 180-4
    definitions with BigInt at load rather than transcribed. `Hash` now matches real Node's errors
    (`Digest method not supported`, `ERR_CRYPTO_HASH_FINALIZED` for update/digest/copy after
    digest) and gains `copy()`, md5 and sha224. Checked against Node's own crypto on every
    padding-edge length, random `update()` splits and a 3 MiB input.
  Also made the nested-REPL stdin e2e test wait on real prompts instead of fixed 100 ms delays -
  it failed on a loaded machine even at the previous commit (node's REPL started slower than the
  delay, so `.exit` and the next line arrived together; real node consumes typed-ahead input too).
  Verified: `bindings/hash.test.ts` (15), `esm/resolve.test.ts`'s file: URL cases (3), reworked
  `bindings/crypto.test.ts`; `vitest run` (865/865) and a full `pnpm exec playwright test` run
  (109 passed, 1 opt-in skipped); the React app checked for real in Chromium (one-off probe).
- The playground's example is now a Vite + React + TypeScript app (it used to be a hand-written
  Node `http` server; `src/exampleServer.ts` is gone): `src/reactExample.ts` writes a real
  `react-ts` project to `/react-app` (App.tsx taken from the page's editor), runs wcvm's `npm
  install` against the real registry (~10 s the first time), starts Vite's real CLI, and the
  preview pane picks the dev server up via `onListen()`. The `#example-editor` textarea IS the
  running app's `src/App.tsx` - typing writes it (debounced) and Vite hot-updates the component,
  its state intact. Tests: an always-on one for the page wiring, and an OPT-IN one
  (`WCVM_E2E_VITE=1`, real registry) for the whole flow through the real UI - install, the
  counter in the preview, clicks, an editor edit hot-reloading with the count kept (~16 s).

## 5. npm run, playground examples, npm create

- `npm run`/`start`/`stop`/`restart`/`test` (Phase 8's last piece before templates/workspaces):
  wcvm's npm (`programs/npm/runScript.ts`) runs a package.json script through wcvm's own `sh`,
  including `pre<x>`/`post<x>` hooks (skippable with `--ignore-scripts`), a missing script's exit
  short-circuited to 0 by `--if-present`, `start`'s real fallback to `node server.js` (only when
  no `start` script and `server.js` exists), and `restart`'s real fallback to `npm stop
  --if-present && npm start` (which then recurses back into wcvm's own npm, exactly like real
  npm's does). Aliases match real npm's own (`lib/utils/cmd-list.js`): `run-script`/`rum`/`urn` for
  `run`, `t`/`tst` for `test`. Not vendored (this isn't Node's own `lib/`, and real npm's own
  `@npmcli/run-script` pulls in native child_process spawning this sandbox doesn't have) - hand-
  written, but checked side-by-side against a real npm 11 install for every observable behavior:
  the run banner (`\n> <pkg id> <event>\n> <cmd> [args]\n\n`), the two-section `npm run` listing
  (real npm's own fixed lifecycle-name list decides the split), the missing-script message's exact
  text, `npm_lifecycle_event`/`npm_lifecycle_script`/`npm_package_*` env vars (the same recursive
  flatten real npm's `package-envs.js` does), and - the piece that makes any of this useful -
  `PATH` gaining every ancestor's `node_modules/.bin` (`set-path.js`'s own walk-to-the-root logic),
  nearest first, ahead of whatever `PATH` already had.
  - **A new capability in `sh` itself, not just npm**: a bare command name that isn't a builtin is
    now searched through `PATH` (`sh.ts`'s `resolveExecutable`/`resolveCommand`) exactly like a
    real shell would - the only interpreter this sandbox can hand a script off to is `node`, so
    only a `#!/usr/bin/env node`-style shebang (direct interpreter paths and `env -S` both
    recognized) resolves to anything; anything else is a clean `126` (found, can't execute) rather
    than a silent no-op, and nothing at all on `PATH` stays the existing `127`. The REAL path
    (`fs.realpath`, following the symlink `npm install`'s own bin-linking already creates) is what
    gets handed to `node`, so a resolved bin's own relative `require`s resolve against its
    package's real directory, matching real Node's own symlink-following for its main module -
    this is what lets `npm run dev`'s `"dev": "vite"` actually find and run
    `node_modules/.bin/vite`.
  - **A real, pre-existing bug found and fixed along the way**: `sh.ts`'s `runStage` used to hand
    a nested program (any builtin it invokes, including `node`) only a hand-picked SUBSET of the
    calling process's own `IProgramContext` - `fs`/`cwd`/`env`/`pid`/`globalObject`/`sleep`/
    `childProcess`/`stdin`/`stdout`/`stderr`, silently dropping `spawnSync`/`ipc`/`fsWatch`/`net`/
    `netSync`/`udp`/`workerThread`/`mintThreadId`. Harmless for the small scripts `sh` had ever
    run before (an `echo`/`cat` pipeline, or a `node -e` smoke test with no real I/O) - but it
    would have silently broken Vite's entire dev server the moment it ran through `npm run`
    instead of being spawned directly: `net` for its own TCP server, `fsWatch` for chokidar,
    `spawnSync`/`childProcess` for esbuild's own service child. Fixed by spreading the WHOLE
    context (`{ ...ctx, args, cwd: state.cwd, stdin, stdout }`) instead of listing fields by hand -
    the same fix keeps working automatically as `IProgramContext` grows new capabilities later.
  - **A second real bug, caught before it ever ran** (a circular-import crash, not a behavioral
    one): `runScript.ts` originally imported `sh` statically. Since `builtins.ts` EAGERLY calls
    `createNpm(...)` at its own module-load time (to build the `Program` it registers, not lazily
    like the `sh`/`node` builtins themselves), and `sh.ts` itself already statically depends on
    `builtins.ts` (via `programs/index.ts`'s `resolveProgram`) for the pre-existing, documented
    `sh`-resolves-builtins-by-name cycle - a static `npm.ts -> runScript.ts -> sh.ts -> index.ts ->
    builtins.ts -> npm.ts` cycle meant `createNpm` could still be mid-load (not yet exported) the
    moment `builtins.ts` tried to call it, throwing `"createNpm is not a function"` the instant
    anything imported `npm.ts` first (exactly what `npm.test.ts` does). Fixed the same way
    `node.ts` already avoids a similar problem for its own (much heavier) runtime import: a
    dynamic `import("../sh/sh")` inside `runOne`, run long after every module has finished
    loading, never touches the cycle at all.
  - The playground's React example now starts Vite with `npm run dev -- --port 5173
    --strictPort` (`reactExample.ts`) instead of directly invoking `node
    node_modules/vite/bin/vite.js` - exercising this whole feature for real, not just in
    isolation; the existing opt-in Vite e2e test (below) is what actually re-confirmed HMR still
    works end to end through the new path.
  - See PLAN.md's "Known differences" for what `npm run` deliberately doesn't do (no command-name
    abbreviation, no `--json`/`--parseable` listing, no workspaces, a smaller env var set).
  - Verified: `programs/sh/sh.test.ts`'s new `"PATH-resolved executables"` describe block (5
    Vitest, including a bin resolved through a real symlink the way `npm install` itself creates
    one, and a bare relative path with no `PATH` search at all), `programs/npm/npm.test.ts`'s new
    `"npm run"` describe block (12 Vitest - the banner, pre/post ordering and short-circuiting,
    `--if-present`/`--ignore-scripts`, the listing, both fallbacks, every alias, a real PATH-
    resolved bin booting a real Node runtime, and the missing-package.json error). A full, clean
    `pnpm exec playwright test` run (109 passed, 2 opt-in skipped) and, with `WCVM_E2E_VITE=1`,
    the Vite dev server and React example e2e tests (3 passed, ~26 s total) confirm no regressions
    and that the new `npm run dev` path really does carry Vite's dev server, HMR and all, through
    to a real Chromium tab. `vitest run` (882/882) confirms no regressions elsewhere.
- A second playground example, Vue + Vite (`src/vueExample.ts`) - proof the whole `npm install` ->
  `npm run dev` -> preview pipeline is actually generic, not accidentally React-specific: the
  run/stop/edit machinery both examples share (writing project files, spawning `npm install` then
  `npm run dev`, wiring the editor to hot-reload, reporting status) was pulled out of
  `reactExample.ts` into `src/viteExample.ts`'s `attachViteExample(wc, config, elements)`, taking
  each framework's own project/port/files/editable-path/initial-content as a small config object;
  `reactExample.ts` is now just that config plus its own `PROJECT_FILES`. The Vue project itself is
  a plain-JS `create-vite` "vue" template (`vue` + `@vitejs/plugin-vue`, no TypeScript - Vue's SFC
  compiler doesn't need it, so this also checks that path is real, not just Babel/React's), same
  `esbuild-wasm`/`@rollup/wasm-node` overrides as the React example, on its own port (5174) and
  project dir (`/vue-app`). Both examples share the ONE `#preview-frame` already in the page, so
  they're made mutually exclusive in the UI (not in wcvm itself, which has no such limit): each
  `attachViteExample` call takes an `onBeforeStart` hook, wired in `main.ts` so starting either
  example stops the other's dev server first, synchronously, before that example's own install
  even begins - confirmed by a test that starts Vue, then clicks React's own button, and asserts
  Vue's status flips to "Stopped (switched to the React example)." immediately, without waiting
  for React's own ~10s install. Verified: the playground's own `tsc --noEmit` stays clean; 2 new
  Playwright tests (an always-on one for the `#example-vue-*` page wiring, and an opt-in one -
  `WCVM_E2E_VITE=1` - for the whole flow: install, the counter in the preview, an editor edit hot-
  reloading the Vue component, then the mutual-exclusion check above). A full, clean
  `pnpm exec playwright test` run (110 passed, 3 opt-in skipped) and, with `WCVM_E2E_VITE=1`, every
  test including all opt-in ones (113 passed, ~1.8 min total) confirm no regressions.
- `npm create <name>`/`npm init <name>` (`programs/npm/exec.ts`): real npm's own package-name
  mangling (`lib/commands/init.js`'s `execCreate`, checked against real npm 11 - a bare scope
  becomes `<scope>/create`; anything else gets `create-` inserted right after an optional leading
  `<scope>/`, even if the name already starts with `create-`) resolves a package like
  `create-vite`, fetched as a single package with no dependency-tree resolution at all (most
  `create-*` tools, `create-vite` included, bundle everything into one file and declare zero
  runtime dependencies of their own), cached under a scratch VFS path
  (`/.wcvm/npm-exec-cache/<name>@<version>`, keyed by exact version so a repeat `npm create vite`
  doesn't re-download) - then its own `bin` entry runs through `node` directly (an args ARRAY,
  never round-tripped through a shell string the way `npm run`'s own forwarding is, so a
  space-containing arg - a target directory named `"my app"`, say - survives whole). The same
  "npx `<pkg>`" idea real npm's own `npm exec`/libnpmexec implements, scoped to just this one case;
  a bare `npm init` with no name (real npm's interactive package.json wizard) isn't supported.
  - **The raw-mode-TTY risk this was previously deferred over turned out not to apply at all**:
    `create-vite`'s own interactive template picker only runs when `process.stdin.isTTY` is
    truthy (checked directly in its real source) - and this sandbox's `tty_wrap.isatty()` is
    already always `false` (a pre-existing, deliberate simplification - see "Known differences"),
    so `create-vite` already treats wcvm as non-interactive by default, the exact same way it
    would treat a CI runner with no real terminal attached. No new interactivity-related code was
    needed at all - only the fetch-one-package-and-run-its-bin machinery above.
  - **Two real, ecosystem-version gotchas found verifying this against the actual registry, both
    fixed by pinning versions - not wcvm bugs, but real incompatibilities any real user hitting
    the same combination would also hit**: (1) `create-vite@latest`'s CURRENT react-ts template
    scaffolds Vite 8, which defaults to Rolldown (a native/Wasm Rust bundler) instead of
    Rollup+esbuild - PLAN.md already had a note from an earlier investigation that Vite
    8/Rolldown hits an upstream Wasm trap, unrelated to this feature. (2) Once `vite` itself was
    pinned back to the known-working `7.3.6` (matching the hand-written React example's own pin),
    the scaffolded template's own `@vitejs/plugin-react@^6.1.1` (also newer than what that example
    pins) failed with `EsmResolveError: Package subpath "./internal" is not defined by "exports"
    in .../vite/package.json` - a real Vite-7-vs-plugin-react-6 export-path mismatch, fixed by
    pinning `@vitejs/plugin-react` back to `^5.0.0` too. With both pinned (plus the same
    `esbuild-wasm`/`@rollup/wasm-node` `overrides` the hand-written examples already use), the
    real, unmodified scaffolded project installs and runs Vite's dev server for real.
  - Verified: `programs/npm/exec.test.ts` (6 Vitest - `mangleCreateName` against real npm 11's own
    cases, including the bare-scope and already-"create-"-prefixed quirks), `programs/npm/
    npm.test.ts`'s new `"npm create / npm init"` describe block (7 Vitest - mangling+fetch+bin-run
    against the fake registry, the space-preserving arg check, version pinning, tarball caching on
    a repeat run, the `create`/`init` alias equivalence, a missing-bin error, a missing-name
    error). 1 new Playwright test against the REAL npm registry (`WCVM_E2E_VITE=1`): a real
    `npm create vite@latest scaffolded -- --template react-ts --no-interactive` scaffolds a real
    project non-interactively, then it's installed and its real Vite dev server actually starts -
    run twice in parallel to rule out flakiness. A full, clean `pnpm exec playwright test` run
    (112 passed, 4 opt-in skipped) and, with `WCVM_E2E_VITE=1`, every test including all opt-in
    ones (116 passed, ~1.9 min total) confirm no regressions. `vitest run` (895/895) confirms no
    regressions elsewhere.
- A third playground example, `npm create vite@latest` (`src/createViteExample.ts`) - the direct
  UI showcase of `npm create`/`exec.ts`, right next to the two hand-written ones: instead of
  mounting a static `PROJECT_FILES` tree, it runs a real `npm create vite@latest -- --template
  react-ts --no-interactive`, patches the SAME version pins found verifying `npm create` itself
  (`vite@7.3.6`, `@vitejs/plugin-react@^5.0.0`, the `esbuild-wasm`/`@rollup/wasm-node` overrides)
  into the real scaffolded package.json, then seeds the editor from the real scaffolded
  `src/App.tsx` (create-vite's own current default template - a counter button with real image
  assets, `.counter`/no `#count` id, unlike the hand-written examples') instead of any
  wcvm-authored content. `viteExample.ts`'s `IViteExampleConfig.source` grew a second
  `"scaffold"` kind alongside the existing `"static"` one to carry this - `attachViteExample`
  itself still owns installing, starting `npm run dev`, wiring the editor to hot-reload, and
  reporting status, identically either way. All three examples now share the one preview pane, so
  `main.ts` extends the pairwise mutual-exclusion each `onBeforeStart` hook already did into a
  three-way one (starting any one stops the other two). Verified: the playground's own
  `tsc --noEmit` stays clean; 2 new Playwright tests (an always-on one for the placeholder text
  before any run, and an opt-in one - `WCVM_E2E_VITE=1` - for the whole flow: scaffold, install,
  the real counter and its real image assets rendering in the preview, an editor edit hot-
  reloading the real `App.tsx`, then the three-way mutual-exclusion check). A full, clean
  `pnpm exec playwright test` run (113 passed, 5 opt-in skipped) and, with `WCVM_E2E_VITE=1`,
  every test including all opt-in ones (118 passed, ~2.1 min total) confirm no regressions.
- Real interactivity for the Create Vite example's own `npm create vite@latest`
  (`src/interactiveTerminal.ts`): an "interactive" checkbox swaps the silent `--no-interactive`
  scaffold for create-vite's own REAL prompts - arrow-key framework/variant menus and all -
  answered live by the user in a raw terminal, instead of anything wcvm scripts on their behalf.
  `interactiveTerminal.ts` is a genuinely different kind of terminal from `terminal.ts`'s own
  sh/node session: that one does its OWN local line editing in the browser (echo, backspace,
  buffer-until-Enter) because sh/node's REPLs are line-buffered and only read a whole line at
  once: reasonable, since there's no real pty here. create-vite's own prompts instead use real
  Node `readline` in `terminal: true` mode with `emitKeypressEvents` - checked directly against a
  real spawn first (feeding it a raw arrow-key escape sequence correctly produced a `{name:
  "up"}` keypress event) - so `interactiveTerminal.ts` forwards every keystroke to the process's
  stdin immediately, byte for byte, with NO local echo of its own: the process's own readline
  does that, through its own stdout, exactly like a real pty's line discipline handing off to a
  raw-mode foreground program would. The target directory is still given explicitly on the
  command line (skips only the "Project name?" prompt); `--no-immediate` skips create-vite's own
  "install and start now?" prompt outright - answered yes, it would run `npm run dev`
  SYNCHRONOUSLY inside create-vite's own process, which never returns for a dev server -
  installing/starting is already this example's own next step, asynchronously, the normal wcvm
  way. Once the framework choice is genuinely free, `editablePath`/the version-pin logic can no
  longer assume react-ts: `viteExample.ts`'s `findEditableFile` tries the configured default then
  every other common "App" file convention create-vite's OTHER templates use, and
  `KNOWN_PLUGIN_PINS` only pins a plugin that's actually present (`vite` itself is always pinned -
  it alone fixes the Vite 8/Rolldown Wasm trap regardless of framework).
  - **A real, ecosystem-version incompatibility found by actually using the feature** (reported by
    the user picking React's own "TypeScript + React Compiler" variant): `@vitejs/plugin-react`
    only gained the `reactCompilerPreset` export it needs at `6.0.0` (confirmed absent from every
    `5.x`, checked directly against the published packages) - but `6.x` itself imports from a
    `"vite/internal"` subpath that `vite@7.3.6`'s own `package.json` doesn't export at all (only
    `vite@8+` does, and that's the same Rolldown/Wasm-trap version this sandbox can't run either).
    There is no working (vite, plugin-react) pair for this one variant yet - detected right after
    scaffolding (`pkg.devDependencies["babel-plugin-react-compiler"]`, one of the extra
    dependencies create-vite's own template adds for it) and failed with a clear, actionable
    message instead of continuing into the same cryptic Vite crash the user originally hit.
  - **A second, more consequential bug this surfaced** (silent, not just for React Compiler):
    `stop()`'s own `if (!vite) return` guard - added earlier so a cross-example "stop yourself"
    call is a safe no-op when this example isn't running - was ALSO silently swallowing this
    example's OWN `start()` failures, since `vite` isn't assigned until `npm run dev` actually
    spawns, well after scaffolding/`npm install` could already have failed. Every failure before
    that point (a bad template, a network error during install, this React Compiler case) left
    the status frozen on "Scaffolding..."/"Installing..." forever, with no visible error at all -
    confirmed retroactively by a real, unrelated transient registry ENETWORK error during
    verification, which the fix now surfaces cleanly. Fixed by splitting `stop()` into a guarded
    version (cross-example calls, the "dev server exited unexpectedly" handler - both already
    guaranteed `vite` is set) and an unconditional `reportFailure()` (the click handler's own
    catch block, which can't make that assumption).
  - Verified: the playground's own `tsc --noEmit` stays clean. 1 new Playwright test, driven by
    REAL Playwright keyboard events into the actual terminal DOM element (not synthetic stdin
    writes) - checks the checkbox, clicks run, waits for the real terminal to attach, presses
    Down/Enter to pick Vue (a different framework than the example's own react-ts default,
    proving `findEditableFile`'s fallback and the generalized pin logic), confirms the real
    scaffolded `src/App.vue` seeds the editor and Vite starts for real. Before writing that test,
    the whole mechanism was checked in three escalating real-Chromium steps: `emitKeypressEvents`
    decoding a raw arrow key in isolation, a full `npm create vite@latest --interactive` session
    driven by synthetic stdin writes (framework/variant/linter all answered via forwarded
    keystrokes), then the same flow through the real UI. A full, clean `pnpm exec playwright test`
    run (113 passed, 6 opt-in skipped) and, with `WCVM_E2E_VITE=1`, every test including all
    opt-in ones (119 passed, ~5 min total - one run also hit a real, unrelated transient registry
    network error on an unrelated test, which passed cleanly on retry) confirm no regressions.
- A real, native browser `Worker` (`new Worker(new URL("./x.mjs", import.meta.url))` - the
  browser's own global, not `worker_threads` - see `bindings/worker.ts` for that one): found
  scoping Vite 8/Rolldown support further (see PLAN.md's "Scoped further" note) - `@napi-rs/
  wasm-runtime`'s real browser build, which Rolldown's real Wasm binary uses, spawns a pool of
  these directly even for single-threaded use. Real Node has no global `Worker` at all, so nothing
  vendored covers it; `runtime/bindings/rawWorker.ts`'s `installRawWorker` wraps the real, native
  constructor instead. Two real, confirmed-in-Chromium platform gaps, not assumed:
  - `import.meta.url` is deliberately rewritten to a synthetic `file:` URL (`esm/loader.ts`'s own
    doc comment), so guest path logic (`fileURLToPath`, `createRequire(import.meta.url)`) resolves
    against the VFS like a real filesystem - but a real native `Worker` can never load a `file:`
    URL at all: `new Worker("file:///a/b.mjs")` throws SYNCHRONOUSLY in real Chromium
    (`Failed to construct 'Worker': Script at 'file:///a/b.mjs' cannot be accessed from origin
    '...'`), not a hang, not an async error event. `WcvmWorker`'s constructor resolves a `file:`
    URL back to its real VFS path and hands it to a NEW `esm/loader.ts` export, `blobUrlForFile`
    (blob-ifies the file - and, for `type: "module"`, its whole static import graph, reusing the
    exact same `prepare()` every ordinary import already goes through - a plain classic script is
    blobbed as raw bytes, no import resolution, matching a real classic script's own restriction);
    anything that isn't this sandbox's own `file:` scheme (`http(s):`, `blob:`, `data:`) passes
    straight through to the real constructor unchanged.
  - A real native `Worker` has NO wcvm-specific ref-counting of its own, so a script doing nothing
    but `new Worker(...)` and awaiting its first message saw an idle event loop and exited before
    that message could ever arrive (confirmed empirically: a first diagnostic attempt received
    nothing and exited 0 prematurely). Fixed by ref'ing the loop for as long as a `WcvmWorker`
    instance exists, released on `.terminate()` - a real native `Worker` has no "I stopped myself"
    signal exposed to its own creator at all (unlike a `MessagePort`'s own close event - see
    `messaging.ts`), so a worker that ends itself with no explicit `.terminate()` call keeps its
    creator alive regardless; not a concern for a persistent pool like `@napi-rs/wasm-runtime`'s
    own (nothing there calls `terminate()` mid-use), but a documented simplification otherwise.
  - A THIRD platform gap, found chasing this further (see below): `@emnapi/wasi-threads`'s own
    `ThreadManager`, and `@napi-rs/wasm-runtime`'s own async-work/threadsafe-function dispatch built
    on it, guard every `.on()`/`.once()`/`.off()`/`.ref()`/`.unref()` call on a worker object behind
    `ENVIRONMENT_IS_NODE` (`typeof process.versions.node === "string"`) - true under real Node
    (where `new Worker(...)` doesn't exist as a global at all; that branch targets
    `worker_threads.Worker`, a real EventEmitter) and false in a real browser (where the same files
    call `addEventListener()`/`removeEventListener()` instead, or - `ThreadManager`'s own pool
    bookkeeping only - rely on native `worker.onmessage`/`.onerror`/`.onmessageerror` property
    assignment, set unconditionally just above). wcvm's own vendored `process.versions.node` makes
    `ENVIRONMENT_IS_NODE` true here too, even though `new Worker(...)` resolves to this real native
    browser constructor - a genuine identity contradiction no real environment has - so the Node
    branch ran against a plain `Worker` and crashed (`TypeError: worker.once is not a function`).
    Once that stopped crashing, a real bundling call still hung forever at `.generate()`: the
    async-work/threadsafe-function completion message has NO property-assignment fallback at all -
    `.on('message', ...)` is its ONLY delivery path under the (wrongly-taken) Node branch, so a
    no-op there silently drops the one message that would resolve the pending build. Fixed by
    making `.on()`/`.once()`/`.off()` genuine bridges to `addEventListener()`/`removeEventListener()`
    (unwrapping to `fn(event.data)` for `'message'`/`'messageerror'`, matching what Node's own
    `.on()` call sites already expect), tracked per-(event, original listener) so `.off()` finds the
    right one to remove; `.ref()`/`.unref()` toggle the same held loop-reference the SECOND PLATFORM
    GAP above already tracks - exactly their real meaning. `'exit'`/`'detachedExit'` (Node-only
    concepts) have no bridge and are dropped - the one real, documented simplification: an
    unexpected worker crash goes unreported, acceptable for a pool normally only ever torn down via
    an explicit `.terminate()` (already handled).
  - **With all three fixes, real Rolldown WASM bundling now genuinely works end to end** - proven,
    not just theorized: `@rolldown/browser` (swapped in for plain `rolldown` via a `package.json`
    `overrides` entry, the same trick already used for `esbuild`/`rollup` -> their wasm builds - the
    package.json exports leading to it needs a `"browser"` ESM condition too, since `@rolldown/
    browser`'s own `"."` export has no `"import"` key at all, only `"types"`/`"browser"`/
    `"default"`) loads its real `.wasm` binary (via `rawFetch.ts`, next entry), spins up its real
    worker pool (via the three fixes above), and a real `rolldown({ input, plugins: [...] })` call
    produces REAL bundled output - checked directly with a two-file TS project
    (`import { greet } from './helper'`) compiling to genuine, correct bundled code. The remaining
    piece: `@rolldown/browser`'s own filesystem is a fully ISOLATED in-memory WASI `memfs()` (not
    wcvm's VFS at all - confirmed by reading `rolldown-binding.wasi-browser.js`'s own
    `export const { fs: __fs, vol: __volume } = memfs()`, itself not part of the package's public
    `exports` map), so `input`/imports resolve against nothing by default (`[UNRESOLVED_ENTRY]
    Cannot resolve entry module`) - fixed for the standalone case with an ordinary Rollup-compatible
    `resolveId`/`load` plugin backed by wcvm's own real `fs`, which bypasses the internal memfs
    entirely (the sanctioned way any real bundler consumer would feed it files - not a hack). NOT
    yet solved: Vite itself invokes Rolldown INTERNALLY, with no known way to inject this plugin
    into that internal call - whether Vite's own dev-server file reads (not just `vite build`) even
    route through Rolldown at all in the same way is unconfirmed too. The `"browser"` condition
    change itself is also still NOT committed/applied for real use (kept as a documented, proven-
    necessary-but-unapplied finding) - it remains a genuine, ecosystem-wide ESM-resolution change
    (every package's `"."` export, not just this one), now better understood (proven to change
    resolution correctly for this one real case, with no side effects on the one ~18-package install
    tested) but not yet verified safe more broadly. See PLAN.md's "Scoped further" for the full
    writeup and what's left.
  - Verified: 5 new Playwright tests in real Chromium (loads a real VFS script instead of throwing;
    keeps the process alive until the worker's own message arrives; `.terminate()` releases the ref
    and lets an otherwise-idle process exit; `ref()`/`unref()`/`on()`/`once()`/`off()` are safe to
    call and genuinely bridge real events for a Node-shaped listener) - none of this (a real native
    `Worker`, the `file:` URL rejection, real event-loop ref/unref timing, real `addEventListener`
    bridging) can be exercised outside Chromium.
- `fetch()` of a `file:` URL (`runtime/bindings/rawFetch.ts`'s `installRawFetch`, found solving the
  SAME Rolldown/WASM scoping above): a common pattern for loading a co-located binary asset -
  `@napi-rs/wasm-runtime`'s real browser build fetches its own `.wasm` file via `fetch(new
  URL('./x.wasm', import.meta.url))` - hits the exact same synthetic-`file:`-URL problem
  `rawWorker.ts` already solves for `new Worker(...)`, confirmed the same way: `fetch("file:///a/
  b.wasm")` rejects in real Chromium with a bare `TypeError: Failed to fetch` (no `Response`, no
  status - nothing to branch on, unlike a real 404). `installRawFetch` wraps the real, native
  `fetch` global: a `file:` URL resolves back to its real VFS path and returns a real `Response`
  built from the VFS file's own bytes (200 on success, 404 - not a rejection - for a missing file,
  the closer real-fetch analogue); anything else (`http(s):`, `blob:`, `data:`, a `Request` whose
  own `.url` isn't `file:`) passes straight through unchanged - in particular this never touches
  `programs/builtins.ts`'s own `nativeFetch`, captured at MODULE LOAD time (before any Process
  Worker/runtime exists) for the npm installer's real registry access.
  - Verified: 3 new Playwright tests in real Chromium (`fetch(new URL(..., import.meta.url))` reads
    a real VFS file as a real `Response`; a missing path resolves 404, not a rejection; a real
    `http(s)` URL still passes straight through - which incidentally surfaced two small, PRE-
    EXISTING, out-of-scope gaps while writing that third test, not attempted here: a bare native
    `fetch()` doesn't ref wcvm's own event loop on its own, and a Process Worker's own `blob:` base
    URL doesn't support a path-absolute relative URL like `/index.html` the way a real `http(s)`
    page does - both worked around in the test itself, not fixed).
  A full, clean `pnpm exec playwright test` run (120 passed, 6 opt-in skipped) and `vitest run`
  (895/895) confirm no regressions.
- A fourth playground example, plain Node + Express (`src/expressExample.ts`) - the other side of
  "dev server templates" from the Vite examples (React/Vue): no bundler or dev server at all,
  proving the "install from the real registry, run entirely in this tab" pipeline isn't
  Vite-specific either. `npm start` deliberately has no `"start"` script in its `package.json` -
  it exercises wcvm's own real fallback (`npm run`'s documented "no `start` script + a `server.js`
  file at the root -> `node server.js`" behavior, matching real npm) instead of a hand-written
  `"dev"` script. Since a plain server has no HMR, editing `server.js` restarts the whole process
  from scratch (`server.kill()` then a fresh `npm start`) rather than writing the file and waiting
  for a watcher to pick it up - the shared preview pane needed no new code for this at all:
  `preview.ts`'s existing `onListen()` wiring already blanks the iframe to `about:blank` on
  `unlisten` and points it at the new listener on the next `listen`, so a restart just looks like
  an ordinary page reload from the outside. The example's own page has zero client JS: its counter
  increments via a real `<form method="post" action="/count">`, a genuine full-navigation POST the
  server redirects back to `/` - proving the preview relay/absolute-routing pipeline built for
  Vite/HMR works just as well for a server with no client-side JavaScript at all, and (since the
  counter is plain in-memory server state) that restarting on edit genuinely resets it, not just
  cosmetically. `collect`/`buildTree` (`viteExample.ts`'s own small helpers for streaming a
  process's output and turning a flat file map into a `FileSystemTree`) were exported and reused
  rather than duplicated, since neither one was ever actually Vite-specific. Shares the one preview
  pane with the other three examples, extending their mutual exclusion to four-way. Verified: an
  always-on Playwright test for the page wiring, and an opt-in one (`WCVM_E2E_VITE=1`, real
  registry) for the full flow - install, the counter incrementing via plain HTML form POSTs with no
  JS, an edit restarting the server and genuinely resetting the counter, and the four-way mutual
  exclusion. A full, clean `pnpm exec playwright test` run (122 passed, 7 opt-in skipped) and
  `vitest run` (898/898) confirm no regressions.
- **Svelte was attempted as a fifth example and PARKED - a real, structural blocker in wcvm's own
  ESM loader, not a version-pinning issue.** Wired up exactly like the Vue example
  (`@sveltejs/vite-plugin-svelte@^6.2.4`, the last major compatible with vite@7 - 7.x needs vite@8+
  - `svelte@^5.0.0`, the same wasm `overrides` the other examples use), but Vite's dev server
  failed before ever serving a single request - it couldn't even load its own config:
  `EsmResolveError: Circular static ESM import involving
  ".../svelte/src/compiler/utils/ast.js" is not supported yet (use a dynamic import() to break the
  cycle)`. Confirmed by reading Svelte's real published source directly, not assumed:
  `compiler/utils/ast.js` imports `#compiler/builders` (a package.json `"imports"` self-reference
  resolving to `builders.js`), and `builders.js` imports straight back `./ast.js` (for
  `has_await_expression`) - a genuine, static, mutual circular ESM import inside Svelte's own
  compiler, not anything about this example's own project files. Real Node's native ESM linker
  handles this without issue (real circular-module support: live bindings across the cycle, and
  function declarations - hoisted - are usable before the rest of the cycle finishes
  initializing). wcvm's own ESM loader can't, by design: it creates one `blob:` URL per module up
  front (`esm/loader.ts`'s `prepare()`, dependency-first), and a `Blob`'s content is fixed at the
  moment it's constructed - so two modules that each need to embed the other's URL in their own
  rewritten source can never both be created first. This is the exact same constraint
  `ERR_CIRCULAR_ESM_NOT_SUPPORTED` already documents (see "ES modules" above and PLAN.md's "Known
  differences") - the first time it's been hit by a real, widely-used package's own internals
  rather than a hand-written circular-import test case. **Confirmed version-independent, not a
  pinning problem, before giving up on it**: even `svelte@5.0.0` (the oldest published 5.x, which
  predates the `ast.js`/`builders.js` cycle above entirely - checked directly, `builders.js` at
  that version doesn't import `ast.js` at all) still fails, on a DIFFERENT genuine cycle deeper in
  the compiler (`compiler/phases/3-transform/client/utils.js`) - Svelte's compiler module graph has
  more than one real cycle, structurally, across its whole published history, not one fixable spot.
  A real fix would need the ESM loader to detect strongly-connected components in the static import
  graph and merge each one into a single blob (the same thing a real bundler's own chunking already
  does to resolve cycles) - genuine runtime work on the order of the Rolldown/worker-pool platform
  investigations elsewhere in this file, not something that belongs in a template-adding task.
  Asked the user how to proceed (park it vs. invest in real circular-ESM support vs. ship it
  committed-but-non-functional); parked, in favor of the Express example above. The Svelte
  template/wiring/tests written while investigating this were reverted, not left half-committed -
  revisit only if circular-ESM support becomes a priority for its own sake, and re-verify against
  Svelte's then-current source rather than assuming this writeup is still accurate (the ecosystem
  moves; the exact cycle location already changed once between 5.0.0 and 5.57.1).
- **FIXED and RE-VERIFIED (2026-09-29).** The circular-ESM support this section said would need
  "genuine runtime work on the order of the Rolldown/worker-pool platform investigations" was
  actually built, driven by hitting the SAME `ERR_CIRCULAR_ESM_NOT_SUPPORTED` constraint for real
  again - not in Svelte this time, but in zod v4's `core.js`/`util.js` (reached transitively through
  `@tanstack/router-plugin`, while adding a TanStack Router template to Studio's picker). The fix
  (`runtime/esm/loader.ts`'s `discover()`/`computeSccs()`, `runtime/esm/cyclic.ts`'s
  `rewriteCyclicModule()` - both have their own full design-history doc comments, including the two
  rejected approaches: a single-edge dynamic-import bridge that DEADLOCKS, and a CJS-style snapshot
  that loses live-binding semantics and breaks the real target case) is exactly the strongly-
  connected-component merge this writeup predicted would be needed. Once it landed and was proven
  against TanStack Router's own real cycle, Svelte was re-verified against it directly - re-added to
  Studio's picker (`svelte-ts`, create-vite's own official template, no hand-written recipe needed -
  unlike this section's now-obsolete from-scratch wiring above) with one plugin pin
  (`@sveltejs/vite-plugin-svelte` -> `^6.2.4`, still the last major compatible with this sandbox's
  pinned vite@7 - confirmed again directly against the current registry, not assumed stale) and
  verified end to end in real Chromium against the real npm registry: install, dev server start, and
  the scaffolded app actually rendering. The circular-ESM fix's own full design writeup (including
  the two rejected approaches) lives in `runtime/esm/loader.ts`'s and `runtime/esm/cyclic.ts`'s own
  doc comments, not duplicated here; see `apps/studio/.../templateProjects/vitePins.ts`/
  `constants.ts` for the Studio-side wiring this entry is actually about. A full, clean
  `pnpm exec playwright test` run (140 passed, 16 opt-in run with
  `WCVM_E2E_VITE=1`) and `vitest run` (1025/1025) confirm no regressions.
- **Tailwind CSS v4 was attempted as the next Studio template (after Svelte), hit a real, genuine
  deadlock, and was FIXED once the exact trigger was correctly isolated (initially misdiagnosed and
  parked, then reopened and actually solved - see below).** Full findings live in PLAN.md's
  "Tailwind CSS v4: feasibility findings" (2026-09-30) - this entry is the short version. Tailwind
  v4's `@tailwindcss/vite` plugin statically imports two native-Rust packages with zero plain-JS
  fallback: `@tailwindcss/oxide` (a `Scanner`) and, transitively, `lightningcss`. `lightningcss` was
  fixed cleanly (swapped for `lightningcss-wasm` via `overrides`, same trick as esbuild/rollup - its
  own "node" condition target turned out to already be sandbox-friendly: sync `fs.readFileSync` +
  sync `WebAssembly.Module`/`Instance`, no thread pool at all). `@tailwindcss/oxide` loads and runs
  basic native work too, via the same POST-INSTALL PATCH idea already used for `@rolldown/browser`
  (see this file's "ES modules"/Rolldown-WASM sections and PLAN.md) - reaching its own already-
  installed `-wasm32-wasi` sibling's real browser build (only ever reached, in real usage, via a
  bundler honoring the legacy `"browser"` package.json field, which plain Node resolution never
  does) by renaming its `.js` to `.mjs` and rewriting `@tailwindcss/oxide`'s own `index.js` +
  `package.json` into a small ESM re-export shim. Both fixes are real, proven, and kept as passing
  tests (`examples/playground/e2e/boot.spec.ts`'s "Tailwind v4 native deps" describe block).
  **The real blocker**: `Scanner.scan()` (native FS globbing/reading) spawns a WASI worker thread
  whose own file reads relay back to the creator thread's in-memory filesystem via `postMessage` +
  `Atomics.wait` - but the creator thread is ITSELF already frozen in its own separate `Atomics.wait`
  waiting for that same worker to finish. A genuine deadlock, confirmed directly (a heartbeat timer
  stops dead the instant `scan()` is called), not fixable via `asyncWorkPoolSize`/`RAYON_NUM_THREADS`
  (both tried, zero effect - a worker is unconditionally created regardless). `Scanner.scanFiles()`
  (content-based, no native FS access) avoids that specific deadlock for trivial content - building
  on it, `@tailwindcss/vite`'s own plugin bundle was patched to feed real file content via wcvm's own
  `fs.globSync` (which, along the way, surfaced and fixed a real, separate, Tailwind-independent gap
  - `internal/deps/minimatch` wasn't vendored yet, so `fs.globSync`/`fs.glob` threw unconditionally;
  fixed via the standard `discover-node-lib.mjs` flow - see CLAUDE.md's Status). This genuinely
  produced real Tailwind CSS (`@layer theme/base` Preflight, confirmed via a direct fetch).
  **First diagnosis, later found WRONG**: the deadlock seemed to reappear whenever scanned content
  contained a real `import` statement (confirmed - at the time - in isolation), leading to an initial
  conclusion that ANY realistic component file (virtually all of which have imports) was unscannable
  and the feature was PARKED. Asked to keep investigating anyway; systematically varying ONE thing
  at a time (not just the presence of an import) found the real, narrower rule: **any single
  `scanFiles()` call whose total input spans MORE than one line deadlocks** - a leading blank line,
  a leading comment line, or a real `import` line all reproduced it identically, and so did passing
  TWO single-line entries together in one call (neither alone multi-line). Exactly one entry,
  exactly one line, per call never dispatches to the worker pool and always returns immediately.
  **Fixed for real**: call `scanFiles()` once per non-blank line instead of once per file - proven
  against a realistic, multi-line file with real Tailwind classes scattered throughout (20 lines,
  ~11ms, correct candidates including an `import` line among them) and then end to end in a real
  Vite dev server: real Tailwind CSS generating and applying, checked via a real computed style
  (Tailwind v4's own default theme uses OKLCH colors, not RGB - `oklch(0.511 0.262 276.966)` for
  `indigo-600`, confirmed against Tailwind's own published theme). Shipped as Studio's "Tailwind"
  template (`apps/studio/.../templateProjects/tailwindTemplateProject.ts`). Lesson: the FIRST
  isolation that "confirms" a hypothesis by removing one variable and seeing the symptom disappear
  is not automatically the real variable - the fix here only fell out of testing several
  DIFFERENT isolated variants (a leading blank line alone, with no import at all, reproduced the
  exact same hang), not just re-confirming the first one twice. A full, clean
  `pnpm exec playwright test` run (143 passed, 19 opt-in run with `WCVM_E2E_VITE=1`) and
  `vitest run` (1025/1025) confirm no regressions.
- Tests: 1025 Vitest + 143 Playwright (Chromium; 19 of them opt-in, needing the real npm registry:
  `WCVM_E2E_VITE=1`). See "Verifying".

## Ember (Studio template) and `require(esm)` (2026-10-01)

Asked to add Angular and Ember. Ember worked; Angular did not (see below). Ember 7.3's Vite blueprint
(`@ember/app-blueprint` + `@embroider/vite`) looked easy - real Node built it with `vite@7.3.6` - but
running it in wcvm found a chain of real gaps, each fixed at its root (not per package):

1. **`require('constants')`** missing (graceful-fs loads it): vendored Node's own `lib/constants.js`.
2. **`/tmp` didn't exist** (`os.tmpdir()` says `/tmp`; `@embroider/shared-internals` `realpathSync`s it).
   Core's VFS root stays empty (tests assert that) - Studio creates it at boot (`lib/wcvm/index.ts`).
3. **Global `MessageChannel` ports had no `oninit`** (`rsvp` does `port1.onmessage = fn`): the
   messaging binding wrapped only its own copy. Once `worker_threads` (io.js) loads, its prototype
   swap made the raw global's `onmessage` setter throw. Now the wrapper is also installed as the
   global, only when the runtime owns a real worker global (`installGlobal`; under Vitest the global
   is the test runner's own and the wrapper recursed forever). The bridge also now drops messages
   for ports whose `oninit` never ran, instead of crashing the worker.
4. **No `require(esm)`** - `ember-cli` requires ESM-only packages (`find-up`, `execa`, `inquirer`,
   ...). Per-package shims would never end, so it's real: `esm/syncRequire.ts` rewrites an ES module
   into a synchronous function body (live getters on `exports`, defined first so cycles see them;
   imports become `__wcvm_import_sync__` calls resolved with the ESM conditions; shorthand
   properties (`{ x }`) needed `freeReferences` to report them - a latent bug in the cyclic rewriter
   too). Format: extension / package `"type"` / Node's syntax detection (compile first, run second,
   so a SyntaxError from a *dependency* never re-runs the module as ESM).
5. **`Error.prepareStackTrace` call sites**: `get-caller-file` (ember-cli finds its commands with it)
   got `undefined` from `getFileName()` for eval'd code - only `getScriptNameOrSourceURL()` has it.
6. **`import(new URL(...))`** - the bridge assumed a string; ember-cli loads `ember-cli-build.mjs`
   with `import(pathToFileURL(...))`.
7. **ESM resolver**: no `"exports"` field -> any subpath is just a file (was rejected), legacy
   `"main"` probing; and `exports` pattern conflicts follow `PATTERN_KEY_COMPARE`
   (`@embroider/macros` maps both `./src/*` and `./src/*.js`; the first used to win, giving
   `node.js.js`). The same pattern bug was in `cjs.ts`.
8. **`npx`**: `@embroider/vite`'s `buildOnce` runs `npx vite build` through a shell. Minimal local-bin
   `npx` added (no registry). Its failure was invisible: the outer `reject()` passes no error, so
   Vite died with "Cannot destructure property 'stack' of 'e$1' as it is undefined" - found by
   wrapping every plugin hook to see which one rejected with a falsy value.
9. **`JOBS=1`**: with all of the above the log stopped at broccoli-babel-transpiler's "transformString
   is parallelizable" - its worker-process pool never answers here. `JOBS=1` (its own documented
   switch) transpiles inline; Studio's shells set it. Root cause of the pool hang is not investigated.
10. **Preview**: Ember's history router sees `/__wcvm_preview__/<port>/` as an unknown route
    (`UnrecognizedURLError`, the same class of issue as TanStack's basepath); the template uses
    `locationType: "hash"`.

Verified in real Chromium against the real registry (`WCVM_E2E_VITE=1`): install (~1150 packages,
~12s), dev server start (~25s cold), "Welcome to Ember" rendered in the preview iframe. Tests:
`runtime/requireEsm.test.ts` (12), resolver/`npx`/`constants` unit tests, and 5 always-on + 1 opt-in
Playwright tests (`boot.spec.ts`, "require(esm) and the gaps Ember's toolchain hit" / "Ember template").

**Angular**: done later the same day - see "Angular (Studio template)" below.

### Ember: starter page and TypeScript (2026-10-01)

The template got a Vite-style starter page (hero with the Ember and Vite logos, "Get started", a
`Counter` component, links) instead of the blueprint's bare heading, and a TypeScript variant
(`ember-ts`: `.ts`/`.gts`, `@babel/plugin-transform-typescript`, `tsconfig.json`, Glint types - the
real `ember new --typescript` output). Both are one recipe (`emberRecipe.ts`'s `buildEmberFiles(ts)`);
the Playwright test runs both and clicks the counter (a `.gjs`/`.gts` component, so it also proves the
TypeScript + template-tag pipeline).

## Angular (Studio template) (2026-10-01)

`ng serve` for Angular 22 runs in wcvm and renders in the preview. The recipe is in
`angularRecipe.ts` (Angular's real `ng new` output, generated with real Node 24). Getting there was a
chain of real wcvm gaps, found one at a time by making each failure visible first:

1. **The "silent exit 0" was three different things.** (a) `/tmp` missing made Angular's own error
   reporting fail quietly; (b) `rollup` had no wasm override; (c) a real event-loop bug (below). A
   ref'd keep-alive timer in a trap script hid (c) for days - the probe "worked" with it and silently
   exited without. Lesson: when a fix needs a keep-alive to work, the keep-alive is the bug report.
2. **Event loop idleness (real bug, `runtime/eventLoop.ts`)**: `turn()` decided "nothing ref'd
   remains" synchronously and finished the process, but a promise continuation (microtask) that ran
   afterwards could still queue `process.nextTick` work or start handles (Angular's `checkPort`: listen
   -> close -> resolve -> the next await starts more work). Real Node drains ticks and microtasks
   before deciding. Now idleness is confirmed on a later macrotask, re-confirmed while a round made
   progress, and the queued tick check wakes the loop. Regression test: `runtime.test.ts` "staying
   alive across promise continuations" (fails without the fix).
3. **Worker pools hang**: Piscina (Angular's JS transformer/TS compiler pool) defaults to `atomics:
   'sync'`, which waits on `receiveMessageOnPort` - impossible in a browser (`bindings/messaging.ts`).
   `@angular/build`'s own `WorkerPool` switches to `atomics: 'disabled'` when
   `process.versions.webcontainer` is set, so wcvm now sets it (that also turns off Angular's
   persistent cache and native sass). Same family as the broccoli-babel-transpiler pool hang that
   `JOBS=1` works around for Ember.
4. **`sh` fd redirects**: `getconf ... 2>&1 || true` (detect-libc, via lmdb) hit "background jobs
   ('&') are not supported". `sh` now has `N>file`, `>&N`/`2>&1`, `&>file` and `/dev/null`, applied in
   order like a real shell.
5. **`require(esm)` bugs only real packages exposed** (the old per-package overrides had hidden
   them): a module declaring its own `__dirname`/`exports`/globals collided with the wrapper's
   parameters (now a private parameter set plus a block scope for the body); `export default
   <imported name>` produced overlapping edits (cli-spinners); and `freeReferences` never walked
   parameter DEFAULTS (`function f(x = importedFn())`), so `getFileSystem` in `@angular/compiler-cli`
   was never rewritten - an existing gap in the scope analysis the cyclic rewriter shares.
6. **`EventTarget` marker**: `events.setMaxListeners(n, abortSignal)` (listr2) rejected the browser's
   `AbortSignal`; setting Node's `nodejs.event_target` marker on the platform `EventTarget`
   constructor is all `isEventTarget()` checks.
7. **Overrides that are no longer needed**: every downgrade the old probe pinned (yargs 17,
   magic-string 0.30, @inquirer/prompts 7, ora 5, parse5-html-rewriting-stream 6, listr2 10) and its
   source patch that rewrote `require()` into `import()` - the latter actively broke `__importStar`
   (`.default` became the whole namespace). Real `require(esm)` makes both unnecessary.
8. **What remains (in the recipe)**: vite -> the shared 7.3.6 pin and esbuild/rollup/@parcel/watcher
   -> WebAssembly builds via `overrides`; `oxc-parser` replaced by a stub after install (its WASM
   parser deadlocks on multi-line input like Tailwind's Scanner, and is only *called* for the OXC
   linker, which `NG_BUILD_BABEL_LINKER=true` turns off); `NG_BUILD_OPTIMIZE_CHUNKS=false` (the only
   production path needing native `rolldown`); hash routing (`withHashLocation`) for the preview
   prefix. The `NG_BUILD_*` variables are set by Studio's shell terminals (`IdeController.ts`).

Verified in real Chromium against the real registry: install (~30s), `ng serve` (~12s to "Local:"),
"Hello, ng-app" rendered in the preview iframe, and in the real Studio UI through Chrome. Also new:
`process.versions.webcontainer`, `sh` fd redirects, the `EventTarget` marker.

## Studio editor: formatting, highlighting, file icons (2026-10-01)

- **Prettier** (`format.service.ts`): registered as Monaco's document formatter for every supported
  language, so the Format button, ⇧⌥F (also from outside the editor, via AppShell), the command
  palette and Monaco's context menu share one path. Vue/Svelte blocks use the real script/style
  plugins. `.gjs`/`.gts`: each `<template>` is masked with an identifier placeholder (not a template
  literal - ASI would parse it as a tagged template), the JS/TS is formatted, bodies go through the
  Handlebars parser and are spliced back indented; regions come from `content-tag`'s parser.
  Dead end: `prettier-plugin-ember-template-tag` is CommonJS that `require()`s a top-level-await module,
  which Vite's optimizer rejects. A production build also failed until `prettier` was aliased to
  `prettier/standalone` (prettier-plugin-svelte imports the Node entry, `index.cjs`).
- **Highlighting**: Monaco has no grammar for Vue/Svelte/gjs/gts, so they were plain text. `languages.ts`
  clones Monaco's own html/javascript/typescript Monarch grammars and prepends rules (mustache and
  Svelte blocks as embedded JavaScript, `lang="ts"`/`scss`/`less` on script/style, `<template>` as
  embedded Handlebars).
- **Icons**: `fileIcon/` - framework brand marks plus labelled badges, exact file names before extensions.
- Also: Studio's preview tab reloads when its port listens again (Angular's port check bound and
  released 4200 before the real server started, so the tab opened on a dead port).

## Fullstack templates: what they needed from the runtime (2026-10-01)

Bringing SvelteKit, React Router 7 and Astro to Studio's picker exposed four real gaps (each reproduced
in real Chromium against the real registry first, then fixed at the cause rather than worked around):

1. **`AsyncLocalStorage`** (`runtime/asyncContext.ts`). `new AsyncLocalStorage()` died in
   `internal/promise_hooks` (not vendored; it drives V8 PromiseHooks, which a Worker doesn't have). That
   one constructor call is made at startup by `@nestjs/cli` (via `@inquirer/core`), SvelteKit's dev server,
   Next.js, React Router and Nuxt. Replaced `internal/async_local_storage/async_hooks` (the vendored copy is
   now unused) and added an inert `internal/promise_hooks`. The store is held for the whole `run()` - for
   an async callback, until its promise settles (a raw `await` resumes through a reaction nothing in JS can
   observe) - and `Promise#then`, `queueMicrotask`, `process.nextTick`, timers and `setImmediate` capture
   every live store when scheduled. Two honest limits, both shared with vivari: ONE current value per
   instance, not per async chain (two overlapping `run()`s can see each other's store - fine for a dev
   server handling a request at a time); and the OUTERMOST `run()` leaves its store in place afterwards
   (a nested one restores its parent), because a streaming render returns from `run()` as soon as the
   stream exists and keeps rendering detached - restoring "no store" there made Next.js throw "Expected
   workUnitAsyncStorage to have a store". `getStore()` outside a run therefore answers with the latest
   request's store, not `undefined`; `disable()` clears it. `process.nextTick` is patched on the `process` the loader hands the
   module, which is not necessarily `globalThis.process`.
2. **Cyclic ESM, local re-exports** (`runtime/esm/cyclic.ts`, `loader.ts`). `export { createComponent }`
   of a binding imported from a sibling in the same cycle was deleted from the rewritten module (the
   import it named is gone), so a module OUTSIDE the cycle importing it natively found no export at all -
   `astro/runtime/server/index.js` came out with an EMPTY namespace ("does not provide an export named
   'createComponent'"). Each such name is now a real native `let slot; export { slot as name }`, filled in
   by a new `__wcvm_cycle_ready__` bridge the moment the sibling's registry has the value (a one-time
   copy, not a live binding). A waiter whose getter reads yet another unfinished sibling throws, so it
   stays queued and is retried after the next install (found by running Astro, not by the unit test).
3. **`node:http2` named exports.** Astro's node adapter does `import { Http2ServerResponse } from
   "node:http2"`; an ESM named import of a missing export is a link-time SyntaxError. The shim now exports
   `Http2ServerRequest`/`Http2ServerResponse`.
4. **`WorkerGlobalScope` is hidden from guest code** (`runtime.ts`). Real Node has none; a process worker's
   global does, so libraries sniffing it believed they were in a web worker. prismjs (Astro's markdown
   pipeline) then added a `message` listener that `JSON.parse`s every message - and the kernel posts this
   worker object messages: an uncaught `"[object Object]" is not valid JSON` that killed `astro dev` and
   `astro sync` before they printed a line. Chromium-only (Vitest's `globalObject` is never `self`).

Studio notes: Astro 7 needs Vite 8 (Rolldown, no WASM build here) - Astro 6 (`^6.4`, vite ^7) is the
version that runs. React Router's client router must be told the preview prefix at runtime
(`window.__reactRouterContext.basename`, set in `app/entry.client.tsx`), exactly like the TanStack Router
template; SvelteKit needs nothing (its dev HTML derives `base` from `location`).

Next.js 16 (webpack + WASM SWC) added more, each found by running it and reading the real error:

5. **`require.extensions` / `Module._extensions`** (`runtime/cjs.ts`). `next dev` died on
   `require.extensions['.js']` ("Cannot read properties of undefined") - the hook Next's `next.config.ts`
   loader, ts-node, @babel/register and esbuild-register all register transpilers through. The loader
   now dispatches through a real handler table (`.js`, `.json`, `.node` defaults; resolution tries every
   registered extension; the longest registered extension wins), and each module gets a `_compile` that
   hooks wrap. `.node` now fails with `ERR_DLOPEN_FAILED` instead of being run as JavaScript.
6. **More public builtins.** `stream/consumers`, `punycode`, `sys` and `console` are vendored verbatim;
   `stream/web` is the platform's own classes (Node's version is a second implementation behind
   `internal/webstreams/*`, so `require("stream/web").ReadableStream` would not equal the global one).
7. **`stdio: "inherit"` for async `spawn`/`fork`** (`bindings/childProcess.ts`). The child's output was
   silently dropped - `next dev` forks its server that way, so it just exited with no message at all.
   A child's fd 1/2 inherited (or given as bare fd numbers) now forwards to the parent's own stdout/stderr.
8. **`inspector` loads** (`shims.ts`). It threw on require like a Node built `--without-inspector`; Next
   requires it unguarded and asks `inspector.url()` (undefined = no debugger). `open`/`waitForDebugger`/
   `Session#connect` still throw `ERR_INSPECTOR_NOT_AVAILABLE`.
9. **`v8`** gained the commonly used surface (`getHeapStatistics` from `performance.memory`, heap
   space/code statistics, `setFlagsFromString` no-op, `cachedDataVersionTag`, ...).
10. **`vm` contexts.** webpack evaluates `/* webpackChunkName */` comments with `vm.createContext` +
    `runInContext`. A real separate V8 context is impossible in a Worker; sandbox properties become the
    code's scope (`with` + a Proxy), `globalThis`/`this` are the sandbox (Next's manifests do
    `globalThis.__RSC_MANIFEST = ...` and read it off the sandbox), anything else falls through to this
    realm - so no `instanceof` isolation. Also `Script#runInContext`, `runInNewContext`, `compileFunction`.
11. **`internal/webstreams/adapters`** (`runtime/webStreamAdapters.ts`): `Readable/Writable/Duplex
    .fromWeb/.toWeb` over the platform's streams. Next calls `Readable.toWeb(req)` for every request; the
    missing module destroyed every page response before a byte was written (the log still said `GET / 200`).
12. **Errors that used to vanish.** A process worker now writes an uncaught glue-level error to its own
    stderr (it was a nameless `null` on the host page); a socket/pipe `close` callback runs through the
    event loop so `process.exit()` in a `'close'` listener exits instead of escaping.

How it was found (worth repeating): `next dev` printed nothing and exited 1. Fixing `stdio: "inherit"`
first made the child's real errors visible, one after another. Then `GET / 200` with zero bytes on the wire:
tracing `http.ServerResponse`/`net.Socket` from the forked child (a tracer `require`d first by patching
`start-server.js`, appending to a file synchronously) showed `res.destroy(err)` with err = the missing
adapters module. Patching `pipe-readable.js` instead showed nothing for pages: the app-page runtime
bundles its own copy.

Studio notes: Next needs `node_modules/next/wasm/@next/swc-wasm-nodejs` (what `next dev` falls back to
"downloading"; wcvm's npm never runs `postinstall`, so the template creation links it from the installed
`@next/swc-wasm-nodejs` - a symlink, not a 30 MB copy). The first page request compiles for ~15-25 s.

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
  `path events buffer util stream timers console fs os assert readline child_process net dgram
  http zlib crypto worker_threads url querystring tty perf_hooks process` (plus hand-written
  `module`, `tls`/`https` and `inspector` - see Phase 8)
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
  pipe in a `net.Socket`); real TCP and UDP are both done now (see below), DNS is not (`tty_wrap`/
  `cares_wrap` are inert stubs). `child.stdin.write()`/`.end()` deliver for
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
  `import()` breaks the cycle instead, same as it does in real bundled/served ESM. `import.meta`
  is rewritten too, to the module's real `file://` URL/filename/dirname/resolve (not the blob's).
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
  not the FS Worker (`kernel/kernelSyncServer.ts` - process supervision lives in the kernel, a
  different thread from the fs SAB's FS Worker servicer). `kernel/processes.ts`'s `onExit` hook
  buffers the child's whole stdout/stderr (instead of streaming it live to a parent worker or the
  host) and delivers it all at once, when the child exits, alongside its status/signal - real
  `spawnSync` semantics need the complete output atomically, not a stream. The `input` option is
  written to the child's stdin, which is then always ended (no interactive follow-up - matches
  real batch semantics); `timeout` kills the child with SIGTERM via a plain `setTimeout` in the
  kernel (not a virtual event loop - the Kernel Worker doesn't run one). See "Known differences"
  for the two simplifications (output must fit the SAB window; only default `stdio: 'pipe'` is
  honoured).
- `child_process.fork()`/IPC is Node's real module too - unlike `execSync`/`spawnSync`, an async
  problem, not a blocking one, and it reuses `spawn()`'s existing machinery almost entirely
  unchanged: `fork()` itself just normalizes arguments and calls `spawn("/bin/node", [...execArgv,
  modulePath, ...args], options)` (`child_process.js:130-179`). The only genuinely new piece is
  the ipc channel: `Pipe` (`bindings/childProcess.ts`) gained a `kind: "stdio" | "ipc"` tag so an
  "out"-direction pipe's writes route through new `IChildProcessHost.writeIpc`/`endIpc` instead of
  `writeStdin`/`endStdin` - the kernel needs to route the two differently (four new message types,
  `kernel/processes.ts`, mirroring the existing stdin/stdout convention: `child:ipc`/`child:ipcEnd`
  parent-to-kernel, plain `ipc`/`ipcEnd` kernel-to-child, plain `ipcOut`/`ipcOutEnd` child-to-kernel,
  `child:ipcOut`/`child:ipcOutEnd` kernel-to-parent). The forked child's own side (`createForkIpcPipe`
  in `bindings/childProcess.ts`) builds a `Pipe` sharing the SAME `ctx` object already passed to
  `createInternalBinding` (critical: `setupChannel`'s `channel.onread` reads the realm's shared
  `streamBaseState`, so a different `ctx` reference would build a second, disconnected router) and
  hands it straight to `internal/child_process.js`'s real, exported `setupChannel(process, pipe,
  "json")` - called directly from `runtime.ts`'s bootstrap, bypassing vendored `_forkChild`/
  `NODE_CHANNEL_FD` entirely (no real fd to pass around; `_forkChild`'s own body is a few lines,
  reimplemented as our own non-vendored glue, the same way `process.stdin`'s Readable already is)
  - including the ref-counting `_forkChild` wires up separately from `setupChannel` itself
  (`process.on('newListener'/'removeListener', ...)` calling `control.refCounted()`/
  `unrefCounted()`), which keeps the process alive only while it has a `'message'`/`'disconnect'`
  listener - miss that piece and a forked child exits immediately instead of staying alive,
  the entire point of `fork()` (see "Lessons learned").
  Vendored `internal/child_process/serialization` for real (was missing - added to
  `manifest.json`); only `serialization: 'json'` (the real default) works, since `'advanced'`
  needs a real V8 serializer (`runtime/shims.ts`'s `v8` stub exists only so the module *loads* -
  see "Known differences"). See "Lessons learned" for three real bugs only the mandatory
  Chromium e2e (and one Vitest test racing against a real timeout) caught (`Pipe.deliver()`'s EOF
  signal; `Pipe.close()` needing to notify the other side; the missing ref-counting wiring above).
- `fs.watch`/`fs.watchFile` are Node's real modules (`internal/fs/watchers.js`, already vendored)
  over two very different `internalBinding`s. `watchFile` (`StatWatcher`, `bindings/fs.ts`) is
  pure local polling - no fs worker or kernel involvement at all: a native (module-import-time
  captured, like `eventLoop.ts`'s own `nativeSetTimeout`) timer repeatedly calls the same
  `fs.stat()` a script could call itself, comparing the whole raw stat array against the previous
  poll (matching real `uv_fs_poll`'s memcmp - not just the nlink-only heuristic the JS wrapper's
  `onchange` happens to also do) and firing only when something differs; the very first poll only
  seeds a baseline, same as real libuv. `watch` (`FSEvent`) is real push events, needing a new
  channel the FS Worker never had: it owns a watch registry (path, recursive, owning clientId -
  `fs/FsServer.ts`) reached via two new opcodes (`OP_WATCH_START`/`STOP`, reusing `FLAG_RECURSIVE`);
  `Vfs.ts` gained a public, mutable `onChange(path, kind)` field (`"rename"` a name
  appeared/disappeared/moved, `"change"` content/attributes changed) that every mutating method
  now calls, including the fd-based ones (`write`/`ftruncate`/`futimes` - fs.writeFileSync is
  ENTIRELY fd-based under the hood here too, exactly like real Node's own `writeFileUtf8` fast
  path: `open()` then `write()` then `close()`, so a fd's `IFdEntry` gained the path it was opened
  with; a rename elsewhere after that leaves it stale, a known/documented simplification, POSIX
  fds not being path-addressed anyway). `open()` deliberately does NOT itself report O_TRUNC's
  truncation as a change: `writeFileSync`'s default `'w'` flag is `O_CREAT|O_TRUNC`, and reporting
  the open-time truncate AND the following write would double-fire for one logical save (found by
  the Vitest suite: a real test asserting one 'change' per write got two, verbatim-vendored-code
  faithfully replicating an obscure, easy-to-miss Linux inotify quirk that isn't what real fs.watch
  users actually observe or expect) - `fs.truncateSync` isn't affected, it already goes through
  `open('r+')` + `ftruncate()`, which does report. The FS Worker's own watch dispatch reaches
  whichever client (pid) registered a matching watch via a NEW, unprompted `self.postMessage` (not
  a syscall response - nothing else the fs worker sends is unprompted) that `kernel/index.ts`
  reassigns `fsWorker.onmessage` to route, once ready, to `kernel/processes.ts`'s new `notifyWatch`
  - the same "Kernel Worker already has a postMessage channel to every process worker" shape
  `spawnSync`'s SAB channel and `fork()`'s IPC routing used, per the note this item was picked up
  from. `FSEvent.close()` also drops its own `onchange` (not just the registry entry): a burst of
  changes from one write can already have several `loop.post()`ed deliveries in flight, and a
  "stop after the Nth change" callback closing mid-burst should not still fire for ones that
  hadn't run yet (also Vitest-caught). `unregisterClient` (a process exiting) purges that client's
  watches, so a dead pid can't accumulate registry entries forever. Verified end-to-end in real
  Chromium not just for one process watching its own writes, but for the HOST's own `wc.fs.*`
  waking a process's `fs.watch`, and for one real process's write waking a DIFFERENT real
  process's watch, both routed through the kernel exactly as above.
- `net.createServer`/`net.connect` are Node's real `net.js` (already vendored, over the real
  `tcp_wrap`) backed by a virtual network entirely inside the kernel - no real socket, so a
  "connection" is two Process Workers' own `TCP` handles relayed byte-for-byte through the
  kernel (`kernel/netServer.ts`), the same postMessage shape `child_process`'s stdin/stdout/ipc
  already use. `listen()` alone needs a synchronous, globally-coordinated answer (port `0` ->
  the real assigned port; an explicit port already taken -> real `EADDRINUSE`) to match real
  `net.js`'s own contract (it emits `'listening'` right after `handle.listen()` returns `0`, with
  no further async confirmation awaited) - a THIRD per-process SAB (`OP_NET_LISTEN`,
  `protocols/syscall.ts`), serviced by the kernel exactly like `spawnSync`'s own second one
  (`kernel/netServer.ts`'s `service`, mirroring `kernel/kernelSyncServer.ts`). `connect()`/reads/
  writes are all naturally async, ordinary postMessage relay. `stream_wrap`'s shared
  `streamBaseState` scratch array (real read/write completions live there, per realm) used to be
  private to `child_process.ts`'s own router; pulled out to `runtime/bindings/streamBaseState.ts`
  so `net.ts`'s own router can share the SAME instance `net.js` itself expects (it destructures
  `stream_wrap` independently of `tcp_wrap`/`pipe_wrap` - a second, disconnected array would
  silently break reads/writes). No IPv6 (`bind6`/`connect6` always fail, exactly like a machine
  with no IPv6 would - real `net.js` already falls back to IPv4 gracefully on its own) and no
  Unix-domain sockets (`net.connect({path})`; `pipe_wrap`'s real `Pipe` class stays scoped to
  `child_process` stdio). `require('net')` needs a working `dns.lookup()` (its own default
  `net.connect({port})` has no explicit host - `'localhost'` is the default - and resolving
  that needs a real DNS module this sandbox doesn't have) and `cluster.isPrimary` (`net.js`'s
  `Server.listen()` checks it unconditionally, even outside any actual cluster usage) - both
  small, hand-written shims (`runtime/shims.ts`): `dns.lookup()` always resolves to this
  sandbox's one virtual loopback address (there is no real network to resolve a hostname
  against), and `cluster.isPrimary` is always `true` (there is only ever one process per
  listener, nothing to balance). A connecting/listening `TCP` handle refs the event loop itself,
  like a real `uv_tcp_t` would - miss that and a script doing nothing but `net.connect(...)`
  sees an idle loop and exits before the (inherently async) result ever arrives, a real bug the
  Vitest suite caught immediately. See "Known differences" for the fixed virtual address/family,
  and for `open()`'s deliberately-*not*-double-firing `fs.watch` behavior this surfaced too (a
  content write anywhere - `net`, plain `fs`, doesn't matter - now goes through the same fd path).
  Verified end-to-end in real Chromium for a real client process connecting to a real server
  process on an explicit port with data flowing both ways, `listen(0)` auto-assigning different
  real ports to two different real processes, a second real process getting a real `EADDRINUSE`
  on an already-used port, and a real `ECONNREFUSED` connecting to a port nobody is listening on.
- `http.createServer`/`http.request`/`http.get` are Node's real `http.js`/`_http_server.js`/
  `_http_client.js`/`_http_outgoing.js`/`_http_common.js`/`_http_agent.js`/`_http_incoming.js`
  (already vendored), running entirely on top of `net` (above) - `http` opens no socket of its
  own, it drives a real `net.Socket`/`net.Server`. The one genuinely new piece:
  `internalBinding('http_parser')` (real Node's is `llhttp`, a native C++/Wasm binding, so unlike
  everything else in this sandbox it can't be vendored as JS). `runtime/bindings/httpParser.ts`'s
  `HttpMessageParser` is a hand-written, from-scratch HTTP/1.1 wire-format incremental parser
  (request-line/status-line, flat `[name, value, ...]` header pairs, `Content-Length` body
  framing, chunked transfer-encoding decode, close-delimited bodies for HTTP/1.0-style responses,
  keep-alive - one parser instance reused across messages on a connection - and pipelining -
  several requests parsed out of one `execute()` call). `runtime/bindings/http.ts`'s `HTTPParser`
  class wraps it to match the exact shape real vendored `_http_common.js` expects: numeric-indexed
  callback "slots" (`parser[kOnHeadersComplete] = fn`, the JS-land equivalent of a C++ binding's
  private slots), a `ConnectionsList` class, and a flat `methods`/`allMethods` array. Real HTTP
  framing semantics implemented directly rather than via llhttp's callback-return-value pause
  protocol (not implemented - see "Known differences"): HEAD responses, and 1xx/204/304 status
  codes, have no body regardless of any `Content-Length` present, checked fresh on every
  `execute()` call since `_http_client.js` only sets `parser.outgoing` (whose `.method` this reads)
  once, before any response bytes can arrive. `HTTPParser.execute()`'s own try/catch only catches
  its own `HttpParseError` (a genuinely malformed message) - anything else thrown from deep inside
  `onHeadersComplete`/`onBody` (i.e. from user code the request/response event chain reaches, up
  to and including a request handler's own `process.exit()`) must propagate untouched, exactly as
  it would through a real synchronous native call stack with no JS boundary in the middle; a
  blanket catch-and-return-Error here silently swallowed `process.exit()`'s `ProcessExit` throw
  and hung the process forever - caught immediately once an actual `http.createServer()` handler
  was tested end-to-end, not by any unit test of the parser in isolation. Verified end-to-end in
  real Chromium for a real client process GETting from a real server process (status, headers,
  and body all round-tripping) and a real client process POSTing a body that a real server process
  streams and echoes back.
Also done - preview Service Worker relay, `wc.preview.onListen()`, and a real iframe pane wired
into the playground UI (the full Phase 6 scope, not just the "Service Worker relay only" slice from
its own `AskUserQuestion`): `wc.preview.enable()` + `wc.preview.url(port, path)` +
`wc.preview.onListen(handler)` (fires on `net:listen`/`net:unlisten`, a new unprompted
kernel-worker-to-host event backing `kernel/netServer.ts`'s `onListenChange` hook), plus
`examples/playground/src/preview.ts` pointing a real `<iframe>` at `url(port)` the instant a
script's `.listen()` succeeds. `apis/Preview.ts` (moved here from a top-level `src/preview.ts` to
match `apis/Fs.ts`/`apis/Process.ts`'s existing convention; `IPreviewApi` now exported from
`index.ts` too). See CLAUDE.md's Status section for the full design writeup and THREE real bugs
found getting the iframe case working (the Service Worker relay's `resultingClientId` hang for a
navigating iframe, COEP blocking the iframe's embed, and - the actual root cause of the hardest
symptom - `net.ts`'s `TCP.close()` conflating an accepted connection's own `.port` field with
"this is the listening server", which silently killed a still-running server the moment any one of
its connections closed), plus the earlier `netServer.connect()`'s connectResult-before-incoming
notify order (harmless for a real process but not for the kernel-synchronous `PREVIEW_PID`
sentinel `previewRelay.ts` uses - fixed with a `queueMicrotask`). Own unit tests
(`kernel/previewRelay.test.ts`, `workers/kernel/handlers/preview.test.ts`, `kernel/
netServer.test.ts`, `apis/Preview.test.ts`, and a `runtime/net.test.ts` regression test for the
`TCP.close()` bug - verified to actually fail without the fix) and 4 Playwright tests (the
original 3 plus a new `"preview UI"` describe exercising the real iframe end-to-end) all pass; a
full, clean `pnpm exec playwright test` run (78/78) confirmed no regressions.

Also done - the Fetcher Worker, Phase 7's first piece: `wc.fs.fetch(url, path)`. A dedicated,
persistent worker (`workers/fetcher/`, architecturally a sibling of the FS Worker - one for the
kernel's whole lifetime, its own real fs client via the now-shared `attachFsClient`) does real
`fetch()` calls, capped at 10 concurrent in-flight requests on its own thread (overlap comes from
several concurrent `fetch()` promises, not OS parallelism, so one worker running many at once is
enough), each streamed straight into the VFS via the fd-based open/write/close path
`fs.writeFileSync` itself uses (chunked at `FD_CHUNK` if a response chunk is bigger than the
syscall window). `kernel/fetcher.ts` is the kernel-side promise-map half (mirrors
`previewRelay.ts`'s own one-shot-async-op shape); `workers/fetcher/fetcherRuntime.ts` is kept free
of `self` so its queueing/streaming logic is fully Vitest-testable (mirrors `workers/process/
run.ts`'s split between testable core and thin wiring). See CLAUDE.md's Status section for the
full writeup and test list.

Also done - OPFS persistence, Phase 7's second piece: `boot({ persist: true | { root: string } })`
mirrors `wc.fs.*` to the real Origin Private File System, write-behind, and restores from it
before the FS Worker's first syscall - decided at boot, not a post-boot `enable()`, since that
ordering guarantee is the whole point. `fs/opfsPersistence.ts` has both directions
(`restoreFromOpfs`/`createOpfsMirror`), kept free of any real OPFS global so a fake in-memory
implementation can stand in for Vitest; `FsServer` gained a third constructor param
(`onPersist`, called from the same `vfs.onChange` closure watch dispatch already uses) rather than
knowing anything about OPFS itself. `workers/fs/worker.ts` gained the same "init" -> (async
restore) -> "ready" boot handshake the Fetcher Worker already has (it used to post "ready"
unconditionally at import time - fine with no persistence to restore first, not once there is).
OPFS has no symlinks, so a script's own symlinks are not persisted (a documented simplification).
See CLAUDE.md's Status section for the full writeup, including two real gotchas (write-behind
needing a serialized queue to avoid a stale result racing a fresher one; restore needing to
finish before the mirror is even wired up, or it would write straight back what it just read).
Also done - `zlib` (Phase 7's third piece, and real npm's first concrete blocker resolved - see the
2026-09-23 feasibility findings below): Node's real vendored `lib/zlib.js`, unmodified, over an
`internalBinding('zlib')` backed by the browser's real, native `CompressionStream`/
`DecompressionStream` rather than a WASM/pure-JS zlib port. Covers `Deflate`/`Inflate`/`Gzip`/
`Gunzip`/`DeflateRaw`/`InflateRaw`/`Unzip` - both the streaming `Transform` classes
(`zlib.createGzip()` etc., pipeable) and the convenience functions (async callback, promisified,
and the blocking `*Sync` family) - plus `zlib.crc32()`. Not done: Brotli/Zstd (the Compression
Streams API supports neither format at all, so `new zlib.BrotliCompress()` etc. throw a plain
`TypeError` - `binding.BrotliEncoder` is simply absent) and true mid-stream flush
(`.flush()`/`Z_SYNC_FLUSH`/etc. - the Compression Streams API has no "flush without closing"
primitive, only `close()`, which ends the stream for good; a non-finish flush is accepted but is a
no-op). `windowBits`/`memLevel`/`strategy`/`dictionary` are accepted but ignored, same treatment as
`net`'s fixed virtual address.
- **Key design simplification**: every real caller that matters here (a piped `Transform`, and the
  `*Sync` convenience functions) only truly needs output once the whole input is known
  (`.end()`/finish) - real zlib's own C streaming API (`avail_in`/`avail_out`, many small calls each
  draining a bounded output buffer) has no equivalent in the Compression Streams API anyway (push
  bytes in, read whatever's ready, close to finish - no per-call bounded output, no forced
  mid-stream flush). So `bindings/zlib.ts`'s `Zlib` class accumulates every input chunk across
  calls, and only actually runs `CompressionStream`/`DecompressionStream` **once**, on a
  finish-flagged call: write the whole thing, close, drain the reader fully
  (`runZlibOnce(format, direction, wholeInput)`, a small shared, stateless codec core). That single
  result is then handed out across possibly-multiple `write()`/`writeSync()` calls, bounded by each
  call's own `out_len` - exactly the "not done, call me again" loop the *unmodified* vendored
  `zlib.js` (`processCallback` for async, `processChunkSync` for sync) already drives; the binding
  only has to report `state[0]`/`state[1]` (availOutAfter/availInAfter) honestly each call and, for
  the async path, invoke the real `processCallback` function captured at `init()` time - the same
  "implement the low-level step, let vendored JS own the state machine" split this repo already used
  for `httpParser.ts`. Trade-off, documented: output is produced once, on finish, not dribbled out
  per input chunk - fine for whole-package-sized npm tarballs, revisit with a background
  reader-pump if a real large-file case shows it matters.
- **Sync path, genuinely blocking**: `Atomics.wait`-blocking the calling Process Worker while also
  `await`-ing a Promise on that same thread is a deadlock, so `*Sync` needs a second real thread to
  run `CompressionStream` on - the same problem `execSync`/`spawnSync` and `net.listen()` already
  solved. Unlike `net.listen()`, zlib has no cross-process/global state to coordinate, so rather than
  a fourth per-process SharedArrayBuffer, it reuses the existing sync SAB
  (`protocols/syscall.ts`'s new `OP_ZLIB_SYNC = KERNEL_OPCODE_MIN + 2`, alongside `OP_SPAWN_SYNC`) -
  `kernel/spawnSyncServer.ts` was renamed `kernel/kernelSyncServer.ts` (`createKernelSyncServer`)
  since it now dispatches on opcode between two unrelated blocking capabilities instead of being
  spawn-specific, and its `serviceZlibSync` calls the SAME `runZlibOnce` the async path uses,
  directly in the Kernel Worker's own realm (`CompressionStream` is an ordinary Worker global there
  too) - `respondOk`/`respondErr` once the promise settles, same "service() kicks off async work,
  responds later" shape `OP_SPAWN_SYNC` already has via `onExit`. Combined output must fit the 1 MiB
  SAB window (`EMSGSIZE` otherwise), the same documented limit `OP_SPAWN_SYNC` already has for its
  own stdout+stderr.
- **Two real bugs found and fixed, both only surfaced by an actual Gzip→Gunzip pipe, not by
  `runZlibOnce`'s own direct tests or the sync path**: (1) `drain()` used
  `this.pendingOutput ?? new Uint8Array(0)` and then unconditionally wrote the result back to
  `this.pendingOutput` - turning a `null` "nothing computed yet" into a non-null, merely-empty
  array the very first time `drain()` ran (even on the "just buffering, nothing to compute yet"
  branch). Since `null` vs. "computed, possibly empty" is exactly the signal `write()`/`writeSync()`
  use to decide whether the whole-buffer compression has already run, this made the FINISH-flagged
  call silently take the "already computed, just drain" branch instead of ever actually calling
  `runZlibOnce` - `gz.end(str)` ran (buffered its input, produced nothing), and `gunz` then received
  an empty finish-only call and failed to decompress zero bytes ("incorrect header check"). Fixed by
  leaving `pendingOutput` untouched (not reassigned to an empty array) when it started `null`. (2) On
  a `runZlibOnce` rejection, the async path called `this.fail(error)` (routing to `onerror` ->
  `self.destroy(error)`) but then let the promise chain continue on to *also* drain/report
  state/invoke `processCallback` for the same failed operation - real Node's native binding treats
  success and failure as mutually exclusive outcomes for one write; doing both left a `zlib.gunzip()`
  callback seeing neither a clean error nor a clean result. Fixed with a two-armed
  `.then(onSuccess, onFailure)` instead of a `.then().catch().then()` chain, so only one path ever
  runs. Neither bug was catchable by testing `runZlibOnce` in isolation (it has no state to get
  confused) or by the sync path (whose caller throws immediately on error, before ever consulting
  the post-error state) - only an actual multi-call streaming sequence with a real vendored
  `Transform` pair exercises the exact call pattern that exposed them.
- Also found, testing-environment-only (not a bug in this code): under **plain Node/Vitest**,
  Node's own global `DecompressionStream` is itself a shim wrapping Node's own native `zlib` Gunzip
  stream (`node:internal/webstreams/adapters`) - a malformed-input rejection there can surface as a
  process-level unhandled-rejection warning if nothing has attached a handler to the internal pump
  promise yet, purely an artifact of Node's own polyfill's internal timing (a real browser's
  `DecompressionStream` is a native, unrelated implementation). Fixed defensively in
  `runZlibOnce` with a same-tick no-op `.catch()` on the pump promise so it's never reported
  unhandled, independent of when the real, still-propagated rejection is actually awaited.
- Verified: `runtime/bindings/zlib.test.ts` (12 Vitest: `runZlibOnce` round-trips and malformed-input
  rejection directly; the streaming `Transform`/callback/`util.promisify`/`Unzip` auto-detect/error
  paths against a real Node `CompressionStream`/`DecompressionStream`; the `*Sync` path against a
  fake `spawnSync` client backed by Node's own `zlib` module - same "prove the wire protocol, not
  the real servicer" spirit `spawnSync.test.ts`'s own fake already established; `crc32` against
  known vectors and Node's own output), `kernel/kernelSyncServer.test.ts`'s new `OP_ZLIB_SYNC`
  cases (a real gzip round trip and a malformed-input error, run for real since Node has
  `CompressionStream` globally too). 2 new Playwright tests in real Chromium (a streaming
  `createGzip()`/`createGunzip()` pipe round trip, and a `gzipSync`/`gunzipSync` round trip proving
  the real kernel-mediated blocking path) - neither the real native browser `CompressionStream` nor
  the genuine cross-thread `Atomics.wait` blocking path can be exercised outside Chromium. A full,
  clean `pnpm exec playwright test` run (85/85) and `vitest run` (553/553) confirm no regressions.
- Also done - `crypto` (hashing only; real npm's second missing-builtin finding, scoped down with
  the user first - see "Real npm: feasibility findings" below): NOT vendored source, unlike almost
  everything else in this sandbox - real Node's own `crypto.js` unconditionally requires ~15
  internal modules just to be `require()`-able at all (cipher, sig, hash, x509, certificate, kem,
  webcrypto, random, argon2, pbkdf2, scrypt, hkdf, keygen, keys, diffiehellman), most needing
  native-crypto features (KeyObject/PEM export, X.509 certificates, DiffieHellman groups, scrypt,
  argon2) the Web Crypto API has no equivalent for at all - far more than real npm's own actual
  need (sha512/sha1 package integrity checks) justifies. `runtime/shims.ts`'s `cryptoShim` is
  instead a small hand-written module, in the same "deliberately simplified real module" category
  `dns`/`cluster` already are there: `createHash`/`Hash` (`.update()`/`.digest()`, chainable,
  matching real Node) backed by the real, native `SubtleCrypto.digest()` (`internalBinding
  ('crypto')`, `bindings/crypto.ts`) - only SHA-1/256/384/512 (exactly what `SubtleCrypto.digest()`
  itself supports; no md5/sha224/sha3-*/blake2*) - plus `randomBytes`/`randomUUID`, backed by the
  real `crypto.getRandomValues()`/`crypto.randomUUID()` globals directly (already synchronous, no
  bridging needed at all, unlike digest). `Hash.digest()` is synchronous but `SubtleCrypto.digest()`
  isn't, so digest needs the exact same kernel-mediated sync bridge `zlib`'s own `*Sync` family
  does - a new `OP_CRYPTO_DIGEST_SYNC` opcode (`protocols/syscall.ts`), serviced by
  `kernel/kernelSyncServer.ts` right alongside `OP_SPAWN_SYNC`/`OP_ZLIB_SYNC` (same one shared SAB;
  no cross-process state to coordinate here either). Everything else real npm doesn't need
  (ciphers, DiffieHellman, X.509 certificates, KeyObject, ...) is simply absent - the same honest
  "not a function"/"not a constructor" failure shape `zlib.ts`'s own missing Brotli/Zstd support
  already has. Verified: `bindings/crypto.test.ts` (7 Vitest, against a fake `OP_CRYPTO_DIGEST_SYNC`
  servicer backed by Node's own `crypto.createHash` - proves the wire protocol, the same spirit
  `zlib.test.ts`'s own fake already established - including a known SHA-256 test vector, chunked
  `update()` calls matching one big call, and a clear error for an unsupported algorithm),
  `kernel/kernelSyncServer.test.ts`'s new `OP_CRYPTO_DIGEST_SYNC` cases (a real digest via
  `SubtleCrypto.digest()`, since Node has it globally too). 2 new Playwright tests in real Chromium
  (a `createHash('sha512')` digest cross-checked against Node's own `crypto.createHash` for the
  same input, and `randomBytes`/`randomUUID` producing real, distinct values) - the real browser
  `SubtleCrypto`/`crypto.getRandomValues()` can't be exercised outside Chromium. A full, clean
  `pnpm exec playwright test` run (87/87) and `vitest run` (562/562) confirm no regressions.
- `dgram` (real UDP - the first item of the roadmap's standalone "UDP/DNS" item, worked
  step-by-step after real npm was deferred): Node's real vendored `lib/dgram.js`/
  `internal/dgram.js`, unmodified, over a real `internalBinding('udp_wrap')`
  (`runtime/bindings/udp.ts`), mirroring `tcp_wrap`'s own "no real sockets, relay through the
  kernel" design (`kernel/netServer.ts`, now handling BOTH protocols) but connectionless: no
  listen()/accept(), just `bind()` (claim a port) and `send()` (fire-and-forget to whoever, if
  anyone, is bound to the destination port - a real OS UDP socket drops silently when nobody's
  listening, so this does too, no error surfaces to the sender). UDP and TCP are separate port
  namespaces (`kernel/netServer.ts`'s own separate `udpBindings` map and ephemeral-port
  allocator), the same way two real sockets never collide just because they share a port number.
  Real `dgram.js`'s own `Socket.prototype.bind()` calls `state.handle.bind()` SYNCHRONOUSLY and
  returns its error code directly (unlike TCP, where the port-conflict check is deferred
  specifically to `listen()`) - so `bind()` needs the exact same globally-coordinated,
  kernel-mediated answer `OP_NET_LISTEN` gives TCP's `listen()`. Rather than a new per-process
  SAB, this reuses `OP_NET_LISTEN`'s existing one under a new opcode (`OP_UDP_BIND`,
  `protocols/syscall.ts`) - `kernel/netServer.ts`'s own `service()` now dispatches between the two
  by opcode, the same "one shared SAB, multiple unrelated opcodes" shape
  `kernel/kernelSyncServer.ts` already established. Only udp4: `bind6()`/`connect6()`/`send6()`
  all fail `EAFNOSUPPORT`, matching `tcp_wrap`'s own IPv6 stance - real `internal/dgram.js`'s own
  `newHandle()` only swaps a handle onto those variants for an explicit
  `dgram.createSocket('udp6')`, so a plain (default) `udp4` socket never reaches them.
  Multicast/broadcast (`addMembership`, `setBroadcast`, ...) have no meaning in a single virtual
  host - accepted, no-op, the same treatment `zlib.ts`'s ignored `windowBits`/`memLevel`/etc.
  already has. `handle.lookup` needed no work at all: real `internal/dgram.js`'s own
  `newHandle()` already binds it straight to the existing, already-shimmed `dns.lookup()`, never
  touching this binding.
  - **Real bug found and fixed, only surfaced by an actual receiving socket, not a
    connect-refused-style unit test**: `send()`'s own synchronous "finish" return value
    (`total + 1`, matching real `dgram.js`'s own `if (err >= 1) {...} ` convention for "done, no
    `req.oncomplete` needed") delivers a datagram to the DESTINATION side's own `onmessage` -
    which turned out to be handed a plain `Uint8Array`, not a real (sandbox) `Buffer`, so
    `msg.toString()` in a guest script's `'message'` handler printed comma-joined byte values
    (`TypedArray.prototype.toString`'s own inherited behavior) instead of decoding the bytes as
    text. Real Node's native binding constructs a real Buffer before ever calling into JS -
    `dgram.js`'s own `onMessage(nread, handle, buf, rinfo)` just re-emits `buf` as-is, with no
    wrapping step of its own - so this binding has to do the same: `bindings/udp.ts`'s
    `UdpRouter.dispatch()` now wraps every incoming chunk with the sandbox's own vendored
    `Buffer.from(...)` (via `requireBuiltin("buffer")`, the same "get the real class from the
    vendored module, don't reach for a platform one" pattern `childProcess.ts`'s own exec()/
    execFile() output already uses) before handing it to `onmessage`. Caught immediately by a
    quick manual smoke test exercising a real receive handler with `msg.toString()`, before any
    formal Vitest coverage was even written for it.
  - Verified: `runtime/udp.test.ts` (6 Vitest: `bind(0)` makes a real synchronous
    `OP_UDP_BIND` call and reports the assigned port; an explicit port already bound surfaces as a
    real `'error'` event with `EADDRINUSE`; `close()` releases the port via `unbind()`; `send()`
    implicitly binds an ephemeral port first, then reaches the host as real bytes; an incoming
    datagram fires `'message'` with a real `Buffer` and the sender's port in `rinfo`; a datagram to
    a port nobody's bound to is simply never delivered, with no hang), `kernel/netServer.test.ts`'s
    new UDP cases (6: auto-assigned ephemeral port; TCP and UDP as genuinely separate namespaces on
    the same port number; a real `EADDRINUSE` for a second bind; `udpSend()` delivering to the
    right pid and silently dropping when nobody's bound; `udpUnbind()`'s real-owner-only
    semantics; `udpReleasePid()` dropping every port a pid held). 4 new Playwright tests in real
    Chromium (a real client process sending a datagram to a real server process which echoes it
    back; `bind(0)` auto-assigning different real ports to two different real processes; a second
    real process binding an already-bound port getting a real `EADDRINUSE`; a datagram to a port
    nobody's bound to being silently dropped, not a hang) - none of the actual cross-Process-Worker
    postMessage relay can be exercised in the single-threaded Vitest suite. A full, clean
    `pnpm exec playwright test` run (91/91) and `vitest run` (574/574) confirm no regressions.

Real npm (vendoring the actual CLI) was investigated and DEFERRED: `zlib`/`crypto`, its two
missing-builtin blockers, are both done (above), but its fetch stack (`make-fetch-happen` →
`minipass-fetch`) turns out to have no path to a real network at all from inside wcvm's 100%
virtual `net`/`http` - confirmed by reading the actual installed source, not assumed - and
continuing past that (patching a real dependency's transport, or a from-scratch custom installer)
was explicitly declined in favor of parking the feature. See "Real npm: feasibility findings"
before picking this back up.

Verified by Vitest (574) and Playwright in real Chromium (91), including a script reading a
file the host wrote and the host reading what the script wrote.

Not done: real npm (deferred - see above; a minimal built-in `npm install` is done instead, see
CLAUDE.md's "Status"), DNS (`dns.lookup()` is a fixed-address shim, not a
real resolver - UDP itself is now done, see `dgram` above), `process.binding`, `node -p`.
(`worker_threads` is done - see CLAUDE.md's "Status".)

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
  uid/gid report 1000.
- fd numbers come from one VFS table shared by all processes (each process's fds are closed
  when it exits or is killed, checked in Chromium), so they are not 3,4,5... per process.
- The process worker bundle is ~1.9 MB because it contains the whole runtime (acorn, vendored
  for ESM, is real added weight; vendored `zlib.js` added more); every process pays to parse it
  even for `echo`. Split `node` into its own worker entry if that shows up.
- `assert`'s "show the failing expression" enrichment (`assert(x)` with no message) tokenizes the
  failing line with Node's real vendored acorn (`internal/deps/acorn`, outside `lib/` - vendored
  via `scripts/vendor-node-lib.mjs`'s `repoPathFor`, added for ESM's own parsing needs; see
  "ES modules" above) via `internal/errors/error_source.js`'s `getFirstExpression`. That part is
  real. What's not: `internalBinding('errors').getErrorSourcePositions` (`bindings/misc.ts`) gets
  real file/line/column from V8's `Error.prepareStackTrace`, but has no way to recover the
  literal source text a `v8::Message` would carry, so `sourceLine` is always `""` - the real
  tokenizer runs on an empty string, correctly yields zero tokens, and the enrichment degrades to
  a plain message. `assert(x)` still throws `AssertionError` either way.
- (No longer a difference: ESM's `import.meta.url` used to be the module's `blob:` URL - it's
  rewritten to the real `file://` URL now, see CLAUDE.md's "Status".)
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
- `fork()`'s default `stdio` is `'inherit'` (real fd-sharing with the parent, which this sandbox
  can't do - `child.stdout`/`.stderr` end up `null`, exactly like real Node's own `'inherit'`
  behavior, just with nowhere for that output to actually go). Pass `{ silent: true }` to get the
  usual piped/captured `child.stdout`/`.stderr` - a real, already-vendored option, not a
  wcvm-specific workaround. Only `serialization: 'json'` (the default) is supported for `fork()`'s
  ipc channel; `'advanced'` needs a real V8 serializer this sandbox doesn't have
  (`runtime/shims.ts`'s `v8` stub only exists so `internal/child_process/serialization.js` can
  load at all - `class ChildProcessSerializer extends v8.DefaultSerializer` needs the base class
  to exist, even though json mode never constructs it). Sending a handle
  (`child.send(msg, someSocketOrServer)`) isn't supported - real `net.Socket`/`net.Server` exist
  now (see below), but passing one over an ipc channel to another process isn't wired up. Raw
  `child.stdio[3]` access to the ipc pipe isn't supported, only
  `.send()`/`.on('message')`/`.disconnect()`/`.channel` - covers the overwhelming majority of
  real `fork()` usage.
- `fs.watch`/`watchFile` (see "Current state" for the full design): a fd's watch-relevant path is
  fixed at open() time, so a write through a fd opened before its file was renamed elsewhere is
  still attributed to the old path (POSIX fds aren't path-addressed; a rare case). `open()`'s own
  O_TRUNC truncation deliberately does not report a change by itself, only a write that follows
  does - otherwise `writeFileSync`'s default flag (`O_CREAT|O_TRUNC`) would double-fire one
  logical save as two events. A recursive `fs.rm(dir, {recursive:true})`'s ASYNC form reports one
  event per descendant (real vendored `internal/fs/rimraf.js` walks the tree via ordinary
  unlink/rmdir calls, which are already hooked); the SYNC `fs.rmSync` reports only the top-level
  path, matching real Node's own split (sync always takes a single C++ `binding.rmSync` call,
  never the JS-level walker `rimraf.js` is).
- `net`: every address, on both ends of every connection, is the same fixed virtual loopback
  (`127.0.0.1`/`IPv4`) - this sandbox is a single virtual host, so there's nothing else to
  report (`runtime/bindings/net.ts`). No IPv6 (`bind6`/`connect6` always fail - real `net.js`
  already falls back to IPv4 gracefully on its own, the same way a machine with no IPv6 would)
  and no Unix-domain sockets (`net.connect({path})`). `dns.lookup()` doesn't do a real lookup -
  every hostname resolves to the same virtual loopback address (`runtime/shims.ts`), since
  there's no real network to resolve one against.
- `dgram`: the same fixed virtual loopback address/family as `net` above, for the same reason
  (`runtime/bindings/udp.ts`). No IPv6 (`bind6`/`connect6`/`send6` always fail) and no multicast/
  broadcast (`addMembership`/`setBroadcast`/etc. are accepted but no-ops) - nothing for either to
  mean in a single virtual host with one address. A datagram to a port nobody's bound to is
  silently dropped, matching a real OS UDP socket's own unreliable-delivery contract - no ICMP
  port-unreachable is modeled.
- `http`: the hand-written parser (`runtime/bindings/httpParser.ts`, see "Current state") doesn't
  implement llhttp's callback-return-value pause-at-headers protocol, used by real Node for
  `CONNECT`/raw-`Upgrade` proxying (returning a sentinel from `kOnHeadersComplete` to say "stop,
  don't read the body yet"). Ordinary GET/POST/response handling never needs it - an
  Upgrade/CONNECT is still detected and handled, just via a different, already-implemented
  mechanism (the parser stops at the blank line ending the headers and reports how many bytes of
  the current chunk it actually consumed, so the caller can hand the rest to a different
  protocol). Trailing headers after a chunked body's terminating `0\r\n` are consumed (so parsing
  the next keep-alive message isn't corrupted) but not surfaced as `message.trailers` - real
  Node's own incremental `kOnHeaders` callback path, which would deliver them, is never used here
  (see the file's header comment: headers are always delivered whole, since real Node's JS already
  falls back gracefully when they arrive that way).
- Preview WebSockets (`kernel/previewWebSocket.ts`, `workers/preview/webSocketShim.ts`, see Phase 8
  below): no `Sec-WebSocket-Accept` verification (the peer is always a guest server in this
  sandbox), no extensions (permessage-deflate is never offered), no cookies on the handshake, and
  `Origin` is always `http://localhost:<port>`. The page's `error` event fires before EVERY unclean
  close (a real browser only guarantees it for a failed connection). The shim is an inline
  `<script>`, so a guest page whose own CSP forbids inline scripts never gets it; a compressed
  (`Content-Encoding`) HTML document isn't injected at all. A page opened with no same-origin wcvm
  page embedding it (or as its opener) falls back to the real `WebSocket`, which reaches nothing.
- `perf_hooks` (`bindings/performance.ts`): histograms keep EXACT values rather than HdrHistogram's
  3-significant-figure buckets (same percentile rules, so small histograms match real Node exactly;
  big ones are more precise than Node's, not less). No GC/http2/net/dns performance entries are ever
  produced (nothing native to observe); `nodeTiming`'s startup milestones all read as the process's
  own start, and `eventLoopUtilization()`/`loopIdleTime` report no idle time.
- `url`: `url.format(urlObject, { unicode: true })` keeps an IDN host in punycode (the platform URL
  has no punycode decoder to ask); `URLPattern` is the browser's own (Chromium has one).
- `module` (`runtime/moduleBuiltin.ts`): no `register()`/`registerHooks()` customization hooks,
  `_extensions` handlers can't be replaced (calling one throws), no `runMain`.
- `http2`: loads, but can't do anything - `createSecureServer` throws `ERR_NO_CRYPTO`, cleartext
  `createServer`/`connect` throw `ERR_METHOD_NOT_IMPLEMENTED` (no nghttp2).
- A builtin export whose lazy getter can't load here (`util.setTraceSigInt`, `net.BlockList`,
  `net.SocketAddress`) is `undefined` as an ESM named import, and throws "not vendored yet" on use
  through the module object.
- `crypto` stays hashing + randomness only (see `crypto` in "Current state"): md5, sha1,
  sha224/256, sha384/512 (plain JS, bindings/hash.ts) - no ciphers, keys, certificates, md4,
  sha3-* or blake2*.
- `tls`/`https`: load, but can't do anything (`ERR_NO_CRYPTO`) - no TLS stack behind wcvm's
  virtual sockets. `inspector` can't even be required (`ERR_INSPECTOR_NOT_AVAILABLE`), like a Node
  built without it.
- `npm` (`programs/npm/`): only `npm install` (from package.json, or named packages, saved the way
  real npm saves them). No lockfile (read or written), no install/lifecycle scripts (reported, never
  run - esbuild's postinstall included), no git/file/link/workspace/tarball-URL specs
  (`EUNSUPPORTEDPROTOCOL`), only npm's FLAT `overrides` form (`"name": "spec"` and `"$name"`;
  nested/versioned-key forms are warned about and ignored), no workspaces, no `.npmrc` (registry via `--registry` or
  `npm_config_registry` only), no auth/private registries. Optional dependencies with `os`/`cpu`
  restrictions are skipped unless they allow `cpu: wasm32` (every native build - nothing native can
  run here); a REQUIRED one is installed anyway, with a warning, instead of npm's `EBADPLATFORM`. A
  peer dependency that conflicts with an already-placed copy is kept as-is with a warning (npm would
  fail with `ERESOLVE`). Tarball symlinks/hardlinks aren't extracted (npm doesn't either).
  `npm run`/`start`/`stop`/`restart`/`test` (`runScript.ts`): no command-name abbreviation (real
  npm's `npm ru` also runs `run` - only the exact names/aliases listed in CLAUDE.md's "Status"
  work here), no `--json`/`--parseable` listing output, no workspaces, and only
  `npm_lifecycle_event`/`npm_lifecycle_script`/`npm_package_json`/`npm_package_*`
  (name/version/config/engines/bin) are set - not real npm's full breadth (`npm_config_*`,
  `INIT_CWD`, `npm_execpath`, ...), since there's no separate config system here to source most of
  those from. A missing package.json is the same simplified `ENOENT` shape `npm install` already
  uses, not real npm's much longer syscall-shaped message. A resolved bin's mode bits aren't
  checked - any file with a recognized `#!/usr/bin/env node` shebang runs regardless of its own
  executable permission, unlike a real shell.
  `npm create`/`npm init <name>` (`exec.ts`): only this one case of real npm's own `npm exec`/npx
  idea - an arbitrary `npm exec <command>` (resolving from local `node_modules/.bin` first, or an
  arbitrary registry package by name with no "create-"/"init-" mangling) isn't implemented. No
  dependency-tree resolution for the fetched package itself (fine for `create-vite` and most
  `create-*` tools, which bundle everything and declare zero runtime dependencies of their own -
  one that genuinely needs installed dependencies would fail to load them). No lockfile, no
  version-range spec beyond what `pickVersion` already supports for `npm install`, no git/file/
  workspace specs for the initializer itself.
- Preview absolute-path routing (`workers/preview/previewRouting.ts`): an absolute URL from a
  previewed page is REDIRECTED into its port's prefix, so `response.url` is the prefixed URL and a
  `fetch(url, { redirect: "manual" | "error" })` to one sees an opaque redirect/a network error. A
  request body that's a `ReadableStream` can't follow the 307. A navigation is attributed to a
  preview only by its referrer, so a page with `Referrer-Policy: no-referrer` navigating to one of
  its own absolute paths lands on the host's server instead. Requests to another origin are never
  touched.
- `zlib` (`bindings/zlib.ts`, see "Current state"): Brotli (`BrotliCompress`/`BrotliDecompress`) and
  Zstd (`ZstdCompress`/`ZstdDecompress`) aren't implemented - the Compression Streams API supports
  neither format, so their handle classes are simply absent (`new zlib.BrotliCompress()` throws a
  plain `TypeError`). True mid-stream flush (`.flush()`/`Z_SYNC_FLUSH`/`Z_PARTIAL_FLUSH`/
  `Z_FULL_FLUSH`) is accepted but a no-op - the Compression Streams API has no "flush what you have,
  stay open" primitive, only `close()` (ends the stream for good). `windowBits`/`memLevel`/
  `strategy`/`dictionary` are accepted but ignored - no equivalent control surface exists either.
  Output is produced once, on finish, rather than dribbled out per input chunk (every real chunk is
  accumulated and compressed/decompressed in one shot when the stream ends) - fine for
  whole-package-sized data, a documented memory/latency tradeoff for anything much larger.

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
  `spawnSync` (genuinely blocking, over a second SAB), `child_process.fork`/IPC (see "Current
  state" for all three).
- `net`/`http` moved to and completed under Phase 6.

### Phase 5 - Shell  (DONE)
- Small `sh`: `;` `&&` `||`, pipes, redirects, `node <file>`, an interactive REPL (done; see
  "Current state").
- Not done: `$` expansion, globbing, subshells, control-flow keywords, `&` background jobs.

### Phase 6 - Network + preview  (DONE - see "Current state"; only DNS remains, low-value, see below)
- Kernel port registry: `listen`/`accept`/`respond` (chunk large bodies) - done, see "Current
  state"'s `net` entry: a real virtual TCP network (`kernel/netServer.ts`), reached from guest
  code via a real `tcp_wrap` (`runtime/bindings/net.ts`). No separate `respond`/large-body
  chunking opcode was needed even for `http`: a response's bytes are just ordinary `net` writes,
  chunked by `http`'s own real vendored `Transfer-Encoding: chunked` framing when there's no
  `Content-Length`, exactly as real Node does over a real socket.
- `http.createServer`/`http.request`/`http.get` - done, see "Current state"'s `http` entry: real
  vendored `http.js` and friends over a hand-written `internalBinding('http_parser')`
  (`runtime/bindings/httpParser.ts`, `http.ts`), since llhttp is a native binding.
- Service Worker relay, `wc.preview.onListen()`, and an iframe pane wired into the playground UI -
  all done, see "Current state": `wc.preview.enable()`/`wc.preview.url()`/`wc.preview.onListen()`
  (`apis/Preview.ts`), `kernel/previewRelay.ts`, `workers/preview/PreviewServiceWorker.ts`,
  `kernel/netServer.ts`'s `onListenChange` hook, `examples/playground/src/preview.ts`.
- UDP (`dgram`) - done, see "Current state"'s `dgram` entry: `runtime/bindings/udp.ts`, a new
  `OP_UDP_BIND` opcode sharing `net`'s own SAB, `kernel/netServer.ts`'s separate `udpBindings`
  namespace.
- Remaining (not blocking this phase): DNS (`dns.lookup()` is a fixed-address shim for now, not a
  real resolver - there's no real network to resolve a name against in a single virtual host
  anyway, so this is low-value; revisit only if a real need for it surfaces).

### Phase 7 - Fetcher worker, real npm, persistence  (fetcher worker + OPFS persistence + zlib + crypto DONE - see "Current state"; real npm DEFERRED, see "Real npm: feasibility findings")
- Fetcher worker streaming into the VFS; parallel async fetches capped ~10 - done, see "Current
  state": `wc.fs.fetch()`, `kernel/fetcher.ts`, `workers/fetcher/`.
- OPFS mirror (write-behind), restored before serving syscalls - done, see "Current state":
  `boot({ persist })`, `fs/opfsPersistence.ts`.
- `zlib` (the first of the two missing builtins the feasibility investigation below flagged) -
  done, see "Current state": `bindings/zlib.ts`, `OP_ZLIB_SYNC`, `kernel/kernelSyncServer.ts`.
- `crypto` (the second missing builtin, scoped down to hashing only with the user first - see
  "Current state") - done: `runtime/shims.ts`'s `cryptoShim`, `bindings/crypto.ts`,
  `OP_CRYPTO_DIGEST_SYNC`.
- Real npm CLI. **Feasibility investigated 2026-09-23 - the actual blocker (npm's fetch stack has
  no path to a real network from inside wcvm) is now confirmed, not just suspected, and real npm
  is DEFERRED as a result - see "Real npm: feasibility findings" below before picking this back
  up.**
- `worker_threads` (`new Worker()`, not originally scoped as part of this phase, added ad hoc after
  UDP/`dgram`) - done, see CLAUDE.md's "Status" for the full writeup: `bindings/worker.ts`,
  `bindings/messaging.ts`, `bindings/locks.ts`, `workers/process/runWorkerThread.ts`,
  `IProcessInit.threadIdCounterSab`. Real platform gaps found and fixed there are significant
  enough to be worth reading before touching `MessagePort`/`MessageChannel` again for anything.

#### Real npm: feasibility findings (2026-09-23, no code written yet; `zlib`/`crypto` findings resolved - see "Current state")

Checked the locally installed npm CLI (v11.9.0) as a stand-in for what vendoring would mean: ~16MB,
984 JS files, a huge dependency tree (`node-gyp`, `@sigstore/*`, `tar`, `pacote`, `cacache`,
`make-fetch-happen`, `bin-links`, `semver`, `glob`, ...). Much bigger than either the Fetcher
Worker or OPFS persistence - budget accordingly, and re-scope with the user before committing to
the literal "vendor real npm" approach once they've seen the blocker below.

**Two load-bearing Node builtins were completely missing** (`packages/core/src/runtime/node/
manifest.json` had neither `zlib` nor `crypto`; no `bindings/zlib.ts`/`bindings/crypto.ts` existed):
- `zlib` - needed to gunzip registry tarballs (`.tar.gz`) and gzip-encoded HTTP responses. **Done**
  (see "Current state"): backed by the real, native `CompressionStream`/`DecompressionStream`.
- `crypto` - needed for the sha512 integrity checks `pacote`/`cacache` rely on throughout. **Done**
  (see "Current state"): `createHash`/`Hash` backed by the real, native `SubtleCrypto.digest()`,
  scoped to hashing only (not the rest of real Node's `crypto.js` - see the design note there for
  why) after confirming that scope with the user first.

**The deeper, architectural blocker: npm needs the real internet; wcvm's `net`/`http` are 100%
virtual.** `net.connect()` only ever resolves to another wcvm process listening on a virtual port
(`kernel/netServer.ts`) - there's no path from it to a real external host, and fundamentally can't
be one: browsers don't expose raw TCP sockets to JS at all, not even from a Worker. The only way to
reach the real internet from browser JS is `fetch()`/XHR/WebSocket. Real npm's registry client
(`make-fetch-happen` → `minipass-fetch`, itself built on Node's `http`) can't just work unmodified
against a real registry from here - it would need to be monkey-patched/reconfigured to use a real
`fetch()` instead, or wcvm would need a fundamentally different bridge.

**Resolved (2026-09-23): no, it doesn't.** Read the actual locally-installed source (npm v11.9.0's
own `node_modules/make-fetch-happen`/`node_modules/minipass-fetch`) rather than guessing:
`make-fetch-happen`'s `remote.js`/`fetch.js`/`index.js` all hard-`require('minipass-fetch')` with
no conditional path, and `minipass-fetch/lib/index.js` itself `require('http')`/`require('https')`
and makes the real request via Node's own `http.request()`/`https.request()` - there is no global-
`fetch()` delegation anywhere in this stack, at any layer, in any of the versions actually checked.
So the literal, unmodified npm CLI can never reach a real registry inside wcvm: its entire request
path runs on `http`/`https`, which are 100% virtual here.

**Decision (2026-09-23, asked explicitly rather than picked unilaterally, per the note above):
real npm is deferred, not pursued further for now.** The two ways around the blocker - patch
`minipass-fetch`'s transport to call a real `fetch()` (keeps npm's real CLI/resolution/lockfile
logic, at the cost of vendoring the whole ~16MB/984-file CLI and hand-maintaining a permanent patch
to a real dependency) vs. a much smaller custom installer written fresh against the real registry
REST API (no lockfile format, no workspaces, no `node-gyp` - just enough to fetch a manifest, pick
a tarball, and gunzip+untar it with the now-real `zlib`) - were both offered and explicitly
declined in favor of parking this feature entirely. Revisit by re-reading this section fresh
rather than assuming either path is still the right scope by the time it comes back up.

**Revisited (2026-09-24), for Phase 8: the minimal custom installer was chosen** (asked again
explicitly, against a prebuilt Vite snapshot or pausing Vite) - real npm itself stays deferred.
Done: a built-in `npm install` (`programs/npm/`), see CLAUDE.md's "Status". It fetches from the
real registry with the browser's own `fetch()` (not wcvm's virtual `http`), which is what makes it
possible at all - registry.npmjs.org answers `Access-Control-Allow-Origin: *` on packuments and
tarballs alike, so a CORS-mode fetch passes the page's COEP.

**One genuinely good finding: guest Node scripts already see several real browser globals**,
since nothing in the runtime bootstrap strips them (`globalObject: self` means a guest script's
global scope IS the real Process Worker's real `self` - see CLAUDE.md's existing gotchas on this).
Confirmed via a real Chromium `node -e` check (`typeof x` for each): `fetch`, `Response`,
`Headers`, `TextDecoderStream`, `CompressionStream`, `DecompressionStream` are all `"function"`,
and `crypto` is `"object"` with a working `crypto.subtle`. This is the SAME real global scope the
Fetcher Worker already calls `fetch` from directly (`workers/fetcher/fetcherRuntime.ts`).

Recommended next steps, in order:
1. ~~`CompressionStream`/`DecompressionStream` (real, native, already available) could back a
   vendored `zlib` `internalBinding` (gzip/deflate) without needing a WASM zlib port~~ - **done**,
   see "Current state"'s `zlib` entry: `bindings/zlib.ts`, backed by exactly that, plus a
   kernel-mediated `OP_ZLIB_SYNC` opcode for the blocking `*Sync` family (the same sync-bridge
   pattern `execSync`/`spawnSync`/`net.listen()` already use, reusing their existing per-process
   SAB rather than adding a new one, since zlib has no cross-process state to coordinate).
2. ~~`crypto.subtle` (Web Crypto API, already available) could back a `crypto` module for hashing
   (`createHash('sha256'/'sha512')`) - but it's async (`SubtleCrypto.digest()` returns a Promise)
   while Node's real `crypto.createHash().update().digest()` is synchronous. Same category of
   sync/async bridging the sync-syscall-over-SAB architecture already solves elsewhere~~ - **done**,
   see "Current state"'s `crypto` entry: a hand-written `crypto` module (not vendored - real
   `crypto.js` needs ~15 internal modules and native-crypto features Web Crypto can't back, far
   more than hashing needs), `bindings/crypto.ts`, a kernel-mediated `OP_CRYPTO_DIGEST_SYNC`
   opcode for the blocking `Hash.digest()` (same pattern as `OP_ZLIB_SYNC`, reusing the same
   shared SAB).
3. ~~Resolve the "real internet access" open question above before going further - it decides
   whether the rest of this is worth attempting as literally "vendor real npm" at all~~ -
   **resolved: no real-fetch delegation anywhere in npm's own fetch stack, and real npm is
   deferred** (see the "Decision" paragraph above) - not a blocker to work around right now, a
   closed question with real npm itself parked as a result.

No code was written or committed for the real-npm investigation itself; `zlib` and `crypto`
(steps 1 and 2) were each implemented and verified separately, tracked in "Current state" above.
Real npm itself (step 3's conclusion) is deferred - see the "Decision" paragraph above before
picking this back up.

### Phase 8 - Dev servers  (Vite dev + HMR DONE, under an opt-in e2e test - see CLAUDE.md's "Status")
- Vite dev + HMR over a WebSocket tunnel, templates. `fs.watch`/`watchFile` are already done (see
  "Current state") - picked up ahead of this phase, not blocking it.
- WebSocket tunnel for previewed pages - **done**, see CLAUDE.md's "Status": the preview SW
  injects `workers/preview/webSocketShim.ts` into every HTML navigation; the shim hands the host
  page a MessagePort per socket (`apis/Preview.ts`'s `createPreviewWebSocketRelay`); the kernel is
  the real RFC 6455 client (`kernel/previewWebSocket.ts`, `kernel/webSocketFrames.ts`) over a
  virtual TCP connection to the guest's own `'upgrade'` handler. Guest-side `'upgrade'` already
  worked unmodified.
- Absolute-path subresources in a preview frame - **done**, see CLAUDE.md's "Status": the preview
  SW redirects a previewed page's un-prefixed same-origin requests (`/@vite/client`, `fetch("/api")`,
  a link to `/about`) into that page's own port prefix (`workers/preview/previewRouting.ts`), keyed
  by the requesting client (recorded at its navigation; one async `clients.get()` for a client the
  SW has never seen) or, for a navigation, its referrer.
- Getting Vite into the VFS - **done** via a minimal built-in `npm install` (`programs/npm/`, see
  CLAUDE.md's "Status"; chosen over a prebuilt snapshot). Checked for real in Chromium against
  registry.npmjs.org: `npm install vite@7` resolves vite 7.3.6 plus 9 dependencies in ~6s, skipping
  the native `@esbuild/*`/`@rollup/*` optional builds.
- Dynamic `import()` from CommonJS/`node -e` code - **done**, see CLAUDE.md's "Status": it used to
  reach the browser's native `import()` and fail silently; `cjs.ts` now rewrites it to the same
  runtime bridge ES modules use (`esm/loader.ts`'s `rewriteScript`), parsing only source that might
  contain one.
- **Next: actually run Vite's dev server.** Its packages install with the native builds swapped
  for wasm ones via `overrides` (`"esbuild": "npm:esbuild-wasm@^0.25.0"`, `"rollup":
  "npm:@rollup/wasm-node@^4"` - done, flat form), 11 packages from the real registry in ~5s. A
  first real run (2026-09-24, Chromium) stops at once: `node:perf_hooks` isn't a builtin. Probed
  every `node:` builtin Vite 7's own code imports against a real wcvm process - 9 missing, all
  **done** now (see CLAUDE.md's "Status"), and so is `import.meta.url` as the module's real
  `file://` URL (it was the `blob:` URL; Vite finds its own files through it).
- **Vite's dev server runs** (2026-09-24): after package.json `"imports"`, `dns.promises`, an
  `http2` shim, the crypto members Vite uses, and tolerant builtin ESM facades (see CLAUDE.md's
  "Status"), an unmodified Vite 7.3 starts in ~1s and serves `/`, `/main.js` and `/@vite/client`
  through the preview relay. esbuild-wasm now works too (fd 0 reads, `child.unref()` and an
  inherited child `cwd` were the fixes - see CLAUDE.md's "Status"): Vite transforms TypeScript and
  pre-bundles npm dependencies.
- The page in a real preview iframe with HMR - **done**, and needed no new code: Vite's client
  connects over the preview WebSocket tunnel, chokidar sees edits through our `fs.watch`, and CSS
  and self-accepting modules hot-update without a reload (a non-accepting module gets Vite's full
  page reload, also working). Checked by an OPT-IN Playwright test (`WCVM_E2E_VITE=1`) that installs
  from the real registry - the user's call, to keep the repo lean: every building block has its own
  small offline test, and an always-on version needed a 5.4 MB committed registry slice (tried,
  then dropped and squashed out of history).
- React + TypeScript (`@vitejs/plugin-react`) runs with Fast Refresh - **done** (needed `file:` URL
  imports and pure-JS hashing, see CLAUDE.md's "Status"), and is now the playground's one-click
  example, with a live App.tsx editor.
- `npm run`/`start`/`stop`/`restart`/`test` - **done**, see CLAUDE.md's "Status" for the full
  writeup: pre/post hooks, the `start`/`restart` fallbacks, `--if-present`/`--ignore-scripts`, and
  a new `PATH`-search/shebang-exec capability in `sh` itself (`resolveExecutable`/`resolveCommand`)
  that this needed and any script can now use. The example now starts Vite with `npm run dev --
  --port 5173 --strictPort` instead of invoking `vite.js` directly.
- `npm create <name>`/`npm init <name>` - **done** (revisiting the "considered, deferred" note
  this used to be: the raw-mode-prompt risk turned out not to apply at all - see CLAUDE.md's
  "Status" for the full writeup, including two real ecosystem-version gotchas found verifying it
  against real `create-vite`).
- A second template, Vue + Vite (plain JS, `@vitejs/plugin-vue`) - **done**, see CLAUDE.md's
  "Status": the run/stop/edit machinery both examples share was pulled out into
  `src/viteExample.ts`, confirming the whole `npm install` -> `npm run dev` -> preview pipeline is
  generic, not React-specific. The two share the playground's one preview pane, so they're made
  mutually exclusive in the UI (starting either stops the other's dev server first).
- A third example, `npm create vite@latest` (`src/createViteExample.ts`) - **done**, including a
  real INTERACTIVE mode (`src/interactiveTerminal.ts`, an "interactive" checkbox) driving
  create-vite's own real arrow-key prompts, not just the silent `--no-interactive` path - see
  CLAUDE.md's "Status" for the full writeup, including a real, still-open ecosystem
  incompatibility this found (React's own "React Compiler" variant needs `@vitejs/plugin-react`
  6+, which needs `vite@8+`'s own `"vite/internal"` export - the same Rolldown/Wasm-trap version
  from the note below - so it's detected and fails with a clear message instead of a cryptic Vite
  crash, not actually supported) and a real, more consequential bug it surfaced along the way (a
  `stop()` guard added for cross-example mutual exclusion was ALSO silently swallowing this
  example's own start() failures before `vite` got assigned - not React-Compiler-specific, any
  scaffold/install failure).
- Left in this phase: more templates (Svelte, plain Node/Express) and npm workspaces.
- Known from old notes: Vite 8/Rolldown hit an upstream Wasm trap; Vite 7 with
  esbuild worked. Confirmed again directly (not just from old notes) verifying `npm create
  vite@latest`: its CURRENT template scaffolds Vite 8 by default, and Vite 7 pinned back in
  doesn't work with every newer plugin either (see the React Compiler gotcha above) - Vite
  8/Rolldown support remains a real gap, not just a historical note.

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
  `kernel/kernelSyncServer.ts` mirrors it) - the doorbell handler that calls it has no other
  safety net, so an unhandled throw there would take down the whole Kernel Worker, not just the
  one caller. A quick test with a malformed opcode/body catches this immediately.
- Not every real Node consumer of a Pipe's `onread(arrayBuffer)` treats EOF the same way.
  `internal/stream_base_commons.js`'s generic Readable wrapping keys off
  `streamBaseState[kReadBytesOrError]`'s sign; `setupChannel`'s own bespoke `onread` (fork() IPC)
  instead checks the raw `arrayBuffer` argument's truthiness directly. `Pipe.deliver()` used to
  pass a real (if empty) `ArrayBuffer` for EOF regardless - harmless for the first consumer,
  silently broken for the second (a disconnect never fired). Fixed by passing `undefined` for
  EOF, after confirming the other consumer doesn't care. Lesson: when reusing one internal
  primitive (a Pipe) across multiple real vendored call sites, check EACH site's actual
  contract - "it already works for X" doesn't mean it satisfies Y's slightly different rules.
- A real OS pipe closing its local end signals EOF to the other end automatically - a simulated
  one doesn't, so it must say so explicitly, and every place vendored code can trigger a close
  needs to say so, not just the one you first think of. `shutdown()` already forwarded
  `endStdin`/`endIpc`, but `fork()`'s `child.disconnect()` turned out to call `channel.close()`
  directly (`internal/child_process.js`'s `_disconnect`), a separate code path - the forked
  child's own `process.on('disconnect', ...)` silently never fired until `close()` was also
  taught to notify the kernel. Only the mandatory Chromium e2e caught this; a fake-host Vitest
  test has no real counterpart process to fail to notify, so it can't tell the difference.
- Fixed the nested-interactive-stdin gap noted when the terminal demo was built: an in-process
  program (`cat`, `node`, a nested `sh`) sh's REPL dispatches to shares the exact same
  `IStdinHost` object sh's own `lineReader` is reading from, and `onData` only ever keeps the
  ONE most recently registered handler - so the nested program's registration silently displaced
  the REPL's own. Fix has two parts: `programs/sh/lineReader.ts`'s `ILineReader` gained
  `reattach()` (re-registers its own already-known handler), called by `runReplSh` after every
  line, so the REPL reclaims its slot once whatever it just ran has exited; and
  `workers/process/worker.ts`'s stdin now remembers `stdinEnded` and replays a `null` to any
  handler that registers afterward, in case real EOF arrived while the nested program was still
  the active listener (otherwise a `reattach()` after that would wait forever for input that
  already stopped for good). Verified at the exact bug (a real Chromium session: `node` typed
  at the sh prompt, `.exit`ed, then further sh input still reaches it) - the mechanism itself
  (`reattach()`, the EOF replay) is also unit-tested directly (`lineReader.test.ts`), since
  orchestrating the full nested-REPL timing reliably in Vitest (no real async yields between
  synchronous test writes) is more fragile than testing where the fix actually lives.
- Skipping a piece of real Node bootstrap because part of it doesn't apply here doesn't mean the
  WHOLE thing doesn't apply. `fork()`'s IPC skips vendored `_forkChild` because it opens a real
  fd we don't have - but `_forkChild` ALSO does something unrelated to the fd, right after
  calling `setupChannel`: it wires `process.on('newListener'/'removeListener', (name) => {...
  control.refCounted()/unrefCounted(); })`, which is what makes `channel.ref()`/`.unref()` (and
  therefore a live `'message'` listener keeping the process alive) do anything at all -
  `setupChannel` itself never touches ref-counting. Missing this made a forked child exit
  immediately instead of staying alive, which is fork()'s entire reason to exist. It surfaced as
  two Vitest tests that "sometimes returned empty output" - looked exactly like a timing race
  (and was originally misdiagnosed as one, "fixed" by tuning a `setTimeout` delay that couldn't
  possibly have mattered given the actual call chain is fully synchronous up to the loop's first
  await) - but was actually "whether the reply got processed before the idle process exited" is
  luck when nothing is really keeping it alive. Found for certain by literally counting calls to
  the `ref()` override (zero) and by racing the real behavior against a real timeout in a
  dedicated Vitest test instead of trusting output content. Once fixed, two Chromium e2e test
  scripts that had relied on the SAME missing behavior (a lone `process.on('message', ...)`
  "conveniently" letting the process exit on idle) started hanging until they were taught to
  `process.exit()` explicitly, like a correctly-behaved forked worker should.

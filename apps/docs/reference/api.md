# API

```ts
import { boot, WcvmError } from "wcvm";
```

## boot

`boot(options?)` starts the kernel and returns `{ spawn, fs, preview, diagnostics, ready }` **synchronously**. It throws a `WcvmError` with `type: "ERR_NOT_ISOLATED"` if the page is not cross-origin isolated.

| Option | Default | |
|---|---|---|
| `bootTimeoutMs` | `10000` | `ready` rejects with `ERR_BOOT_TIMEOUT` if the kernel does not answer in time. |
| `persist` | off | `true`, or `{ root?, lazyDepth? }`. Mirrors the filesystem to OPFS; see [Files and persistence](/guide/files#persistence-opfs). Must be decided at boot. |

`ready` is a promise. `spawn` and every `fs` call wait for it, so awaiting it is optional.

## spawn

```ts
const proc = await wc.spawn("node", ["main.js", "--flag"], { cwd: "/app", env: { NODE_ENV: "dev" } });
```

Returns a promise for an `IProcess`:

| Member | |
|---|---|
| `processId` | The PID. |
| `stdout`, `stderr` | `ReadableStream<Uint8Array>`. Buffered until read, closed when the process exits. |
| `stdin` | `WritableStream<Uint8Array>`. Open until you close it or the process exits; writes after exit are dropped. |
| `exit` | `Promise<{ exitCode, signal?, errorMessage? }>`. `exitCode` is 143 or 137 when killed by `SIGTERM` or `SIGKILL`. |
| `kill(signal?)` | `"SIGTERM"` (default) or `"SIGKILL"`. A no-op after exit. Killing a process kills the processes it spawned. |

`options.cwd` defaults to `/`. `options.env` is merged over a small base environment. An unknown command exits with status 127. Built-in commands: `echo cat ls pwd mkdir rm sleep clear true false node sh npm`.

## fs

All methods return promises and reject with a `WcvmError` whose `code` is the errno (`ENOENT`, `EEXIST`, `ENOTDIR`, ...).

| Method | |
|---|---|
| `readFile(path)` | `Promise<Uint8Array>`. |
| `writeFile(path, contents)` | `string` or `Uint8Array`. Does not create parent directories. |
| `exists(path)` | `Promise<boolean>`. |
| `readdir(path)` | `Promise<string[]>` of names. |
| `mkdir(path, { recursive? })` | |
| `stat(path)`, `lstat(path)` | `{ ino, kind: "file" \| "dir" \| "symlink", mode, size, nlink, mtimeMs, ctimeMs }`. `lstat` does not follow symlinks. |
| `rm(path, { recursive? })` | |
| `rename(from, to)` | |
| `cp(from, to)` | Recursive copy of a file, symlink or directory, done inside the filesystem. `to` must not exist. |
| `symlink(target, path)`, `readlink(path)`, `realpath(path)`, `chmod(path, mode)` | |
| `mount(tree, basePath = "/")` | Seeds a whole tree in one call. |
| `fetch(url, path)` | Downloads straight into a file, streamed, up to 10 at a time. Rejects on a non-2xx status. |
| `sync()` | Resolves once every change so far has reached OPFS (immediately if `persist` is off). |
| `reset()` | Deletes everything under `/`, and the persisted copy. |

## preview

| Method | |
|---|---|
| `enable()` | Registers the preview Service Worker and waits until it controls the page. Idempotent. |
| `url(port, path = "/")` | The same-origin URL (`/__wcvm_preview__/<port>/<path>`) that reaches a guest server on a virtual port. |
| `onListen(handler)` | `handler({ port, listening })` whenever a guest server starts or stops listening. Returns an unsubscribe function. Does not need `enable()`. |

See [Preview a dev server](/guide/preview).

## diagnostics

`diagnostics.onEvent(handler)` receives kernel events `{ type, payload?, timestamp }` and replays the last 50, so subscribing late still shows what already happened. It returns an unsubscribe function. Useful when debugging boot problems.

## WcvmError

`error.type` is one of `"ERR_NOT_ISOLATED"`, `"ERR_WORKER"`, `"ERR_NOT_IMPLEMENTED"`, `"ERR_BOOT_TIMEOUT"`, or `"WcvmError"`. `error.code` is the errno for filesystem failures.

## Types

`IWcvm`, `IBootOptions`, `IProcess`, `IProcessExit`, `ISpawnOptions`, `IFs`, `IPreviewApi`, `FileSystemTree`, `IStatResult`.

## Package exports

| Specifier | |
|---|---|
| `wcvm` | The API above. |
| `wcvm/preview-sw` | The preview Service Worker script. `enable()` registers it for you; the export exists so a bundler can emit it. |

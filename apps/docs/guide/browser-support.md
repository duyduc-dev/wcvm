# Browser support

wcvm is built on web platform features, not on a browser extension or a plugin. If a browser has the features below, wcvm can run there. This page lists what is needed, what the project actually tests, and what behaves differently between browsers.

## What was tested

| Browser | Status |
|---|---|
| **Chromium on Linux** (Chrome and Chromium) | Tested in the repository's end-to-end suite on every change. This is the reference. |
| **Chrome on Windows** | Used in practice for [Studio](https://studio.wcvmjs.com). It exposed a `file:` URL parsing difference that wcvm now works around (see below). |
| **Other Chromium-based browsers** (Edge, Brave, Opera) | Expected to work, as they share the engine. Not tested separately. |
| **Firefox** | Not tested by the project. |
| **Safari** | Not tested by the project. |

If you need Firefox or Safari, check each feature below in the browser versions you target, and test your own flow: an end-to-end run of `npm install` and a dev server is the real check.

## What the browser must provide

| Feature | Used for | If it is missing |
|---|---|---|
| **Cross-origin isolation** (`crossOriginIsolated`) | `SharedArrayBuffer` for the synchronous filesystem bridge. | `boot()` throws `ERR_NOT_ISOLATED`. [Configuring headers](/guide/headers). |
| **`Atomics.wait` in a Web Worker** | A process blocks until the filesystem answers. | Nothing runs. |
| **Module workers** (`new Worker(url, { type: "module" })`) | Every process and the kernel. | `ERR_WORKER` at boot. |
| **Blob URLs for workers and `import()`** | Process workers and ES modules are loaded from `blob:` URLs. | Blocked by a CSP that does not allow `blob:`. |
| **Service Workers** | The [preview](/guide/preview) only. | `preview.enable()` fails. Processes still run. |
| **OPFS** (`navigator.storage.getDirectory()`, writable streams) | [Persistence](/guide/files#persistence) only. | Boot continues without persistence and logs a warning. |
| **`CompressionStream` / `DecompressionStream`** | `zlib` (gzip, deflate). | `zlib` fails. |
| **WebAssembly** | Packages shipped as WebAssembly (esbuild-wasm, SWC and others). | Those packages cannot load. |
| **A secure context** (HTTPS, or `localhost`) | Cross-origin isolation and Service Workers. | Both are unavailable. |

You do not need to feature-detect each one: checking `crossOriginIsolated` before calling `boot()` catches the most common failure:

```ts
if (!crossOriginIsolated) {
  showMessage("This page needs cross-origin isolation to run Node.js. See the docs for the headers.");
} else {
  const wc = boot();
}
```

## Differences between browsers

### `file:` URLs

Node code builds `file:` URLs all the time (`import.meta.url`, `pathToFileURL`, `new URL("file:" + __filename)`). Chrome on Windows parses two shapes differently from the URL standard:

| Input | Standard | Chrome on Windows |
|---|---|---|
| `new URL("file:/a/b").href` | `file:///a/b` | `file://a/b` (`a` becomes a host) |
| a `pathname` set on `file://` | `file:///a/b` | `file:////a/b` |

Node's `fileURLToPath` rejects both with `ERR_INVALID_FILE_URL_HOST`, which broke the React Router 7 dev server for users on that platform. wcvm detects the behavior when a process starts and, only then, wraps the global `URL` to normalize both shapes; a browser that parses them correctly keeps its native `URL`. Your own host page is not affected; only code running in the sandbox sees the wrapper.

### Service Worker and iframes

All tabs of one origin share one preview Service Worker. Chromium, Firefox and Safari differ in when a worker takes control of an already-open page and in how a window is chosen to relay a request; wcvm asks an active worker to claim the page when needed. If previews fail in one browser only, start with `navigator.serviceWorker.controller` in the console: [Troubleshooting](/guide/troubleshooting#the-preview-iframe-shows-your-host-app-or-its-not-found).

### Storage

Browsers differ in OPFS quotas and in whether a private window has any. Treat persisted projects as recoverable, not as the only copy.

## Performance and memory

- **Memory.** The whole filesystem, including `node_modules`, lives in the tab's memory, and every process is a worker with its own JavaScript heap. A framework dev server plus its build tools can use several hundred MB. Keep one project per tab and kill processes you no longer need.
- **Startup per process.** Every process loads the runtime bundle, so a trivial command still costs a worker start. Reuse a shell for several commands instead of spawning one process per command.
- **Cold installs.** `npm install` fetches each package through the browser. Persistence plus [excluding `node_modules`](/guide/files#keep-node-modules-out-of-storage) trades install time against storage.
- **Mobile.** Memory limits on phones are tight, and wcvm is designed for desktop browsers.

## Reporting a browser problem

When something works in one browser and not another, these three lines from the sandbox are the most useful to include. Run them in wcvm's `sh` (or paste them into `node -e`):

```
node -p "navigator.userAgent"
node -p "new URL('file:/a/b').href"
node -p "typeof SharedArrayBuffer + ' ' + crossOriginIsolated"
```

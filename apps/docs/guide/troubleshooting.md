# Troubleshooting

Start with the symptom you see. When nothing here matches, the last section lists what to collect for a bug report.

## Boot

### `ERR_NOT_ISOLATED`

The page is not cross-origin isolated. Send `Cross-Origin-Opener-Policy: same-origin` and `Cross-Origin-Embedder-Policy: require-corp` on the **document that calls `boot()`**, then check that `crossOriginIsolated` is `true` in the console. If it is still `false` with the headers set:

- Look at the Network panel: the headers must be on the **HTML document**, not just on scripts.
- A blocked subresource (an image, a script or an iframe from another origin without CORS or `Cross-Origin-Resource-Policy`) is reported in the console. Fix or remove it.
- The page must be HTTPS, or `localhost`.

See [Configuring headers](/guide/headers) for every common host.

### `ERR_BOOT_TIMEOUT` or `ERR_WORKER`

The kernel did not answer within `bootTimeoutMs` (10 seconds by default), or one of its workers failed to start. Check, in this order:

1. The Network panel for the worker scripts (`workers/kernel/worker.js` and the others next to `wcvm`'s `index.js`). They must load, with the isolation headers. A bundler that inlines workers as `data:` URLs breaks them: set `assetsInlineLimit: 0` (Vite).
2. The console for a Content-Security-Policy error. `worker-src` and `script-src` must allow `blob:`.
3. `wc.diagnostics.onEvent(console.log)`: it replays the last events, so it shows what happened before you subscribed.
4. With `persist`, a very large persisted history can make an **eager** restore exceed the timeout. Use `lazyDepth` ([Persistence](/guide/files#options)) or raise `bootTimeoutMs`.

## Preview

### The preview iframe shows your host app, or its "Not Found"

The preview Service Worker is not controlling the page, so the iframe's request fell through to your own dev server (which answers any path with your app's `index.html`). In the console of the host page:

```js
navigator.serviceWorker.controller?.scriptURL     // should be the PreviewServiceWorker URL, not undefined
```

If it is `undefined`:

1. Open DevTools, Application, Service Workers, and untick **Bypass for network**.
2. Reload normally (not a hard reload with Shift: a hard reload makes the page load uncontrolled).
3. Unregister stale workers listed for the origin and reload.

### `SecurityError` from `preview.enable()`

The worker script is served from a nested path and its response lacks `Service-Worker-Allowed: /`. [Configuring headers](/guide/headers#the-preview-service-worker).

### `wcvm preview relay error: ECONNREFUSED`

Nothing is listening on that port **in this tab**. Check that the server printed its ready line and that `onListen` reported the port. With several tabs of the same origin open, another tab may be answering: close the extra ones.

### The preview works, but a client-side route 404s

A client-side router must know the preview prefix (`/__wcvm_preview__/<port>/`). [Preview a dev server](/guide/preview#what-the-preview-needs) and [Frameworks](/guide/frameworks#things-a-framework-needs-from-you).

### The iframe is blank and the console says it was blocked

A page with `require-corp` cannot embed an iframe whose response lacks COEP. Responses served through the preview Service Worker get it automatically; an iframe pointing anywhere else needs the header, or the `credentialless` attribute.

## Installing and running

### `npm install` fails with `Failed to fetch` or `ENETWORK`

A network error reaching the registry. Retry. Behind a proxy or firewall, check that `registry.npmjs.org` is reachable from the browser. A failed install can leave a half-written `node_modules`: remove it (`wc.fs.rm("/app/node_modules", { recursive: true })`) and install again.

### `Cannot find module` after an install that succeeded

- The package needs a `postinstall` step, and wcvm's npm never runs lifecycle scripts. Do what the script would do (Next.js needs a symlink for its WebAssembly SWC: [Frameworks](/guide/frameworks#things-a-framework-needs-from-you)).
- The project has no `node_modules` because you used [`exclude: ["node_modules"]`](/guide/files#keep-node-modules-out-of-storage) and the page was reloaded. Run `npm install` when a project with dependencies has none.
- A package ships only a native binary. Swap it for its WebAssembly build ([Frameworks](/guide/frameworks#pins-that-make-vite-based-projects-run)).

### `command not found`

`sh: <name>: command not found` means it is not a built-in and not on `PATH`. Run it through `npm run`, which adds `node_modules/.bin`, or use its path (`node node_modules/.bin/<name>`). The package may not be installed: check the `npm install` exit code.

### A command hangs forever

A worker pool built on `child_process.fork` never answers in this sandbox. Set `JOBS=1` in the environment (Ember's build is the known case). See [Frameworks](/guide/frameworks#environment-variables).

### `ERR_INVALID_FILE_URL_HOST`

A `file:` URL with a host in it, such as `file://home/user/x` or `file:////home/user/x`. It came from Chrome on Windows parsing `file:` URLs differently from the standard, and affected tools that build a URL from `__filename` (React Router 7's dev server was one). Current versions of wcvm normalize these. If you still see it, update `wcvm`, hard-reload (workers are cached), and see [Browser support](/guide/browser-support#file-urls).

### Ctrl+C does not stop a dev server

There is no `SIGINT`: commands run inside the shell's worker. Kill the shell process and start a new one, which frees its ports.

### The port is still in use after I stopped something

The process is still alive. `kill()` the **shell** that started it (a kill covers its children), then start again.

## Files and storage

### My files are gone after a reload

Persistence is off unless you passed `persist` to `boot()`. With it on, a reload straight after a large write can lose the last files because mirroring is write-behind: `await wc.fs.sync()` first. Files under an [excluded name](/guide/files#keep-node-modules-out-of-storage) are never kept.

### `NoModificationAllowedError` from OPFS in the console

A writer still holds a file: often two tabs on one origin, or a log file rewritten while its folder is removed. wcvm retries a refused delete briefly. Keep one tab per project.

### `EEXIST`, `ENOENT`, `ENOTDIR` from `wc.fs`

These are the errno codes Node uses. `writeFile` does not create parent folders (`mkdir` with `recursive: true`, or use `mount`); `cp` needs a destination that does not exist; `rm` on a folder needs `recursive: true`.

## Editors and terminals you build

### Pasting into an xterm terminal does nothing

xterm turns Ctrl+V into a control character and cancels the key event, so the browser never fires `paste`. [Connecting a terminal](/guide/processes#connecting-a-terminal) shows the one-line fix.

### `Cannot find module './+types/root'` in an editor

React Router generates those types into `.react-router/types`, mapped with `rootDirs` in `tsconfig.json`. If you build your own editor on wcvm, honor the project's `rootDirs`, and run `react-router typegen` (or `npm run dev` once) so the files exist.

### `Cannot find name 'LayoutProps'` in a Next.js editor

`LayoutProps`, `PageProps` and `RouteContext` are types Next.js generates into `.next/types` (by `next typegen` or `next dev`), and the project's `tsconfig.json` includes that folder. An editor that skips `.next` does not see them: include `.next/types` and `.next/dev/types`.

### `Unable to resolve signature of method decorator` (NestJS and similar)

Your editor's TypeScript is checking decorators as standard ones. Copy `experimentalDecorators` and `emitDecoratorMetadata` from the project's `tsconfig.json` into the editor's compiler options.

### Imports show as unresolved right after an install

The editor's language service still has the old typings. Reload the dependency typings and re-validate open files once the install has finished.

## Harmless messages

- **A hydration warning about an unknown `data-*` attribute.** A browser extension is rewriting the page before React loads (style mergers, dictionary extensions). Try a clean profile.
- **A CORS error for `registry.npmjs.org/-/package/next/dist-tags`.** Next's dev overlay checks for a newer version from the page. It does not matter.
- **Future-flag warnings from React Router.** They are the framework telling you about v8; the dev server is running.

## Collecting what a bug report needs

Run these in a wcvm shell, and include the output and the console errors:

```
node -p "navigator.userAgent"
node -p "crossOriginIsolated"
node -p "process.version"
npm --version
```

And, from the host page's console: `await navigator.serviceWorker.getRegistrations()` and the output of `wc.diagnostics.onEvent(console.log)`. Open an issue at [github.com/duyduc-dev/wcvm](https://github.com/duyduc-dev/wcvm/issues).

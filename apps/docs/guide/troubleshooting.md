# Troubleshooting

## `ERR_NOT_ISOLATED`

The page is not cross-origin isolated. Send `Cross-Origin-Opener-Policy: same-origin` and `Cross-Origin-Embedder-Policy: require-corp` on the document that calls `boot()`, then check `crossOriginIsolated` is `true` in the console. See [Getting started](/guide/getting-started#_1-serve-a-page-that-can-boot).

## The preview iframe shows your host app, or its "Not Found"

The preview Service Worker is not controlling the page, so the iframe's request fell through to your own dev server (which answers any path with your app's `index.html`). Check, in the console of the host page:

```js
navigator.serviceWorker.controller?.scriptURL     // should be the PreviewServiceWorker URL, not undefined
```

If it is `undefined`:

1. Open DevTools, Application, Service Workers, and untick **Bypass for network**.
2. Reload normally (not a hard reload with Shift).
3. Unregister stale workers listed for the origin and reload.

## `wcvm preview relay error: ECONNREFUSED`

Nothing is listening on that port **in this tab**. Check that the server printed its ready line. With several tabs of the same origin open, another tab may be answering: close the extra ones.

## `npm install` fails with `Failed to fetch`

A network error reaching the registry. Retry. Behind a proxy or firewall, check that `registry.npmjs.org` is reachable from the browser.

## `NoModificationAllowedError` from OPFS in the console

A writer still holds a file: often two tabs on one origin, or a log file rewritten while its folder is removed. wcvm retries a refused delete briefly. Keep one tab per project.

## A command hangs forever

A worker pool built on `child_process.fork` never answers in this sandbox. Set `JOBS=1` in the environment (Ember's build is the known case). See [Frameworks](/guide/frameworks#environment-variables).

## `Cannot find module './+types/root'` in an editor

React Router generates those types into `.react-router/types`, mapped with `rootDirs` in `tsconfig.json`. If you build your own editor on wcvm, honor the project's `rootDirs`. Run `react-router typegen` (or `npm run dev` once) so the files exist.

## A hydration warning about an unknown `data-*` attribute

A browser extension is rewriting the page before React loads (for example style mergers or dictionary extensions). Try a clean profile or disable extensions.

## A CORS error for `registry.npmjs.org/-/package/next/dist-tags`

Next's dev overlay checks for a newer version from the page. It is harmless.

## Ctrl+C does not stop a dev server

There is no `SIGINT`: commands run inside the shell's worker. Kill the shell process and start a new one, which frees its ports.

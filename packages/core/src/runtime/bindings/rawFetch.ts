// Wraps the real, native `fetch` global so a guest script's own `fetch(new URL("./x.wasm",
// import.meta.url))` - a common pattern for loading a co-located binary asset (a WASM module, in
// particular a native N-API binding's own wasm fallback - see rawWorker.ts, found the same way,
// scoping Vite 8/Rolldown support: `@napi-rs/wasm-runtime`'s real browser build fetches its own
// `.wasm` file exactly this way) - can actually load bytes from the VFS.
//
// `import.meta.url` is deliberately rewritten to a synthetic `file:` URL (esm/loader.ts's own doc
// comment) so a module's own path logic (fileURLToPath, createRequire, `new URL("./x", ...)`)
// resolves against the VFS like a real filesystem - but a real, native `fetch()` can never fetch a
// `file:` URL at all. Confirmed directly, not assumed: `fetch("file:///a/b.wasm")` rejects
// SYNCHRONOUSLY-ISH (a rejected promise, no Response, no status to branch on) in real Chromium
// with a bare `TypeError: Failed to fetch` - unlike a real HTTP 404, there is nothing here for
// calling code to distinguish "wrong URL" from "no network" from "not supported at all". Rewriting
// `fetch(file:...)` to read the VFS and hand back a real `Response` lets code written for a real
// browser (which never sees `file:` URLs at all) work unmodified against wcvm's own scheme.
// Anything else (`http(s):`, `blob:`, `data:`, a `Request` whose own `.url` isn't `file:`) passes
// straight through to the real `fetch` unchanged - there's nothing to fix for those, and in
// particular this never touches `programs/builtins.ts`'s own `nativeFetch`, captured at MODULE
// LOAD time (before any Process Worker/runtime exists) for the npm installer's real registry
// access - this wrapper only ever replaces a later process's own global, never that earlier
// capture.
//
// A missing VFS file resolves to a 404 `Response` (not a rejection): the closest real-fetch
// analogue is a real HTTP server 404ing a bad path, which calling code already has to handle via
// `response.ok` - not a network failure, which has no real analogue for a local VFS read at all.

export interface IRawFetchContext {
  /** Real Node's own vendored `url.fileURLToPath` (via `requireBuiltin("url")`) - `undefined` for
   *  anything that isn't a `file:` URL this sandbox's own scheme could have produced. */
  fileURLToPath(url: string): string | undefined;
  /** The sync fs client's own `readFile` - throws if the path doesn't exist or isn't a file. */
  readFile(path: string): Uint8Array;
  /** The real worker's own global object (`self` in a real Worker) - where the real, native
   *  `fetch` is captured from and where the wrapped one replaces it. */
  globalObject: Record<string, unknown>;
}

const requestUrl = (input: unknown): string | undefined => {
  if (typeof input === "string") return input;
  if (input instanceof URL) return input.href;
  if (input instanceof Request) return input.url;
  return undefined;
};

/** A no-op if there's no real native `fetch` at all in this realm (Vitest under plain Node with no
 *  global fetch, or any future host without one). */
export const installRawFetch = (ctx: IRawFetchContext): void => {
  const nativeFetch = ctx.globalObject.fetch as typeof fetch | undefined;
  if (typeof nativeFetch !== "function") return;

  const wrapped = ((input: RequestInfo | URL, init?: RequestInit) => {
    const url = requestUrl(input);
    const path = url?.startsWith("file:") ? ctx.fileURLToPath(url) : undefined;
    if (path === undefined) return nativeFetch(input as RequestInfo, init);
    try {
      const bytes = ctx.readFile(path);
      // A real `Uint8Array`'s generic type param defaults to `ArrayBufferLike` (which includes
      // `SharedArrayBuffer`), which real DOM `BodyInit`/`ArrayBufferView` types don't structurally
      // accept - the same generic-TypedArray friction `opfsPersistence.ts`'s own boundary hits.
      return Promise.resolve(new Response(bytes as BodyInit, { status: 200, headers: { "content-type": "application/octet-stream" } }));
    } catch {
      return Promise.resolve(new Response(null, { status: 404, statusText: "Not Found" }));
    }
  }) as typeof fetch;

  ctx.globalObject.fetch = wrapped;
};

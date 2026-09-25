// Wraps the real, native `Worker` global so a guest script's own `new Worker(new URL("./x.mjs",
// import.meta.url))` - the browser-native worker API, not Node's own `worker_threads` (see
// bindings/worker.ts for that) - can actually load a script from the VFS. Real Node has no global
// `Worker` at all; this exists for code written to run in EITHER Node or a real browser (found
// scoping Vite 8/Rolldown support - see PLAN.md's "Scoped further" note: `@napi-rs/wasm-runtime`'s
// own real browser build, used by Rolldown's real Wasm binary, spawns a pool of these directly).
//
// FIRST PLATFORM GAP: `import.meta.url` is deliberately rewritten to this module's real `file:`
// URL (esm/loader.ts's own doc comment), so a script's own path logic (fileURLToPath,
// createRequire(import.meta.url), ...) resolves against the VFS the way it would against a real
// filesystem - but that URL is a wcvm-only fiction: the module was ACTUALLY loaded through a real
// Blob URL (real ESM, real live bindings - see esm/loader.ts), and a real native Worker can never
// load a `file:` one. Confirmed directly, not assumed: `new Worker("file:///a/b.mjs")` throws
// synchronously in real Chromium - `Failed to construct 'Worker': Script at 'file:///a/b.mjs'
// cannot be accessed from origin '...'` - not a hang, not an async error event. A `file:` URL
// that resolves to a real VFS path gets its own fresh Blob URL instead - esm/loader.ts's
// `blobUrlForFile`, reusing the exact machinery already used for every ordinary import, parsing
// and rewriting a module's own static import graph too, not just blobbing raw bytes - before this
// existed, a real Rolldown Wasm build's own attempt to build one this way hung indefinitely
// instead (its own error handling never saw the native exception - see PLAN.md). Anything else
// (http(s):, blob:, data:, an already-real Worker's own Blob URL) passes straight through to the
// real constructor unchanged - there's nothing to fix for those.
//
// SECOND PLATFORM GAP, found right after fixing the first (same class of bug as net.ts's own
// TCP.connect() one - see CLAUDE.md's "Hard-won gotchas"): a real native Worker has NO
// wcvm-specific ref-counting of its own at all, so a script doing nothing but `new Worker(...)`
// and awaiting its first message saw an idle event loop and exited before that message could ever
// arrive - confirmed directly (a real Chromium run received nothing until the loop was ref'd).
// Fixed by ref'ing for as long as a WcvmWorker instance exists, released on `.terminate()` - a
// real native Worker has no "I stopped myself" signal exposed to its own creator at all (no
// close/exit event on Worker, unlike a MessagePort's own - see messaging.ts), so a worker that
// ends itself with no explicit `.terminate()` call from this side keeps its creator alive
// regardless; not a concern for a persistent pool like emnapi's own (which is the whole point of
// a *reusable* pool - nothing here calls terminate() on a worker mid-use anyway), but a
// documented simplification for any other use.

export interface IRawWorkerContext {
  /** Real Node's own vendored `url.fileURLToPath` (via `requireBuiltin("url")`) - `undefined` for
   *  anything that isn't a `file:` URL this sandbox's own scheme could have produced. */
  fileURLToPath(url: string): string | undefined;
  /** esm/loader.ts's own `blobUrlForFile` - built lazily (most scripts never call `new Worker`
   *  with a `file:` URL at all, so there's no reason to force the ESM loader - and the acorn
   *  parser it needs - to exist before one actually does). */
  getBlobUrlForFile(): (path: string, module: boolean) => string;
  /** The real worker's own global object (`self` in a real Worker) - where the real, native
   *  `Worker` constructor is captured from and where the wrapped one replaces it. */
  globalObject: Record<string, unknown>;
  /** `EventLoop.ref()`'s own shape: keeps the loop alive until the returned function is called. */
  ref(): () => void;
}

/** A no-op if there's no real native `Worker` at all in this realm (Vitest under plain Node, or
 *  any future host without one) - nothing to wrap, and nothing any vendored code needs from it
 *  either, unlike an internalBinding a script might `require()` unconditionally. */
export const installRawWorker = (ctx: IRawWorkerContext): void => {
  const NativeWorker = ctx.globalObject.Worker as (new (scriptURL: string | URL, options?: WorkerOptions) => Worker) | undefined;
  if (typeof NativeWorker !== "function") return;

  class WcvmWorker extends NativeWorker {
    #release: (() => void) | undefined;

    constructor(scriptURL: string | URL, options?: WorkerOptions) {
      const href = scriptURL instanceof URL ? scriptURL.href : String(scriptURL);
      const path = href.startsWith("file:") ? ctx.fileURLToPath(href) : undefined;
      if (path === undefined) super(scriptURL, options);
      else super(ctx.getBlobUrlForFile()(path, options?.type === "module"), options);
      this.#release = ctx.ref();
    }

    terminate(): void {
      this.#release?.();
      this.#release = undefined;
      super.terminate();
    }
  }

  ctx.globalObject.Worker = WcvmWorker;
};

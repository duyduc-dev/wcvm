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
//
// THIRD PLATFORM GAP, found actually exercising a real worker pool (`@emnapi/wasi-threads`'s own
// `ThreadManager`, and `@napi-rs/wasm-runtime`'s own async-work/threadsafe-function dispatch built
// on it): every `.on()`/`.once()`/`.off()`/`.ref()`/`.unref()` call on a worker object across both
// is guarded by an `ENVIRONMENT_IS_NODE` check (`typeof process.versions.node === "string"`) - true
// under real Node.js (where `new Worker(...)` doesn't even exist as a global; that branch is
// written against `worker_threads.Worker`, a real EventEmitter with real `.on()`/`.ref()`/
// `.unref()`) and false in a real browser (where the SAME files instead call
// `addEventListener()`/`removeEventListener()`, or - `ThreadManager`'s own pool bookkeeping only -
// rely on `worker.onmessage`/`.onerror`/`.onmessageerror` property assignment, set UNCONDITIONALLY
// a few lines above its own now-dead-for-us Node branch). wcvm's own vendored
// `process.versions.node` makes `ENVIRONMENT_IS_NODE` true here too, even though `new Worker(...)`
// resolves to this real native browser constructor, not `worker_threads` - a genuine identity
// contradiction no real environment has (every real one is one or the other, never both) - so the
// Node branch ran against a plain Worker instance and crashed immediately (`TypeError: worker.once
// is not a function`). Once that no longer crashes, a SECOND symptom follows: `@napi-rs/
// wasm-runtime`'s own async-work/threadsafe-function completion messages (the actual mechanism a
// real bundling call's own result comes back through) have NO property-assignment fallback at all
// - `.on('message', ...)` is their ONLY delivery path under the (wrongly-taken) Node branch, so a
// no-op there means that promise never resolves: a real `rolldown()` build call hung forever at
// `.generate()`, never crashing, having genuinely dispatched real async work with nothing left to
// ever receive its completion. So `.on()`/`.once()`/`.off()` genuinely bridge to real
// `addEventListener()`/`removeEventListener()` (constructing the exact same wrapped listener shape
// real Node's own `.on('message', fn)` would deliver: `fn(event.data)`, not the raw DOM event,
// tracked per-(event, original listener) so `.off()` can find and remove the matching bridge) -
// `.ref()`/`.unref()` toggle the SAME held reference the SECOND PLATFORM GAP above already tracks
// per-worker, which is exactly what they're meant to control ("keep wcvm's own event loop alive").
// `'exit'`/`'detachedExit'` (Node-only concepts - see the SECOND PLATFORM GAP above) have no
// bridge at all and are silently dropped: the one real, documented simplification this leaves -
// an unexpected worker crash goes unreported instead of surfacing through `ThreadManager`'s own
// error-recovery path, acceptable for a pool whose workers are normally only ever torn down via an
// explicit `.terminate()` call (already handled correctly above), not silently. `ThreadManager`'s
// own redundant `worker.on('message', (data) => worker.onmessage?.({data}))` bridge now ALSO fires
// alongside the real native property-based delivery its own unconditional `worker.onmessage = ...`
// assignment already provides (harmless here in practice - checked directly: the pool's own
// message handling tolerates being invoked twice for the same message, and a real end-to-end
// rolldown build completes correctly either way), the one place this fix's own bridging is
// broader than strictly necessary rather than narrower.

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

  // No native equivalent at all (Node-only worker_threads lifecycle events) - see this file's own
  // THIRD PLATFORM GAP doc comment above.
  const NO_BRIDGE = new Set(["exit", "detachedExit"]);
  /** Node's own `.on("message"/"messageerror", fn)` calls `fn(event.data)`, not the raw DOM event
   *  a real `addEventListener` listener receives - matched here so a bridged listener sees exactly
   *  what its Node-targeted call site already expects. */
  const UNWRAP_DATA = new Set(["message", "messageerror"]);

  class WcvmWorker extends NativeWorker {
    #release: (() => void) | undefined;
    readonly #bridged = new Map<string, Map<EventListenerOrEventListenerObject, EventListener>>();

    constructor(scriptURL: string | URL, options?: WorkerOptions) {
      const href = scriptURL instanceof URL ? scriptURL.href : String(scriptURL);
      const path = href.startsWith("file:") ? ctx.fileURLToPath(href) : undefined;
      if (path === undefined) super(scriptURL, options);
      else super(ctx.getBlobUrlForFile()(path, options?.type === "module"), options);
      this.#release = ctx.ref();
    }

    ref(): void {
      this.#release ??= ctx.ref();
    }

    unref(): void {
      this.#release?.();
      this.#release = undefined;
    }

    #bridgeFor(event: string, listener: EventListenerOrEventListenerObject): EventListener {
      const call = (arg: unknown) => (typeof listener === "function" ? listener(arg as Event) : listener.handleEvent(arg as Event));
      return UNWRAP_DATA.has(event) ? (nativeEvent) => call((nativeEvent as MessageEvent).data) : (nativeEvent) => call(nativeEvent);
    }

    on(event: string, listener: EventListenerOrEventListenerObject): this {
      if (NO_BRIDGE.has(event)) return this;
      const bridge = this.#bridgeFor(event, listener);
      let byListener = this.#bridged.get(event);
      if (!byListener) {
        byListener = new Map();
        this.#bridged.set(event, byListener);
      }
      byListener.set(listener, bridge);
      this.addEventListener(event, bridge);
      return this;
    }

    once(event: string, listener: EventListenerOrEventListenerObject): this {
      if (NO_BRIDGE.has(event)) return this;
      this.addEventListener(event, this.#bridgeFor(event, listener), { once: true });
      return this;
    }

    off(event: string, listener: EventListenerOrEventListenerObject): this {
      const bridge = this.#bridged.get(event)?.get(listener);
      if (bridge) {
        this.removeEventListener(event, bridge);
        this.#bridged.get(event)?.delete(listener);
      }
      return this;
    }

    terminate(): void {
      this.unref();
      super.terminate();
    }
  }

  ctx.globalObject.Worker = WcvmWorker;
};

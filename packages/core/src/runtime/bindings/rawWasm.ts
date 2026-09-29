// Refs the event loop around the real, native `WebAssembly.compile`/`instantiate`/
// `instantiateStreaming`/`compileStreaming` - all four return a Promise wcvm's own event loop
// (eventLoop.ts) knows nothing about, since `WebAssembly` reaches guest code completely unmodified
// via `globalObject: self` (it's a standard Worker global, never routed through any wcvm binding).
// `EventLoop.alive()` only ever considers a ref'd timer, a ref'd immediate, or an explicit
// `ref()` - a script whose only remaining "work" is an in-flight WebAssembly compile has none of
// those, so the loop calls itself idle and the whole process exits (its underlying Worker gets
// torn down) before the compile's own promise - a REAL, independent Chromium-internal async
// operation that keeps running regardless of whether this loop thinks anything is "pending" - ever
// gets a live Worker realm left to deliver its `.then()` callback into. The result: the callback
// (and everything after it) silently never runs, with no error and no crash anywhere to point at
// the cause.
//
// Found via a real, minimal repro (not the whole failing package): a script that does nothing but
// `fs.readFile()` a real 3 MiB `.wasm` file (confirmed correct, unmodified bytes - fs's own async
// chunking, already proven for both sync and non-sync reads, isn't the issue) and then
// `WebAssembly.compile(buf)` prints "compiling..." and then NOTHING - not "done", not an error -
// for as long as the test waits. This is exactly how `@builder.io/qwik`'s own optimizer
// (dist/optimizer.mjs's `loadPlatformBinding()`, called from `createOptimizer()`) loads its wasm
// fallback once its (expected, harmless) native-binding attempt fails: `fs.readFile` the `.wasm`
// file, `WebAssembly.compile` it, `mod.default(compiledModule)` (a wasm-bindgen glue module's own
// `__wbg_init`, itself calling `WebAssembly.instantiate(module, imports)` - a SECOND unref'd native
// Promise in the same chain).
//
// Same fix shape as `rawFetch.ts`'s wrapped `fetch` and `zlib.ts`'s `ctx.loop.ref()` around
// `runZlibOnce` (the real, native `CompressionStream`/`DecompressionStream`): ref the loop before
// calling the real native function, release once its promise settles either way. Unlike
// `rawFetch.ts`, this never needs to change WHAT the call does (no `file:` URL interception) -
// only to hold the loop open across it, so nothing else needs to be captured (no fs client, no
// `fileURLToPath`) besides the loop's own `ref()`.

export interface IRawWasmContext {
  /** `EventLoop.ref()`'s own shape: keeps the loop alive until the returned function is called. */
  ref(): () => void;
  /** The real worker's own global object (`self` in a real Worker) - where the real, native
   *  `WebAssembly` is captured from and where the wrapped one replaces it. */
  globalObject: Record<string, unknown>;
}

type AsyncWasmFn = (...args: never[]) => Promise<unknown>;

const refCounted = (ctx: IRawWasmContext, fn: AsyncWasmFn): AsyncWasmFn =>
  (...args) => {
    const release = ctx.ref();
    return fn(...args).finally(release);
  };

/** A no-op if there's no real native `WebAssembly` at all in this realm (Vitest under plain Node
 *  has one too, but nothing there exercises the idle-exit path this guards against). */
export const installRawWasm = (ctx: IRawWasmContext): void => {
  const original = ctx.globalObject.WebAssembly as typeof WebAssembly | undefined;
  if (!original || typeof original.compile !== "function") return;

  // Delegates every OTHER member (Module, Instance, Memory, Table, validate, the error classes, ...)
  // to the real namespace object via the prototype chain - only the four async entry points below
  // are actually overridden as OWN properties, shadowing the originals.
  const wrapped = Object.create(original) as typeof WebAssembly;
  wrapped.compile = refCounted(ctx, original.compile.bind(original)) as typeof WebAssembly.compile;
  wrapped.instantiate = refCounted(ctx, original.instantiate.bind(original)) as typeof WebAssembly.instantiate;
  if (typeof original.instantiateStreaming === "function") {
    wrapped.instantiateStreaming = refCounted(ctx, original.instantiateStreaming.bind(original)) as typeof WebAssembly.instantiateStreaming;
  }
  if (typeof original.compileStreaming === "function") {
    wrapped.compileStreaming = refCounted(ctx, original.compileStreaming.bind(original)) as typeof WebAssembly.compileStreaming;
  }

  ctx.globalObject.WebAssembly = wrapped;
};

import type { BuiltinFactory } from "./node/types";

// `AsyncLocalStorage` without V8.
//
// Node's own implementations rest on something a browser Worker doesn't have: V8 PromiseHooks
// (`async_hooks`' `executionAsyncResource()` chain) or the continuation-preserved embedder data of
// `AsyncContextFrame`. With neither, `new AsyncLocalStorage()` died in `internal/promise_hooks` -
// which `@nestjs/cli` (via @inquirer/core), SvelteKit's dev server, Next.js, React Router and Nuxt all
// construct at startup. This replaces `internal/async_local_storage/async_hooks` (the vendored copy
// stays in the tree, unused) with the best a plain-JS runtime can do:
//
//  1. `run(store, cb)` keeps `store` active for the WHOLE call - the synchronous body and, if `cb`
//     returns a thenable, until that settles (and, for the outermost run, beyond: see `#scoped`). That is what makes a raw `await` inside `cb` see the
//     store: a native `await` resumes through an internal reaction nothing in JS can observe, so the
//     store has to still be there when it does.
//  2. Work scheduled from inside a run (`Promise#then`, `queueMicrotask`, `process.nextTick`,
//     timers, `setImmediate`) captures every live store at scheduling time and restores it while
//     that callback runs, so a detached continuation keeps its context too.
//
// The limit is real and deliberate: there is ONE current value per instance, not one per async
// chain. Two overlapping `run()`s on the same instance can see each other's store. For a dev server
// handling a request at a time that is invisible; it is not a general-purpose replacement.

type Slot = { has: boolean; value: unknown };

// Captured at module load, before anything below patches them.
const nativeThen = Promise.prototype.then;

class AsyncLocalStorageShim {
  /** Every instance with a store, so scheduling can capture/restore all of them at once. */
  static live = new Set<AsyncLocalStorageShim>();

  enabled = false;
  slot: Slot = { has: false, value: undefined };
  /** run() calls in flight (not yet returned, or returned a promise that has not settled): what
   *  distinguishes a NESTED scope from a new outermost one - a left-behind store does not. */
  #active = 0;
  #defaultValue: unknown;
  #name: string | undefined;

  constructor(options: { defaultValue?: unknown; name?: unknown } = {}) {
    if (options === null || typeof options !== "object") {
      throw Object.assign(new TypeError('The "options" argument must be of type object.'), {
        code: "ERR_INVALID_ARG_TYPE",
      });
    }
    this.#defaultValue = options.defaultValue;
    if (options.name !== undefined) this.#name = `${options.name}`;
    this._enable();
  }

  get name(): string {
    return this.#name || "";
  }

  static bind<F extends (...args: any[]) => any>(fn: F): F {
    return wrapWithContext(fn);
  }

  static snapshot(): (cb: (...args: any[]) => any, ...args: any[]) => any {
    const run = wrapWithContext((cb: (...args: any[]) => any, ...args: any[]) => cb(...args));
    return run;
  }

  _enable(): void {
    if (this.enabled) return;
    this.enabled = true;
    AsyncLocalStorageShim.live.add(this);
    installPropagation();
  }

  disable(): void {
    if (!this.enabled) return;
    this.enabled = false;
    this.slot = { has: false, value: undefined };
    AsyncLocalStorageShim.live.delete(this);
  }

  getStore(): unknown {
    return this.enabled && this.slot.has ? this.slot.value : this.#defaultValue;
  }

  enterWith(store: unknown): void {
    this._enable();
    this.slot = { has: true, value: store };
  }

  run(store: unknown, callback: (...args: any[]) => any, ...args: any[]): any {
    this._enable();
    return this.#scoped({ has: true, value: store }, callback, args);
  }

  exit(callback: (...args: any[]) => any, ...args: any[]): any {
    if (!this.enabled) return Reflect.apply(callback, null, args);
    // Escaping a scope is explicit, so unlike run() it always puts the previous value back.
    const prior = this.slot;
    this.slot = { has: false, value: undefined };
    const restore = (): void => {
      this.slot = prior;
    };
    let result: any;
    try {
      result = Reflect.apply(callback, null, args);
    } catch (error) {
      restore();
      throw error;
    }
    if (result !== null && (typeof result === "object" || typeof result === "function") && typeof result.then === "function") {
      nativeThen.call(Promise.resolve(result), restore, restore);
    } else {
      restore();
    }
    return result;
  }

  /** Runs `callback` with `next` as this instance's value (rules 1 and 3 above).
   *
   * What happens when it finishes depends on whether this scope is NESTED in another one. A nested
   * scope puts its parent's value back (once a returned thenable settles). The OUTERMOST scope does
   * not: it leaves its value in place for the next run() to replace. That is a deliberate departure
   * from Node, found the hard way: a streaming server render (React's
   * Flight/Fizz, so Next.js's app router) returns from `run()` - promise and all - as soon as the
   * stream EXISTS, then goes on rendering components detached, across native `await`s nothing here can
   * observe. Restoring "no store" at that boundary zeroes the context mid-render and Next throws
   * "Invariant: Expected workUnitAsyncStorage to have a store". The cost is that `getStore()` outside
   * any run() answers with the most recent request's store instead of `undefined`; `disable()` clears it. */
  #scoped(next: Slot, callback: (...args: any[]) => any, args: any[]): any {
    const prior = this.slot;
    const nested = this.#active > 0;
    this.slot = next;
    this.#active++;
    let done = false;
    const finish = (): void => {
      if (done) return;
      done = true;
      this.#active--;
      // Only undo our own change, and only back into a live parent scope (see above).
      if (nested && this.slot === next) this.slot = prior;
    };
    let result: any;
    try {
      result = Reflect.apply(callback, null, args);
    } catch (error) {
      // A synchronous throw means the scope really is over, whatever it was nested in.
      done = true;
      this.#active--;
      if (this.slot === next) this.slot = prior;
      throw error;
    }
    if (result !== null && (typeof result === "object" || typeof result === "function") && typeof result.then === "function") {
      try {
        // The ORIGINAL `then`: a patched one would wrap `finish` in a snapshot of this very run.
        nativeThen.call(Promise.resolve(result), finish, finish);
      } catch {
        finish();
      }
    } else {
      finish();
    }
    return result;
  }
}

/** A function that runs `fn` with every live store set to what it was when this was called. */
function wrapWithContext<F extends (...args: any[]) => any>(fn: F): F {
  if (typeof fn !== "function" || AsyncLocalStorageShim.live.size === 0) return fn;
  const snapshot = [...AsyncLocalStorageShim.live].map((inst) => [inst, inst.slot] as const);
  const wrapped = function (this: unknown, ...args: any[]) {
    const saved = snapshot.map(([inst]) => [inst, inst.slot] as const);
    for (const [inst, slot] of snapshot) inst.slot = slot;
    try {
      return Reflect.apply(fn, this, args);
    } finally {
      for (const [inst, slot] of saved) inst.slot = slot;
    }
  };
  return wrapped as unknown as F;
}

/** Wraps the callback (first argument) of `target[name]` so it runs with the scheduler's context. */
function wrapFirstArg(target: any, name: string): void {
    const original = target?.[name];
    if (typeof original !== "function" || original.__wcvmContext) return;
    const patched = function (this: unknown, callback: unknown, ...rest: unknown[]) {
      return Reflect.apply(original, this, [wrapWithContext(callback as any), ...rest]);
    };
    // Keep what callers read off the original (util.promisify.custom on setTimeout/setImmediate).
    for (const key of Reflect.ownKeys(original)) {
      if (key !== "length" && key !== "name" && key !== "prototype") {
        Object.defineProperty(patched, key, Object.getOwnPropertyDescriptor(original, key)!);
      }
    }
    Object.defineProperty(patched, "__wcvmContext", { value: true });
    try {
      target[name] = patched;
    } catch {
      Object.defineProperty(target, name, { value: patched, configurable: true, writable: true });
    }
  }

let propagationInstalled = false;
/** Every runtime `process` object (the one the loader hands a module, not necessarily `globalThis.process`). */
const processes = new Set<any>();

/** Patches the scheduling primitives once, on the first store: each wraps its callback so it runs
 * with the context that was active when it was scheduled. */
function installPropagation(): void {
  if (propagationInstalled) return;
  propagationInstalled = true;
  const g = globalThis as any;

  if (Promise.prototype.then === nativeThen) {
    Promise.prototype.then = function (this: Promise<unknown>, onFulfilled?: any, onRejected?: any) {
      return nativeThen.call(this, wrapWithContext(onFulfilled), wrapWithContext(onRejected));
    } as typeof Promise.prototype.then;
  }

  for (const name of ["queueMicrotask", "setTimeout", "setInterval", "setImmediate"]) wrapFirstArg(g, name);
  if (g.process) processes.add(g.process);
  for (const process of processes) wrapFirstArg(process, "nextTick");
}

/** Node's `internal/promise_hooks` drives V8's PromiseHook. Without it `async_hooks.createHook()`
 * must still be enableable (AsyncLocalStorage, `AsyncHook#enable`), so it exists and never fires. */
const promiseHooksShim: BuiltinFactory = (_exports, _require, module) => {
  const noop = (): void => {};
  module.exports = {
    createHook: () => noop,
    onInit: () => noop,
    onBefore: () => noop,
    onAfter: () => noop,
    onSettled: () => noop,
    stopAll: noop,
  };
};

const asyncLocalStorageShim: BuiltinFactory = (_exports, _require, module, process) => {
  processes.add(process);
  // If propagation was already installed for another process in this realm, cover this one too.
  if (propagationInstalled) wrapFirstArg(process, "nextTick");
  module.exports = AsyncLocalStorageShim;
};

export { asyncLocalStorageShim, promiseHooksShim, AsyncLocalStorageShim };

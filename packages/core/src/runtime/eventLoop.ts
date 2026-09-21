// A libuv-shaped event loop over the host's own (browser worker) scheduler.
//
// Node's vendored lib/timers.js decides WHAT runs and in which order; it only
// needs the native side to (a) fire one timer handle when told, (b) run the
// "check" phase for immediates, and (c) keep the process alive while anything
// ref'd is pending. This class is that native side.
//
// Each turn is one macrotask, in libuv's phase order:
//   timers (if due) -> check/immediates -> next-tick + microtask drain
// and the process-level tick callback runs after every JS callback, exactly
// where Node's InternalCallbackScope would run it.

export interface IEventLoopHost {
  /** Monotonic milliseconds. */
  now(): number;
  /** Runs `fn` after roughly `ms`; returns a cancel function. */
  setTimeout(fn: () => void, ms: number): () => void;
  /** Runs `fn` on the next macrotask (no clamping). */
  setImmediate(fn: () => void): void;
}

// immediateInfo layout, shared with lib/internal/timers.js
const K_COUNT = 0;
const K_REF_COUNT = 1;
// tickInfo layout, shared with lib/internal/process/task_queues.js
const K_HAS_TICK_SCHEDULED = 0;
const K_HAS_REJECTION_TO_WARN = 1;

// Captured at import time, before a runtime installs Node's own setTimeout & co
// over the worker's globals: the loop must keep using the platform's.
const nativeSetTimeout = globalThis.setTimeout.bind(globalThis);
const nativeClearTimeout = globalThis.clearTimeout.bind(globalThis);

const defaultHost = (): IEventLoopHost => {
  const channel = typeof MessageChannel === "function" ? new MessageChannel() : null;
  const queue: Array<() => void> = [];
  if (channel) {
    channel.port1.onmessage = () => queue.shift()?.();
    // A port with a handler keeps Node's own loop alive; workers don't care,
    // and tests unref it so vitest can exit.
    (channel.port1 as unknown as { unref?: () => void }).unref?.();
  }
  return {
    now: () => performance.now(),
    setTimeout: (fn, ms) => {
      const id = nativeSetTimeout(fn, ms);
      return () => nativeClearTimeout(id);
    },
    setImmediate: (fn) => {
      if (channel) {
        queue.push(fn);
        channel.port2.postMessage(null);
      } else {
        nativeSetTimeout(fn, 0);
      }
    },
  };
};

class EventLoop {
  readonly immediateInfo = new Uint32Array(3);
  readonly timeoutInfo = new Int32Array(1);
  readonly tickInfo: Int32Array;

  private readonly host: IEventLoopHost;
  private readonly origin: number;

  private processImmediate: (() => void) | null = null;
  private processTimers: ((now: number) => number) | null = null;
  private tickCallback: (() => void) | null = null;

  private timerDeadline: number | null = null;
  private timerRefed = true;
  private immediateRefed = false;
  private refs = 0;

  /** Receives errors thrown by callbacks the loop runs (uncaught exceptions). */
  onError: ((error: unknown) => void) | null = null;

  private cancelTimer: (() => void) | null = null;
  private pumpScheduled = false;
  private running = false;
  private waiters: Array<() => void> = [];

  private inCallback = false;
  private tickCheckScheduled = false;

  constructor(host: IEventLoopHost = defaultHost()) {
    this.host = host;
    this.origin = host.now();

    // Node's JS sets tickInfo[kHasTickScheduled] when process.nextTick queues
    // work. Inside a callback scope drainTicks() picks that up; outside one (a
    // nextTick called from a promise job) nobody would, so schedule a check on a
    // macrotask - which runs only after the microtask queue has fully drained,
    // exactly when Node's tick queue gets its turn.
    const storage = new Int32Array(2);
    this.tickInfo = new Proxy(storage, {
      get: (target, key) => (typeof key === "string" && /^\d+$/.test(key) ? target[Number(key)] : Reflect.get(target, key)),
      set: (target, key, value) => {
        if (typeof key === "string" && /^\d+$/.test(key)) {
          target[Number(key)] = value;
          if (Number(key) === K_HAS_TICK_SCHEDULED && value && !this.inCallback) this.scheduleTickCheck();
          return true;
        }
        return Reflect.set(target, key, value);
      },
    });
  }

  /** Loop time in whole milliseconds (`getLibuvNow`). */
  now(): number {
    return Math.floor(this.host.now() - this.origin);
  }

  // ---- what internalBinding('timers') / ('task_queue') call ------------------

  setupTimers(processImmediate: () => void, processTimers: (now: number) => number) {
    this.processImmediate = processImmediate;
    this.processTimers = processTimers;
  }

  setTickCallback(callback: () => void) {
    this.tickCallback = callback;
  }

  scheduleTimer(ms: number) {
    this.timerDeadline = this.now() + Math.max(1, ms);
    this.arm();
  }

  toggleTimerRef(refed: boolean) {
    this.timerRefed = refed;
    this.wake();
  }

  toggleImmediateRef(refed: boolean) {
    this.immediateRefed = refed;
    this.wake();
  }

  // ---- other sources of liveness (async fs, child processes, servers, ...) -----

  /** Keeps the loop alive until the returned function is called. Idempotent. */
  ref(): () => void {
    this.refs++;
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.refs--;
      this.wake();
    };
  }

  /** Schedules JS work from outside a loop callback (e.g. an fs completion). */
  post(fn: () => void) {
    this.host.setImmediate(() => this.callback(fn));
  }

  // ---- running -----------------------------------------------------------------

  /** True while a ref'd timer, ref'd immediate or ref'd handle is pending. */
  alive(): boolean {
    const timer = this.timerDeadline !== null && this.timerRefed;
    const immediates = this.immediateInfo[K_REF_COUNT] > 0;
    return timer || immediates || this.refs > 0;
  }

  /**
   * Runs a JS callback the way Node's native callback scope does: the callback,
   * then process.nextTick work, then (implicitly, when we return to the host)
   * the microtask queue.
   */
  callback(fn: () => void) {
    const outer = this.inCallback;
    this.inCallback = true;
    try {
      fn();
      this.drainTicks();
    } catch (error) {
      if (!this.onError) throw error;
      this.onError(error);
    } finally {
      this.inCallback = outer;
    }
  }

  drainTicks() {
    if (
      this.tickCallback &&
      (this.tickInfo[K_HAS_TICK_SCHEDULED] || this.tickInfo[K_HAS_REJECTION_TO_WARN])
    ) {
      this.tickCallback();
    }
  }

  /** Runs pending ticks/rejections that were queued outside any callback scope. */
  private scheduleTickCheck() {
    if (this.tickCheckScheduled) return;
    this.tickCheckScheduled = true;
    this.host.setImmediate(() => {
      this.tickCheckScheduled = false;
      this.callback(() => {});
    });
  }

  /** Resolves once nothing ref'd remains. Safe to call again afterwards (beforeExit). */
  run(): Promise<void> {
    return new Promise((resolve) => {
      this.waiters.push(resolve);
      this.running = true;
      this.wake();
    });
  }

  /** Stops the loop at once (process.exit): pending timers and handles are dropped. */
  abort() {
    this.running = false;
    this.timerDeadline = null;
    this.cancelTimer?.();
    this.cancelTimer = null;
    const waiters = this.waiters;
    this.waiters = [];
    for (const resolve of waiters) resolve();
  }

  private arm() {
    this.cancelTimer?.();
    this.cancelTimer = null;
    if (this.timerDeadline === null) return;
    this.cancelTimer = this.host.setTimeout(
      () => {
        this.cancelTimer = null;
        this.wake();
      },
      Math.max(0, this.timerDeadline - this.now()),
    );
  }

  private wake() {
    if (!this.running || this.pumpScheduled) return;
    this.pumpScheduled = true;
    this.host.setImmediate(() => {
      this.pumpScheduled = false;
      this.turn();
    });
  }

  private turn() {
    if (!this.running) return;

    // timers phase
    if (this.timerDeadline !== null && this.timerDeadline <= this.now() && this.processTimers) {
      this.timerDeadline = null;
      // Like node's RunTimers: if a timer callback throws and the error is
      // handled (uncaughtException), call processTimers again so the timers that
      // were left behind still run, rather than orphaning them.
      let next: number | undefined;
      while (next === undefined && this.running) {
        this.callback(() => {
          next = this.processTimers!(this.now());
        });
      }
      if (next !== undefined && next !== 0) {
        this.timerRefed = next > 0;
        this.timerDeadline = Math.abs(next);
      }
      this.arm();
    }

    // check phase
    if (this.immediateInfo[K_COUNT] > 0 && this.processImmediate) {
      this.callback(this.processImmediate);
    }

    if (this.immediateInfo[K_COUNT] > 0) {
      this.wake();
      return;
    }
    if (this.alive()) {
      // Only timers/handles remain: sleep until the timer fires or a handle is released.
      if (this.timerDeadline !== null && !this.cancelTimer) this.arm();
      return;
    }

    this.running = false;
    this.cancelTimer?.();
    this.cancelTimer = null;
    const waiters = this.waiters;
    this.waiters = [];
    for (const resolve of waiters) resolve();
  }
}

export { EventLoop, K_COUNT, K_HAS_REJECTION_TO_WARN, K_HAS_TICK_SCHEDULED, K_REF_COUNT };

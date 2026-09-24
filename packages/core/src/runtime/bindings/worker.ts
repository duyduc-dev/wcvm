// internalBinding('worker'): backs Node's real vendored internal/worker.js/internal/worker/io.js
// for worker_threads. No real OS threads with V8-isolate-level control - a "worker thread" is
// just another real Process Worker (kernel/processes.ts's own spawn(), same subtree-kill/
// parentPid tracking child_process already gets for free), reached via a real, native
// MessageChannel this binding mints LOCALLY: `.messagePort` is available synchronously, right
// after `new Worker()`, matching real Node's own contract - the kernel only ever needs to broker
// ONE half of it into the not-yet-existent child's own IProcessInit.
//
// Everything past that one real channel - the public postMessage()/parentPort channel, workerData,
// stdio piping (LOAD_SCRIPT and friends) - is handled entirely by already-vendored
// internal/worker.js/internal/worker/io.js code, using real platform structured clone and port
// transfer; nothing here reimplements any of that wire protocol - this binding only has to hand
// vendored code one real port and tell the kernel when to actually start the thread.
//
// Not implemented (no browser primitive exists at all - see PLAN.md's Known differences):
// cpuUsage(), startCpuProfile()/stopCpuProfile(), startHeapProfile()/stopHeapProfile(),
// getHeapSnapshot() - all need V8 Inspector/profiler access plain JS in a browser doesn't have.
// getHeapStatistics() is a best-effort approximation from the non-standard, often-unavailable
// `performance.memory`, not real V8 heap data. resourceLimits are accepted and reported back but
// never enforced - there's no way to configure a Worker's own V8 heap limits from JS either.

export type WorkerThreadEvent = { type: "exit"; childPid: number; code: number };

// filename/doEval/workerData are deliberately NOT here: real vendored internal/worker.js already
// sends the real LOAD_SCRIPT message (carrying exactly those) over `.messagePort` BEFORE ever
// calling startThread() - see that file's own constructor, which posts LOAD_SCRIPT, THEN calls
// `this[kHandle].startThread()` with zero arguments. A real MessagePort buffers a message sent
// before the other side is even listening, so by the time the newly spawned child actually reads
// its own getEnvMessagePort(), LOAD_SCRIPT is already waiting for it - nothing here needs to
// duplicate any of that.
export interface IWorkerThreadSpec {
  /** Minted synchronously, by THIS process, at WorkerHandle construction time - not by the
   *  kernel (see IWorkerContext.mintThreadId's own comment for why it can't wait for one). */
  threadId: number;
  threadName: string;
  isInternal: boolean;
  env: Record<string, string>;
  cwd: string;
  resourceLimits: number[];
  /** This new thread's own half of the real MessageChannel this binding just minted locally. */
  port: MessagePort;
}

export interface IWorkerThreadHost {
  /** `new Worker(...)`: `ticket` is this handle's own correlation id for the eventual
   *  workerThread:started reply (mirrors net.ts's own connect() ticket). */
  spawn(ticket: number, spec: IWorkerThreadSpec): void;
  kill(childPid: number): void;
  /** Registers the one handler for every workerThread:started reply and exit notification. */
  onEvent(handler: (event: { type: "started"; ticket: number; childPid: number; threadId: number } | WorkerThreadEvent) => void): void;
}

/** What this REALM (the current thread) needs to answer isMainThread/threadId/etc. about ITSELF -
 *  only present (non-undefined `self`) inside an actual worker_threads.Worker; the top of an
 *  ordinary `node script.js` process has isMainThread: true and no `self`. */
export interface IWorkerContext {
  /** `post` (EventLoop.post()) is used to dispatch workerThread:started/exit events from a clean
   *  call stack - see WorkerRouter's own comment on why this matters. */
  loop: { ref(): () => void; post(fn: () => void): void };
  workerThread?: IWorkerThreadHost;
  /** internalBinding('messaging').MessageChannel, NOT the raw global MessageChannel - it also
   *  calls internal/worker/io.js's own oninit() hook on both resulting ports (see messaging.ts's
   *  PLATFORM GAP comment); using the raw global here would silently skip that and crash the
   *  parent's own `.messagePort` the moment vendored code calls `.on()` on it. */
  messageChannel: new () => MessageChannel;
  /** Mints a globally-unique threadId synchronously, via a SharedArrayBuffer-backed atomic
   *  counter every process shares (workers/process/messages.ts's IProcessInit.threadIdCounterSab) -
   *  NOT a kernel round trip like pid. Real vendored internal/worker.js reads `this.threadId`
   *  immediately after constructing its own native handle, before it ever calls startThread() (see
   *  that file's own `debug(...)`/createMainThreadPort(this.threadId) calls, right after `new
   *  WorkerImpl(...)`) - a kernel-minted, async threadId would still be the placeholder value at
   *  that point. Confirmed in real Chromium: internal/worker/messaging.js's own createMainThreadPort()
   *  registers its port under whatever `this.threadId` reads AT THAT MOMENT, so an async mint left
   *  it registered under the wrong key - destroyMainThreadPort() later threw "Cannot read
   *  properties of undefined (reading 'close')" the moment the worker thread exited. Undefined only
   *  for a caller that never wires worker_threads support at all (falls back to -1, matching the
   *  pre-existing "no host wired" ERR_WORKER_NOT_RUNNING path). */
  mintThreadId?: () => number;
  isMainThread: boolean;
  /** Real Node's own worker threads inherit their OS process's cwd/env implicitly (same process,
   *  same OS-level state) - here, each is its own separate Process Worker, so a new one needs an
   *  explicit starting cwd/env handed down at spawn time (read fresh in startThread(), not at
   *  construction, matching how close those two calls run in practice - see runtime.ts). */
  cwd: () => string;
  env: () => Record<string, string>;
  self?: {
    threadId: number;
    threadName: string;
    resourceLimits: number[];
    /** internalBinding('worker').getEnvMessagePort()'s return value: this thread's own half of
     *  the real channel its PARENT's WorkerHandle kept as `.messagePort`. */
    port: MessagePort;
  };
}

// Real Node's own resourceLimits Float64Array slot layout (internal/worker.js's own kMax*/kCode*/
// kStack* constants) - the exact index values don't matter beyond staying internally consistent,
// since nothing outside this binding and that vendored module's own constants ever reads them.
const K_MAX_YOUNG_GENERATION_SIZE_MB = 0;
const K_MAX_OLD_GENERATION_SIZE_MB = 1;
const K_CODE_RANGE_SIZE_MB = 2;
const K_STACK_SIZE_MB = 3;
const K_TOTAL_RESOURCE_LIMIT_COUNT = 4;

/** A "taker" object shaped like real Node's own async profiling handles (`.ondone(error)` /
 *  `.ondone(error, result)`, called asynchronously) - reports a clean, honest failure instead of
 *  pretending any real work started (see file header: no browser primitive exists for any of
 *  these at all, not a scope choice). */
class NotSupportedTaker {
  ondone: ((error: Error, result?: unknown) => void) | null = null;
  constructor(what: string) {
    queueMicrotask(() => {
      this.ondone?.(new Error(`${what}() is not supported: no browser API exposes V8 profiler/inspector data to plain JS`));
    });
  }
}

class WorkerHandle {
  onexit: ((code: number, customErr?: string, customErrReason?: string) => void) | null = null;
  invalidExecArgv: string[] | undefined;
  invalidNodeOptions: string[] | undefined;
  readonly messagePort: MessagePort;
  threadId = -1;
  readonly threadName: string;
  closed = false;

  // Not `private`: this class is returned from an exported factory (createWorkerBinding), and TS
  // can't emit a declaration type for an exported anonymous class with private members - same
  // reason net.ts's own TCP class avoids `private` on its fields.
  readonly router: WorkerRouter;
  readonly ticket: number;
  readonly childPort: MessagePort;
  readonly resourceLimitsArr: number[];
  readonly isInternal: boolean;
  release: (() => void) | null = null;
  childPid: number | undefined;

  constructor(
    router: WorkerRouter,
    _url: string | null,
    _env: Record<string, string> | null,
    _execArgv: string[] | undefined,
    resourceLimits: Float64Array,
    _trackUnmanagedFds: boolean,
    isInternal: boolean,
    name: string,
  ) {
    this.router = router;
    this.threadName = name;
    this.isInternal = isInternal;
    this.resourceLimitsArr = Array.from(resourceLimits);
    const { port1, port2 } = new router.messageChannel();
    this.messagePort = port1;
    this.childPort = port2;
    this.ticket = router.mintTicket();
    // Synchronous, not deferred to startThread() or onStarted() - see IWorkerContext.mintThreadId's
    // own comment for why real vendored internal/worker.js needs this available immediately.
    this.threadId = router.mintThreadId ? router.mintThreadId() : -1;
    router.registerPending(this.ticket, this);
  }

  /** Real vendored internal/worker.js has already sent the real LOAD_SCRIPT message over
   *  `.messagePort` by the time it calls this (see that file's own constructor, and this file's
   *  header comment) - all THIS does is actually ask the kernel to bring the new thread up.
   *  filename/doEval/workerData are never read from here; the child learns them purely from that
   *  already-sent (and, thanks to real MessagePort buffering, already-queued-and-waiting)
   *  message, exactly like a real worker_threads child does. */
  startThread(): void {
    // Real Node's own docs are explicit about this default: "a newly-spawned worker is
    // considered ref'd" - a currently running Worker keeps the parent process alive all by
    // itself, independent of whether any 'message'/'online'/'error' listener happens to also ref
    // it via setupPortReferencing (internal/worker.js's own constructor never calls this[kHandle]
    // .ref() itself - real Node's native C++ handle refs the loop automatically, the same "a real
    // uv_handle_t is ref'd the moment it starts representing real, active work" pattern net.ts's
    // own TCP.connect() and fs.watch's own FSEvent already follow in this sandbox). Without this,
    // a worker thread contacted only via 'online'/'error' (no 'message' listener, so nothing else
    // happens to ref the loop) would let its parent exit before those events could ever arrive -
    // confirmed in real Chromium: w.on('online', ...)-only and nested worker-spawns-worker
    // scripts both exited immediately with empty output before this fix.
    this.ref();
    if (!this.router.host) {
      // Real Node's own ERR_WORKER_NOT_RUNNING takes zero constructor arguments (see internal/
      // worker.js's own `new ERR_WORKER_NOT_RUNNING()` calls) - internal/worker.js's [kOnExit]
      // does `new errorCodes[customErr](customErrReason)`, and vendored internal/errors.js's own
      // error-class machinery asserts the passed argument count against the template's declared
      // arity, throwing ERR_INTERNAL_ASSERTION if they don't match. Passing a reason string here
      // for a zero-arg error class crashed this realm's kernel worker with an uncaught internal
      // assertion instead of ever reaching this queued onexit call - found in real Chromium.
      queueMicrotask(() => this.onexit?.(1, "ERR_WORKER_NOT_RUNNING"));
      return;
    }
    this.router.host.spawn(this.ticket, {
      threadId: this.threadId,
      threadName: this.threadName,
      isInternal: this.isInternal,
      env: this.router.env(),
      cwd: this.router.cwd(),
      resourceLimits: this.resourceLimitsArr,
      port: this.childPort,
    });
  }

  stopThread(): void {
    if (this.childPid !== undefined) this.router.host?.kill(this.childPid);
  }

  ref(): void {
    this.release ??= this.router.loop.ref();
  }
  unref(): void {
    this.release?.();
    this.release = null;
  }

  getResourceLimits(): Float64Array {
    return new Float64Array(this.resourceLimitsArr);
  }

  /** Internal: fed by WorkerRouter once the kernel actually assigns a real pid - threadId was
   *  already minted synchronously at construction time (see the constructor), so `threadId` here
   *  is just the kernel's own echo of the same value, not a new assignment. */
  onStarted(childPid: number, threadId: number): void {
    this.childPid = childPid;
    this.threadId = threadId;
  }

  /** Internal: fed by WorkerRouter once the real child process exits. */
  onExit(code: number): void {
    this.closed = true;
    this.release?.();
    this.release = null;
    this.onexit?.(code);
  }

  // ---- Not implemented: no browser primitive for any of these (see file header) --------------

  cpuUsage(): NotSupportedTaker {
    return new NotSupportedTaker("cpuUsage");
  }
  startCpuProfile(): NotSupportedTaker {
    return new NotSupportedTaker("startCpuProfile");
  }
  stopCpuProfile(): NotSupportedTaker {
    return new NotSupportedTaker("stopCpuProfile");
  }
  startHeapProfile(): NotSupportedTaker {
    return new NotSupportedTaker("startHeapProfile");
  }
  stopHeapProfile(): NotSupportedTaker {
    return new NotSupportedTaker("stopHeapProfile");
  }
  takeHeapSnapshot(): NotSupportedTaker {
    return new NotSupportedTaker("getHeapSnapshot");
  }

  /** Best-effort only, from the non-standard, often-unavailable `performance.memory` - not real
   *  V8 heap data (see file header). Whatever it can't answer is reported as 0. */
  getHeapStatistics(): { ondone: ((error: null, result: Record<string, number>) => void) | null } {
    const taker: { ondone: ((error: null, result: Record<string, number>) => void) | null } = { ondone: null };
    queueMicrotask(() => {
      const mem = (performance as { memory?: { usedJSHeapSize?: number; totalJSHeapSize?: number; jsHeapSizeLimit?: number } }).memory;
      taker.ondone?.(null, {
        total_heap_size: mem?.totalJSHeapSize ?? 0,
        total_heap_size_executable: 0,
        total_physical_size: 0,
        total_available_size: 0,
        used_heap_size: mem?.usedJSHeapSize ?? 0,
        heap_size_limit: mem?.jsHeapSizeLimit ?? 0,
        malloced_memory: 0,
        peak_malloced_memory: 0,
        does_zap_garbage: 0,
        number_of_native_contexts: 0,
        number_of_detached_contexts: 0,
      });
    });
    return taker;
  }
}

const TICKET_MULTIPLIER = 1_000_000;

/** Shared per running script: ticket minting, and the one subscription to worker-thread events. */
class WorkerRouter {
  readonly host?: IWorkerThreadHost;
  readonly loop: IWorkerContext["loop"];
  readonly cwd: () => string;
  readonly env: () => Record<string, string>;
  readonly messageChannel: new () => MessageChannel;
  readonly mintThreadId?: () => number;
  private counter = 0;
  private readonly pendingByTicket = new Map<number, WorkerHandle>();
  private readonly handlesByChildPid = new Map<number, WorkerHandle>();

  constructor(ctx: IWorkerContext) {
    this.host = ctx.workerThread;
    this.loop = ctx.loop;
    this.cwd = ctx.cwd;
    this.env = ctx.env;
    this.messageChannel = ctx.messageChannel;
    this.mintThreadId = ctx.mintThreadId;
    // Deferred via loop.post(), NOT called directly from whatever delivered the event (a real,
    // native "child:exit"/"workerThread:started" postMessage arriving on self.onmessage, entirely
    // outside this runtime's own EventLoop callback machinery): dispatch() below can reach
    // vendored internal/worker.js's own `this.emit('exit', code)` (a plain EventEmitter emit, NOT
    // NodeEventTarget's own [kHybridDispatch], which has its own try/catch routing to
    // emitUncaughtException - a plain EventEmitter has no such thing) - if guest code calls
    // process.exit() synchronously from inside a 'exit'/'online'/'error' listener, the thrown
    // ProcessExit needs to unwind through a call stack this runtime's own loop.callback() wraps
    // (which routes it to loop.onError, i.e. runtime.ts's handleUncaught), or it escapes as a
    // genuine uncaught exception at this whole process's own top level. Confirmed in real
    // Chromium: `w.on('exit', (code) => process.exit(1))` crashed the KERNEL worker itself (the
    // exception bubbled: this process -> kernel worker's own onerror not preventDefault()ing ->
    // the host page) instead of just setting the exit code, exactly like the pre-existing
    // readline "line"/"close" listener gotcha this file's project-level docs already describe -
    // same root cause, different call site.
    this.host?.onEvent((event) => this.loop.post(() => this.dispatch(event)));
  }

  mintTicket(): number {
    return ++this.counter * TICKET_MULTIPLIER;
  }

  registerPending(ticket: number, handle: WorkerHandle): void {
    this.pendingByTicket.set(ticket, handle);
  }

  private dispatch(event: { type: "started"; ticket: number; childPid: number; threadId: number } | WorkerThreadEvent): void {
    if (event.type === "started") {
      const handle = this.pendingByTicket.get(event.ticket);
      if (!handle) return;
      this.pendingByTicket.delete(event.ticket);
      this.handlesByChildPid.set(event.childPid, handle);
      handle.onStarted(event.childPid, event.threadId);
      return;
    }
    const handle = this.handlesByChildPid.get(event.childPid);
    if (!handle) return;
    this.handlesByChildPid.delete(event.childPid);
    handle.onExit(event.code);
  }
}

const routers = new WeakMap<IWorkerContext, WorkerRouter>();
const routerFor = (ctx: IWorkerContext): WorkerRouter => {
  let router = routers.get(ctx);
  if (!router) {
    router = new WorkerRouter(ctx);
    routers.set(ctx, router);
  }
  return router;
};

export const createWorkerBinding = (ctx: IWorkerContext) => {
  const router = routerFor(ctx);

  const getEnvMessagePort = (): MessagePort | undefined => ctx.self?.port;

  return {
    ownsProcessState: ctx.isMainThread,
    isMainThread: ctx.isMainThread,
    isInternalThread: false,
    threadId: ctx.isMainThread ? 0 : (ctx.self?.threadId ?? 0),
    threadName: ctx.isMainThread ? "MainThread" : (ctx.self?.threadName ?? "WorkerThread"),
    resourceLimits: new Float64Array(ctx.self?.resourceLimits ?? [-1, -1, -1, -1]),
    kMaxYoungGenerationSizeMb: K_MAX_YOUNG_GENERATION_SIZE_MB,
    kMaxOldGenerationSizeMb: K_MAX_OLD_GENERATION_SIZE_MB,
    kCodeRangeSizeMb: K_CODE_RANGE_SIZE_MB,
    kStackSizeMb: K_STACK_SIZE_MB,
    kTotalResourceLimitCount: K_TOTAL_RESOURCE_LIMIT_COUNT,
    getEnvMessagePort,
    Worker: class extends WorkerHandle {
      constructor(
        url: string | null,
        env: Record<string, string> | null,
        execArgv: string[] | undefined,
        resourceLimits: Float64Array,
        trackUnmanagedFds: boolean,
        isInternal: boolean,
        name: string,
      ) {
        super(router, url, env, execArgv, resourceLimits, trackUnmanagedFds, isInternal, name);
      }
    },
  };
};

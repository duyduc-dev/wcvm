import type { EventLoop } from "../eventLoop";

// Bindings that expose the EventLoop to Node's vendored timers, task queue and
// async-hooks code. Field layouts and constants follow src/env.h / async_wrap.h.

export const createTimersBinding = (loop: EventLoop) => ({
  immediateInfo: loop.immediateInfo,
  timeoutInfo: loop.timeoutInfo,
  setupTimers: (processImmediate: () => void, processTimers: (now: number) => number) =>
    loop.setupTimers(processImmediate, processTimers),
  scheduleTimer: (ms: number) => loop.scheduleTimer(ms),
  toggleTimerRef: (refed: boolean) => loop.toggleTimerRef(refed),
  toggleImmediateRef: (refed: boolean) => loop.toggleImmediateRef(refed),
  getLibuvNow: () => loop.now(),
});

// promiseRejectEvents from node_task_queue.cc
const PROMISE_REJECT_EVENTS = {
  kPromiseRejectWithNoHandler: 0,
  kPromiseHandlerAddedAfterReject: 1,
  kPromiseResolveAfterResolved: 2,
  kPromiseRejectAfterResolved: 3,
};

export interface ITaskQueueBinding {
  /** Called by the host when a promise is rejected with no handler, or gains one late. */
  reportRejection(event: number, promise: Promise<unknown>, reason?: unknown): void;
}

export const createTaskQueueBinding = (loop: EventLoop) => {
  let rejectCallback: ((...args: unknown[]) => void) | null = null;
  return {
    tickInfo: loop.tickInfo,
    // V8's microtask queue cannot be drained synchronously from JS; promise
    // jobs run when control returns to the host, right after the tick loop.
    runMicrotasks: () => {},
    setTickCallback: (fn: () => void) => loop.setTickCallback(fn),
    enqueueMicrotask: (fn: () => void) => queueMicrotask(fn),
    setPromiseRejectCallback: (fn: (...args: unknown[]) => void) => {
      rejectCallback = fn;
    },
    promiseRejectEvents: PROMISE_REJECT_EVENTS,
    reportRejection: (event: number, promise: Promise<unknown>, reason?: unknown) =>
      rejectCallback?.(event, promise, reason),
  };
};

// async_hook_fields / async_id_fields indices (async_wrap.h)
const kInit = 0;
const kBefore = 1;
const kAfter = 2;
const kDestroy = 3;
const kPromiseResolve = 4;
const kTotals = 5;
const kCheck = 6;
const kStackLength = 7;
const kUsesExecutionAsyncResource = 8;
const kExecutionAsyncId = 0;
const kTriggerAsyncId = 1;
const kAsyncIdCounter = 2;
const kDefaultTriggerAsyncId = 3;

export const createAsyncWrapBinding = () => {
  const async_hook_fields = new Uint32Array(9);
  const async_id_fields = new Float64Array(4);
  const async_ids_stack = new Float64Array(16 * 2);
  const execution_async_resources: unknown[] = [];

  async_hook_fields[kCheck] = 1;
  async_id_fields[kAsyncIdCounter] = 1;
  async_id_fields[kDefaultTriggerAsyncId] = -1;

  return {
    async_hook_fields,
    async_id_fields,
    async_ids_stack,
    execution_async_resources,
    constants: {
      kInit, kBefore, kAfter, kDestroy, kPromiseResolve, kTotals, kCheck,
      kStackLength, kUsesExecutionAsyncResource,
      kExecutionAsyncId, kTriggerAsyncId, kAsyncIdCounter, kDefaultTriggerAsyncId,
    },
    Providers: {},
    setCallbackTrampoline: () => {},
    registerDestroyHook: () => {},
    queueDestroyAsyncId: () => {},
    setupHooks: () => {},
    setPromiseHooks: () => {},
    getPromiseHooks: () => [undefined, undefined, undefined, undefined],
    // Only reached when the JS-side stack overflows its fixed typed array.
    pushAsyncContext: (asyncId: number, triggerId: number) => {
      const offset = async_hook_fields[kStackLength];
      async_hook_fields[kStackLength]++;
      async_id_fields[kExecutionAsyncId] = asyncId;
      async_id_fields[kTriggerAsyncId] = triggerId;
      return offset;
    },
    popAsyncContext: () => async_hook_fields[kStackLength] > 0,
    executionAsyncResource: (index: number) => execution_async_resources[index],
    clearAsyncIdStack: () => {
      async_hook_fields[kStackLength] = 0;
      execution_async_resources.length = 0;
      async_id_fields[kExecutionAsyncId] = 0;
      async_id_fields[kTriggerAsyncId] = 0;
    },
  };
};

// internalBinding('messaging'): backs Node's real vendored internal/worker/io.js. MessagePort/
// MessageChannel are the real, native platform classes here - a Web Worker's own postMessage/
// structured-clone machinery, not something this sandbox reimplements. internal/worker/io.js
// itself does the real work of layering Node's own event-target/stream conventions on top of
// them (it even prototype-swaps the real MessagePort onto its own NodeEventTarget - see that
// file's own comment on why), the same "the platform already ships a spec-compliant one, build
// Node's own API surface on top of it" pattern internal/url.js's real URL/URLSearchParams already
// established in this sandbox.
//
// receiveMessageOnPort() (synchronous message draining outside an event listener) has no browser
// equivalent at all - a real platform limitation, not a choice, the same category as zlib.ts's
// missing Brotli support: it always reports "no message available" rather than pretending to
// drain a queue this sandbox has no way to inspect synchronously.
//
// PLATFORM GAP: real Node's own native MessagePort C++ binding calls `port[onInitSymbol]()`
// (internalBinding('symbols').oninit) DURING CONSTRUCTION, in C++ - internal/worker/io.js relies
// on this (its own oninit() sets up this[kEvents] etc., the NodeEventTarget state .on()/
// .addEventListener() need) to make every MessagePort work. A real platform MessagePort (browser
// or otherwise) has no such hook; nothing calls it. Confirmed in real Chromium, not just under
// Node/Vitest: constructing a plain `new Worker(...)` crashed at `MessagePort.on` with "Cannot
// read properties of undefined (reading 'get')" before this fix. Worked around two ways below:
// MessageChannel is wrapped to call oninit() on both ports the instant they're created (covers
// every port created LOCALLY, in this realm - by our own bindings/worker.ts, or by vendored code
// itself, e.g. internal/worker.js's own `new MessageChannel()` for its public/main-thread ports),
// and initReceivedPort() is exposed for a port that crossed a REAL postMessage transfer from
// ANOTHER realm (a different Process Worker) - oninit()'s effects are plain per-object JS state,
// which does NOT survive a structured-clone transfer (the receiving side gets a fresh JS wrapper
// around the same underlying channel endpoint) - so whoever first hands such a port to guest code
// (runWorkerThread.ts, for the child's own publicPort/mainThreadPort) must call this explicitly.
// Both are safe to call before internal/worker/io.js has loaded (oninit is looked up lazily, at
// call time, never at this factory's own construction time) and a no-op if it never loads at all
// (a script that never touches worker_threads).
//
// SECOND PLATFORM GAP, found right after fixing the first: real Node's native MessagePort also
// has .ref()/.unref()/.hasRef() (event-loop keep-alive, same concept a timer or net.ts's TCP
// handle has) - a real platform MessagePort has none of the three. internal/worker/io.js's own
// prototype-swap dance (see its file header) snapshots MessagePort.prototype's OWN properties
// BEFORE swapping its parent to NodeEventTarget.prototype, then copies ref/unref/hasRef back
// afterward - so they must already be real, own, callable properties of MessagePort.prototype
// by the time that snapshot is taken (module-load time of internal/worker/io.js), or the copy
// carries over `undefined` and setupPortReferencing()'s own `port.unref()` throws "is not a
// function" - confirmed in real Chromium, one step past the first crash above. Fixed by
// installing all three directly on the real global MessagePort.prototype, once, backed by
// ctx.loop.ref() exactly like this file's own broadcastChannel() helper already does per-handle.
//
// THIRD PLATFORM GAP, found once the first two stopped crashing but a message still never reached
// a real `.on('message', ...)` listener: internal/event_target.js's own EventTarget/NodeEventTarget
// (what MessagePort.prototype's parent gets swapped to) is a COMPLETE, independent, hand-written
// reimplementation - `class EventTarget { ... }`, not `extends` the real, native platform
// EventTarget - with its own private, JS-level listener store (a `this[kEvents]` map, populated by
// .on()/.addEventListener() AFTER the swap). Real Node's own native C++ MessagePort binding is
// written to cooperate with this directly: on every incoming message it calls a specific,
// WELL-KNOWN hook - `port[Symbol.for('nodejs.internal.kHybridDispatch')](rawData, type)`, a
// `Symbol.for(...)`, not a private, module-scoped `Symbol()` - which internal/event_target.js's own
// EventTarget class exposes; that builds a proper event (via the [kCreateEvent] hook
// internal/worker/io.js itself overrides, using `Symbol.for('nodejs.internal.kCurrentlyReceivingPorts')`
// for any transferred ports) and invokes whatever sits in `this[kEvents]`. A real BROWSER
// MessagePort has no idea any of this exists: its own message delivery is pure browser-internal
// C++, entirely separate from whatever currently sits on MessagePort.prototype -
// .addEventListener()/.on() calls succeed (they just write to the JS-only kEvents store) but the
// browser's real delivery mechanism never reads that store, so no listener ever fires. Confirmed in
// real Chromium: a worker thread successfully posted a message and exited cleanly, yet the parent's
// own `.on('message', ...)` handler never ran at all - no crash, a silent no-op (unlike the first
// two gaps, which threw immediately and so were easy to spot).
//
// Fixed by bridging the two explicitly: for every port this binding hands out, register a REAL,
// NATIVE listener via the ORIGINAL MessagePort.prototype.addEventListener - captured HERE, at this
// factory's own top, before internal/worker/io.js has had any chance to swap the prototype (this
// factory runs from INSIDE that module's own top-level `internalBinding('messaging')` call, which
// happens before its prototype-swap code further down the very same file, so this always captures
// the real, unswapped method). That native listener manually calls `port[kHybridDispatch](data,
// type)` on every real incoming message - the exact call real Node's own native binding makes -
// letting vendored internal/worker/io.js's own [kCreateEvent] override build the proper event and
// NodeEventTarget's own dispatch invoke whatever real listeners guest code (or vendored code)
// registered via .on()/.addEventListener() after the swap. The lookup of kHybridDispatch itself
// happens lazily, INSIDE the native listener (never at registration time), so it's safe to install
// this bridge before internal/worker/io.js has loaded in this realm at all - by the time any real
// message can possibly arrive (always at least one task/microtask later), the module has loaded.

export interface IMessagingContext {
  loop: { ref(): () => void };
  internalBinding: (name: string) => any;
}

interface IBroadcastChannelHandle {
  on(event: "message" | "messageerror", handler: (data: unknown) => void): void;
  off(event: "message" | "messageerror", handler: (data: unknown) => void): void;
  postMessage(data: unknown): void;
  close(): void;
  ref(): void;
  unref(): void;
}

export const createMessagingBinding = (ctx: IMessagingContext) => {
  const MessagePort = (globalThis as unknown as { MessagePort?: { prototype: Record<string, unknown> } }).MessagePort;
  const RealMessageChannel = (globalThis as { MessageChannel?: new () => MessageChannel }).MessageChannel;
  const DOMException = (globalThis as { DOMException?: unknown }).DOMException;

  // See the SECOND PLATFORM GAP comment above. Installed once, directly on the real global
  // class's prototype (guarded against double-install, in case this factory ever ran twice).
  if (MessagePort && typeof MessagePort.prototype.ref !== "function") {
    const releases = new WeakMap<object, (() => void) | null>();
    MessagePort.prototype.ref = function (this: object) {
      if (releases.get(this) == null) releases.set(this, ctx.loop.ref());
      return this;
    };
    MessagePort.prototype.unref = function (this: object) {
      releases.get(this)?.();
      releases.set(this, null);
      return this;
    };
    MessagePort.prototype.hasRef = function (this: object) {
      return releases.get(this) != null;
    };
  }

  // See the THIRD PLATFORM GAP comment above. Captured now, at this factory's own top - before
  // internal/worker/io.js (which requires this binding first thing) has had any chance to swap
  // MessagePort.prototype's parent - so this is always the real, native, unswapped method.
  const realAddEventListener = MessagePort?.prototype.addEventListener as
    | ((this: object, type: string, listener: (event: MessageEvent) => void) => void)
    | undefined;
  const kHybridDispatch = Symbol.for("nodejs.internal.kHybridDispatch");
  const kCurrentlyReceivingPorts = Symbol.for("nodejs.internal.kCurrentlyReceivingPorts");
  const bridgedPorts = new WeakSet<object>();
  const bridgeNativeDispatch = (port: object): void => {
    if (!realAddEventListener || bridgedPorts.has(port)) return;
    bridgedPorts.add(port);
    for (const type of ["message", "messageerror"] as const) {
      realAddEventListener.call(port, type, (event: MessageEvent) => {
        // A port arriving WITHIN a message on an already-bridged port (e.g. vendored
        // internal/worker/messaging.js's own REGISTER_MAIN_THREAD_PORT handling, receiving a
        // THIRD worker's own mainThreadPortToMain relayed through a second worker's mainThreadPort)
        // crossed a real transfer too, and nothing but this bridge itself ever sees it arrive -
        // there's no call site of ours to add an explicit initReceivedPort() at, unlike
        // runWorkerThread.ts's own bootstrap ports. Recursively initializing every port riding
        // along on any message this bridge already sees covers that transitive closure
        // automatically: initPort() below both runs oninit() AND (via this same function) bridges
        // that port too, so ITS OWN future incoming transfers are covered the same way. Confirmed
        // in real Chromium: a worker thread spawning a nested worker thread of its own crashed
        // here ("Cannot read properties of undefined (reading 'get')") before this fix.
        for (const transferred of event.ports ?? []) initPort(transferred);
        (port as Record<symbol, unknown>)[kCurrentlyReceivingPorts] = event.ports?.length ? event.ports : undefined;
        (port as Record<symbol, ((data: unknown, type: string) => void) | undefined>)[kHybridDispatch]?.(event.data, type);
      });
    }
  };

  // See the PLATFORM GAP comment above the interface. Looked up lazily (per call, not once at
  // factory time): internal/worker/io.js is what defines onInitSymbol on MessagePort.prototype,
  // and it does so only AFTER its own `internalBinding('messaging')` call (this factory) already
  // returned - the symbol genuinely does not exist yet while this factory itself is running.
  const initPort = <T>(port: T): T => {
    const oninit = (ctx.internalBinding("symbols") as Record<string, symbol> | undefined)?.oninit;
    if (oninit) (port as Record<symbol, (() => void) | undefined>)[oninit]?.();
    bridgeNativeDispatch(port as object);
    return port;
  };

  const MessageChannel = RealMessageChannel
    ? (class extends RealMessageChannel {
        constructor() {
          super();
          initPort(this.port1);
          initPort(this.port2);
        }
      } as unknown as new () => MessageChannel)
    : RealMessageChannel;

  // Real Node's own low-level handle a BroadcastChannel instance wraps (internal/worker/io.js's
  // own public BroadcastChannel class is layered on top of this, not on the real platform
  // BroadcastChannel directly) - here, a thin EventEmitter-shaped wrapper around the real one.
  const broadcastChannel = (name: string): IBroadcastChannelHandle => {
    const real = new (globalThis as { BroadcastChannel: new (name: string) => globalThis.BroadcastChannel }).BroadcastChannel(name);
    const listeners: { message: Set<(data: unknown) => void>; messageerror: Set<(data: unknown) => void> } = {
      message: new Set(),
      messageerror: new Set(),
    };
    real.onmessage = (event) => listeners.message.forEach((fn) => fn(event.data));
    real.onmessageerror = (event) => listeners.messageerror.forEach((fn) => fn(event.data));
    let release: (() => void) | null = null;
    return {
      on: (event, handler) => listeners[event].add(handler),
      off: (event, handler) => listeners[event].delete(handler),
      postMessage: (data) => real.postMessage(data),
      close: () => {
        real.close();
        release?.();
        release = null;
      },
      // BroadcastChannel has no natural "pending work" signal of its own (unlike a TCP
      // connection or a bound UDP socket) - ref() only matters once something actually asks
      // for it, exactly like net.ts's TCP.ref()/unref() pair.
      ref: () => {
        release ??= ctx.loop.ref();
      },
      unref: () => {
        release?.();
        release = null;
      },
    };
  };

  // No internal queue of our own to drain/pause - the real platform port already owns its own
  // buffering, and there's no vm-context isolation in this sandbox for moveMessagePortToContext
  // to actually move anything between (every realm here is just "the current real Worker").
  const drainMessagePort = (_port: unknown): void => {};
  const moveMessagePortToContext = (port: unknown, _context: unknown): unknown => port;
  const stopMessagePort = (_port: unknown): void => {};

  const receiveMessageOnPort = (_port: unknown): unknown => ctx.internalBinding("symbols").no_message_symbol;

  return {
    MessagePort,
    MessageChannel,
    DOMException,
    broadcastChannel,
    drainMessagePort,
    moveMessagePortToContext,
    receiveMessageOnPort,
    stopMessagePort,
    // Not part of real Node's own internalBinding('messaging') surface - an extra, sandbox-only
    // escape hatch for runtime-layer code (not vendored code, which never calls this itself) that
    // receives a MessagePort over an ordinary postMessage transfer from another realm and needs
    // it usable by vendored .on()/.addEventListener()-style code. See the PLATFORM GAP comment.
    initReceivedPort: initPort,
  };
};

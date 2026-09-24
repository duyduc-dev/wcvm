import { WcvmError } from "../../errors/WcvmError";
import type { IFsClient } from "../../fs/fsClient";
import type { ISyscallClient } from "../../protocols/syscall";
import type { EventLoop } from "../eventLoop";
import { createBufferBinding } from "./buffer";
import { createPipeWrapBinding, createProcessWrapBinding, createSpawnSyncBinding, createStreamWrapBinding, type IChildProcessHost } from "./childProcess";
import { createConstantsBinding } from "./constants";
import { createCryptoBinding } from "./crypto";
import { createFsBinding, createFsDirBinding, createFsEventWrapBinding, type IFsWatchHost } from "./fs";
import { createHttpParserBinding } from "./http";
import { createLocksBinding } from "./locks";
import { createAsyncWrapBinding, createTaskQueueBinding, createTimersBinding } from "./loop";
import { createMessagingBinding } from "./messaging";
import {
  createAsyncContextFrameBinding,
  createCaresWrapBinding,
  createConfigBinding,
  createCredentialsBinding,
  createDiagnosticsChannelBinding,
  createErrorsBinding,
  createMksnapshotBinding,
  createOptionsBinding,
  createOsBinding,
  createPermissionBinding,
  createProfilerBinding,
  createTraceEventsBinding,
  createTtyWrapBinding,
  createUvBinding,
} from "./misc";
import { createTcpWrapBinding, type INetHost } from "./net";
import { createPerformanceBinding } from "./performance";
import { createStringDecoderBinding } from "./stringDecoder";
import { createTypesBinding } from "./types";
import { createUdpWrapBinding, type IUdpHost } from "./udp";
import { createEncodingBinding, createUrlBinding, createUrlPatternBinding } from "./url";
import { createSymbolsBinding, createUtilBinding } from "./util";
import { createWorkerBinding, type IWorkerContext, type IWorkerThreadHost } from "./worker";
import { createZlibBinding } from "./zlib";

interface IBindingContext {
  /** For bindings that call back into Node's own modules (defineLazyProperties). */
  requireBuiltin(id: string): any;
  /** For bindings that call back into another OWN binding (e.g. messaging needs symbols' own
   *  no_message_symbol) - a forward reference, set right after createInternalBinding(ctx) itself
   *  returns (see runtime.ts), the same "assign the self-reference once construction is done"
   *  trick kernel/index.ts already uses for processes/kernelSyncServer. */
  internalBinding?(name: string): any;
  loop: EventLoop;
  /** The process object, for bindings that read its environment. */
  process?: any;
  /** The sync fs client; without it the `fs` binding is unavailable. */
  fs?: IFsClient;
  /** Where fd 1 / fd 2 writes go. */
  writeStdio?: (fd: 1 | 2, chunk: Uint8Array) => void;
  /** Spawns/kills child_process children via the kernel; without it, pipe_wrap/process_wrap are unavailable. */
  childProcess?: IChildProcessHost;
  /** Blocks on the kernel until a child exits, with its buffered output; without it, spawn_sync throws ENOSYS. */
  spawnSync?: ISyscallClient;
  /** Delivers fs.watch change events pushed from the kernel; without it, fs.watch() throws ENOSYS. */
  fsWatch?: IFsWatchHost;
  /** The virtual network's async half (connect/data/close); without it, TCP methods return ENOSYS/ENOTCONN. */
  net?: INetHost;
  /** The virtual network's blocking half (net.Server.listen() and dgram's Socket.bind() - see
   *  protocols/syscall.ts's OP_NET_LISTEN/OP_UDP_BIND); without it, listen()/bind() return ENOSYS. */
  netSync?: ISyscallClient;
  /** UDP's async half (incoming datagrams); without it, dgram methods return ENOSYS/ENOTCONN. */
  udp?: IUdpHost;
  /** worker_threads: spawns/kills a real, separate Process Worker for `new Worker(...)`; without
   *  it, worker_threads.Worker's startThread() reports ERR_WORKER_NOT_RUNNING. */
  workerThread?: IWorkerThreadHost;
  /** True at the top of an ordinary `node script.js` process; false inside a worker_threads.Worker. */
  isMainThread?: boolean;
  /** Set only inside a worker_threads.Worker (isMainThread === false) - see
   *  workers/process/messages.ts's IWorkerThreadInit, which runtime.ts reads to build this. */
  workerSelf?: IWorkerContext["self"];
  /** Mints a globally-unique worker_threads threadId synchronously; without it, `new Worker(...)`
   *  construction throws - see bindings/worker.ts's own comment on why this can't be async. */
  mintThreadId?: () => number;
}

type BindingFactory = (ctx: IBindingContext) => object;

const factories: Record<string, BindingFactory> = {
  async_context_frame: () => createAsyncContextFrameBinding(),
  async_wrap: () => createAsyncWrapBinding(),
  buffer: () => createBufferBinding(),
  cares_wrap: () => createCaresWrapBinding(),
  config: () => createConfigBinding(),
  constants: () => createConstantsBinding(),
  crypto: (ctx) => createCryptoBinding(ctx),
  encoding_binding: () => createEncodingBinding(),
  diagnostics_channel: () => createDiagnosticsChannelBinding(),
  errors: () => createErrorsBinding(),
  fs: (ctx) => createFsBindingFor(ctx),
  fs_dir: (ctx) => createFsDirBinding(createFsBindingFor(ctx)),
  fs_event_wrap: (ctx) => createFsEventWrapBinding(ctx),
  http_parser: () => createHttpParserBinding(),
  locks: () => createLocksBinding(),
  messaging: (ctx) => createMessagingBinding({ loop: ctx.loop, internalBinding: (name) => ctx.internalBinding!(name) }),
  mksnapshot: () => createMksnapshotBinding(),
  options: () => createOptionsBinding(),
  credentials: (ctx) => createCredentialsBinding({ env: () => ctx.process?.env ?? {} }),
  os: (ctx) => createOsBinding({ env: () => ctx.process?.env ?? {} }),
  permission: () => createPermissionBinding(),
  performance: () => createPerformanceBinding(),
  pipe_wrap: (ctx) => createPipeWrapBinding(ctx),
  process_wrap: (ctx) => createProcessWrapBinding(ctx),
  profiler: () => createProfilerBinding(),
  spawn_sync: (ctx) => createSpawnSyncBinding(ctx),
  stream_wrap: (ctx) => createStreamWrapBinding(ctx),
  string_decoder: () => createStringDecoderBinding(),
  tcp_wrap: (ctx) => createTcpWrapBinding(ctx),
  trace_events: () => createTraceEventsBinding(),
  tty_wrap: () => createTtyWrapBinding(),
  symbols: () => createSymbolsBinding(),
  task_queue: (ctx) => createTaskQueueBinding(ctx.loop),
  timers: (ctx) => createTimersBinding(ctx.loop),
  types: () => createTypesBinding(),
  url: () => createUrlBinding(),
  url_pattern: () => createUrlPatternBinding(),
  udp_wrap: (ctx) => createUdpWrapBinding({ loop: ctx.loop, udp: ctx.udp, udpSync: ctx.netSync, requireBuiltin: ctx.requireBuiltin }),
  util: (ctx) => createUtilBinding(ctx),
  uv: () => createUvBinding(),
  worker: (ctx) =>
    createWorkerBinding({
      loop: ctx.loop,
      workerThread: ctx.workerThread,
      messageChannel: ctx.internalBinding!("messaging").MessageChannel,
      isMainThread: ctx.isMainThread ?? true,
      cwd: () => ctx.process?.cwd?.() ?? "/",
      env: () => ctx.process?.env ?? {},
      self: ctx.workerSelf,
      mintThreadId: ctx.mintThreadId,
    }),
  zlib: (ctx) => createZlibBinding(ctx),
};

// One fs binding per realm: fs and fs_dir must share file handles and state.
const fsBindings = new WeakMap<IBindingContext, ReturnType<typeof createFsBinding>>();
const createFsBindingFor = (ctx: IBindingContext) => {
  let binding = fsBindings.get(ctx);
  if (!binding) {
    if (!ctx.fs) {
      throw new WcvmError("ERR_NOT_IMPLEMENTED", "internalBinding('fs') needs a filesystem", {
        code: "ERR_INTERNAL_BINDING_NOT_IMPLEMENTED",
      });
    }
    binding = createFsBinding({
      fs: ctx.fs,
      cwd: () => ctx.process?.cwd?.() ?? "/",
      loop: ctx.loop,
      requireBuiltin: ctx.requireBuiltin,
      writeStdio: ctx.writeStdio ?? (() => {}),
    });
    fsBindings.set(ctx, binding);
  }
  return binding;
};

/**
 * `internalBinding(name)`: where Node's lib/ reaches its C++ core. Each binding
 * is built once, on first use. An unknown name is an error, not a stub: it means
 * a newly vendored module needs a binding written for it.
 */
const createInternalBinding = (ctx: IBindingContext) => {
  const built = new Map<string, object>();
  return (name: string): any => {
    const cached = built.get(name);
    if (cached) return cached;
    const factory = Object.hasOwn(factories, name) ? factories[name] : undefined;
    if (!factory) {
      throw new WcvmError(
        "ERR_NOT_IMPLEMENTED",
        `internalBinding('${name}') is not implemented`,
        { code: "ERR_INTERNAL_BINDING_NOT_IMPLEMENTED" },
      );
    }
    const binding = factory(ctx);
    built.set(name, binding);
    return binding;
  };
};

export { createInternalBinding };
export type { IBindingContext };

import { WcvmError } from "../../errors/WcvmError";
import type { EventLoop } from "../eventLoop";
import { createBufferBinding } from "./buffer";
import { createConstantsBinding } from "./constants";
import { createAsyncWrapBinding, createTaskQueueBinding, createTimersBinding } from "./loop";
import {
  createAsyncContextFrameBinding,
  createConfigBinding,
  createDiagnosticsChannelBinding,
  createErrorsBinding,
  createMessagingBinding,
  createMksnapshotBinding,
  createOptionsBinding,
  createOsBinding,
  createPerformanceBinding,
  createProfilerBinding,
  createStringDecoderBinding,
  createTraceEventsBinding,
  createUvBinding,
} from "./misc";
import { createTypesBinding } from "./types";
import { createSymbolsBinding, createUtilBinding } from "./util";

interface IBindingContext {
  /** For bindings that call back into Node's own modules (defineLazyProperties). */
  requireBuiltin(id: string): any;
  loop: EventLoop;
}

type BindingFactory = (ctx: IBindingContext) => object;

const factories: Record<string, BindingFactory> = {
  async_context_frame: () => createAsyncContextFrameBinding(),
  async_wrap: () => createAsyncWrapBinding(),
  buffer: () => createBufferBinding(),
  config: () => createConfigBinding(),
  constants: () => createConstantsBinding(),
  diagnostics_channel: () => createDiagnosticsChannelBinding(),
  errors: () => createErrorsBinding(),
  messaging: () => createMessagingBinding(),
  mksnapshot: () => createMksnapshotBinding(),
  options: () => createOptionsBinding(),
  os: () => createOsBinding(),
  performance: () => createPerformanceBinding(),
  profiler: () => createProfilerBinding(),
  string_decoder: () => createStringDecoderBinding(),
  trace_events: () => createTraceEventsBinding(),
  symbols: () => createSymbolsBinding(),
  task_queue: (ctx) => createTaskQueueBinding(ctx.loop),
  timers: (ctx) => createTimersBinding(ctx.loop),
  types: () => createTypesBinding(),
  util: (ctx) => createUtilBinding(ctx),
  uv: () => createUvBinding(),
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

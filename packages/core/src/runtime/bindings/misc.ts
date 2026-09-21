import { ENCODINGS } from "./buffer";

// Small bindings, mostly inert: they exist so vendored modules can load and
// query "is this feature on?" without a native core behind them.

export const createErrorsBinding = () => ({
  setPrepareStackTraceCallback: () => {},
  setGetSourceMapErrorSource: () => {},
  setSourceMapsEnabled: () => {},
  setMaybeCacheGeneratedSourceMap: () => {},
  setEnhanceStackForFatalException: () => {},
  noSideEffectsToString: (value: unknown) => String(value),
  triggerUncaughtException: (error: unknown) => {
    throw error;
  },
  exitCodes: {
    kNoFailure: 0,
    kGenericUserError: 1,
    kInternalJSParseError: 3,
    kInternalJSEvaluationFailure: 4,
    kV8FatalError: 5,
    kInvalidFatalExceptionMonkeyPatching: 6,
    kExceptionInFatalExceptionHandler: 7,
    kUnsettledTopLevelAwait: 13,
    kInvalidCommandLineArgument: 9,
    kBootstrapFailure: 10,
    kInvalidCommandLineArgument2: 12,
    kStartupSnapshotFailure: 14,
    kAbort: 134,
  },
});

export const createConfigBinding = () => ({
  hasIntl: false,
  hasSmallICU: false,
  hasInspector: false,
  hasOpenSSL: false,
  hasTracing: false,
  hasNodeOptions: true,
  fipsMode: false,
  noBrowserGlobals: false,
  isDebugBuild: false,
});

export const createStringDecoderBinding = () => ({ encodings: [...ENCODINGS] });

export const createMessagingBinding = () => ({
  DOMException: (globalThis as { DOMException?: unknown }).DOMException,
});

export const createOsBinding = () => ({
  getOSInformation: () => ["Linux", "#1 SMP wcvm", "6.0.0-wcvm", "x86_64"],
});

export const createOptionsBinding = () => ({
  // `getOptionValue(name)` reads from this dictionary; unset options are
  // undefined, which is falsy exactly like an absent CLI flag.
  getCLIOptionsValues: () => ({
    "--pending-deprecation": false,
    "--no-deprecation": false,
    "--trace-deprecation": false,
    "--throw-deprecation": false,
    "--warnings": true,
    "--stack-trace-limit": 10,
    "--disable-warning": [],
    "--redirect-warnings": "",
    "--diagnostic-dir": "",
    "--unhandled-rejections": "",
    "--experimental-require-module": true,
    "--async-context-frame": false,
    "--enable-source-maps": false,
  }),
  getCLIOptionsInfo: () => ({ options: new Map(), aliases: new Map() }),
  getEmbedderOptions: () => ({}),
  getEnvOptionsInputType: () => new Map(),
  getNamespaceOptionsInputType: () => new Map(),
  getOptionsAsFlags: () => [],
});

export const createMksnapshotBinding = () => ({
  setSerializeCallback: () => {},
  setDeserializeCallback: () => {},
  setDeserializeMainFunction: () => {},
  isBuildingSnapshotBuffer: new Uint8Array(1),
});

export const createProfilerBinding = () => ({
  setCoverageDirectory: () => {},
  setSourceMapCacheGetter: () => {},
});

export const createUvBinding = () => ({
  errname: (code: number) => `UV_${Math.abs(code)}`,
  getErrorMap: () => new Map<number, [string, string]>(),
  UV_EOF: -4095,
});

export const createTraceEventsBinding = () => ({
  trace: () => {},
  isTraceCategoryEnabled: () => false,
  setTraceCategoryStateUpdateHandler: () => {},
  getCategoryEnabledBuffer: () => new Uint8Array(1),
  available: false,
});

// milestones[] are nanoseconds on a monotonic clock (-1 = not reached);
// `now()` is milliseconds since the time origin. TIME_ORIGIN is the monotonic
// reading at start, TIME_ORIGIN_TIMESTAMP the wall clock (microseconds).
export const createPerformanceBinding = () => {
  const NODE_PERFORMANCE_MILESTONE_TIME_ORIGIN = 0;
  const NODE_PERFORMANCE_MILESTONE_TIME_ORIGIN_TIMESTAMP = 1;
  const originMs = performance.now();
  const milestones = new Float64Array(8).fill(-1);
  milestones[NODE_PERFORMANCE_MILESTONE_TIME_ORIGIN] = originMs * 1e6;
  milestones[NODE_PERFORMANCE_MILESTONE_TIME_ORIGIN_TIMESTAMP] =
    (performance.timeOrigin + originMs) * 1e3;
  return {
    constants: {
      NODE_PERFORMANCE_MILESTONE_TIME_ORIGIN,
      NODE_PERFORMANCE_MILESTONE_TIME_ORIGIN_TIMESTAMP,
    },
    milestones,
    now: () => performance.now() - originMs,
  };
};

// V8's continuation-preserved embedder data has no JS equivalent; a plain slot
// is enough while `--async-context-frame` is off, since nothing then reads it.
export const createAsyncContextFrameBinding = () => {
  let current: unknown;
  return {
    getContinuationPreservedEmbedderData: () => current,
    setContinuationPreservedEmbedderData: (value: unknown) => {
      current = value;
    },
  };
};

// Native code publishes to diagnostics channels through this; there is no native
// publisher here, so this only hands out a stable index per channel name and
// keeps the subscriber counts the JS side increments and decrements.
export const createDiagnosticsChannelBinding = () => {
  const indexes = new Map<string | symbol, number>();
  return {
    subscribers: new Int32Array(4096),
    getOrCreateChannelIndex: (name: string | symbol) => {
      let index = indexes.get(name);
      if (index === undefined) {
        index = indexes.size;
        indexes.set(name, index);
      }
      return index;
    },
    linkNativeChannel: () => {},
  };
};

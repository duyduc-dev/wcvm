import { UV_ERRORS, uvErrorMap, uvException } from "./uvErrors";

// Small bindings, mostly inert: they exist so vendored modules can load and
// query "is this feature on?" without a native core behind them.

// V8's `v8::Message` (what the C++ binding reads `sourceLine` from) has no JS
// equivalent: `Error.prepareStackTrace` gives real file/line/column per frame,
// but not the literal source text backing it, so `sourceLine` is always empty
// here. assert's "show the failing expression" enrichment degrades to a plain
// message instead of throwing; file/line/column stay accurate.
const getErrorSourcePositions = (error: unknown) => {
  const previous = Error.prepareStackTrace;
  let site: any;
  try {
    Error.prepareStackTrace = (_error, callSites) => callSites;
    site = (error as { stack?: unknown[] })?.stack?.[0] as any;
  } catch {
    site = undefined;
  } finally {
    Error.prepareStackTrace = previous;
  }
  return {
    sourceLine: "",
    scriptResourceName: site?.getFileName?.() ?? site?.getScriptNameOrSourceURL?.() ?? "",
    lineNumber: site?.getLineNumber?.() ?? 0,
    startColumn: Math.max(0, (site?.getColumnNumber?.() ?? 1) - 1),
  };
};

export const createErrorsBinding = () => ({
  setPrepareStackTraceCallback: () => {},
  setGetSourceMapErrorSource: () => {},
  setSourceMapsEnabled: () => {},
  setMaybeCacheGeneratedSourceMap: () => {},
  setEnhanceStackForFatalException: () => {},
  noSideEffectsToString: (value: unknown) => String(value),
  getErrorSourcePositions,
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


export const createMessagingBinding = () => ({
  DOMException: (globalThis as { DOMException?: unknown }).DOMException,
});

export interface IOsContext {
  env: () => Record<string, string | undefined>;
}

// A single-user Linux box called "wcvm". Sizes come from the browser when it says.
export const createOsBinding = (ctx: IOsContext) => {
  const nav = (globalThis as { navigator?: { hardwareConcurrency?: number; deviceMemory?: number } }).navigator;
  const cores = nav?.hardwareConcurrency ?? 1;
  const totalMem = (nav?.deviceMemory ?? 4) * 1024 ** 3;
  return {
    getOSInformation: () => ["Linux", "#1 SMP wcvm", "6.0.0-wcvm", "x86_64"],
    getHostname: () => "wcvm",
    getHomeDirectory: () => ctx.env().HOME ?? "/home/user",
    getAvailableParallelism: () => cores,
    // flat: model, speed, user, nice, sys, idle, irq per cpu
    getCPUs: () => Array.from({ length: cores }, () => ["wcvm virtual cpu", 0, 0, 0, 0, 0, 0]).flat(),
    getFreeMem: () => totalMem / 2,
    getTotalMem: () => totalMem,
    getLoadAvg: (out: Float64Array) => out.fill(0),
    getUptime: () => Math.floor(performance.now() / 1000),
    getInterfaceAddresses: () => ["lo", "127.0.0.1", "255.0.0.0", "IPv4", "00:00:00:00:00:00", true, -1],
    getUserInfo: () => ({ uid: 1000, gid: 1000, username: "user", homedir: ctx.env().HOME ?? "/home/user", shell: "/bin/sh" }),
    getPriority: () => 0,
    setPriority: () => 0,
    isBigEndian: false,
  };
};

export const createCredentialsBinding = (ctx: IOsContext) => ({
  safeGetenv: (name: string) => ctx.env()[name],
  // uv_os_tmpdir: TMPDIR, TMP, TEMP, TEMPDIR, else /tmp; no trailing slash.
  getTempDir: () => {
    const env = ctx.env();
    const dir = env.TMPDIR || env.TMP || env.TEMP || env.TEMPDIR || "/tmp";
    return dir.length > 1 && dir.endsWith("/") ? dir.slice(0, -1) : dir;
  },
  implementsPosixCredentials: true,
  getuid: () => 1000,
  geteuid: () => 1000,
  getgid: () => 1000,
  getegid: () => 1000,
  getgroups: () => [1000],
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

export const createUvBinding = () => {
  const errors = uvErrorMap();
  const constants = Object.fromEntries(UV_ERRORS.map(([name, errno]) => [`UV_${name}`, -errno]));
  return {
    ...constants,
    UV_EOF: -4095,
    errname: (code: number) => errors.get(code)?.[0] ?? `Unknown system error ${code}`,
    getErrorMap: () => errors,
    getErrorMessage: (code: number) => errors.get(code)?.[1] ?? `Unknown system error ${code}`,
  };
};

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

// The permission model is off (`--permission` unset): everything is allowed.
export const createPermissionBinding = () => ({ has: () => true });

const notSupported = (name: string) => () => {
  throw uvException("ENOSYS", name);
};

// net.js and internal/child_process.js destructure this at module load even though
// child_process only needs pipes: real TTY/DNS are still later work (tcp_wrap and udp_wrap are
// real now - see runtime/bindings/net.ts and udp.ts). This class only needs to exist for
// `instanceof` checks; any real use throws.
export const createTtyWrapBinding = () => ({
  TTY: class TTY {},
  isTTY: () => false,
  guessHandleType: () => "UNKNOWN",
});

export const createCaresWrapBinding = () => ({
  convertIpv6StringToBuffer: notSupported("convertIpv6StringToBuffer"),
  GetAddrInfoReqWrap: class GetAddrInfoReqWrap {},
  GetNameInfoReqWrap: class GetNameInfoReqWrap {},
  ChannelWrap: class ChannelWrap {},
});

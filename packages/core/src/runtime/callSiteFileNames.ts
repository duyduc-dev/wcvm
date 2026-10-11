// `Error.prepareStackTrace` call sites, made usable for packages like `get-caller-file`,
// `callsites` and `depd`, which ask a frame for `getFileName()` to learn which module called them.
//
// User code here is compiled with a plain `eval` plus a `//# sourceURL=<file>` comment (cjs.ts's
// `compile`), and V8 reports that name only through `getScriptNameOrSourceURL()` - `getFileName()`
// returns undefined for eval'd scripts, unlike code loaded from a real file in real Node. So
// `path.dirname(getCallerFile())` threw ERR_INVALID_ARG_TYPE and Ember's CLI (which finds its own
// commands that way) died at startup.
//
// Fixed at the one place a guest can observe it: when guest code assigns `Error.prepareStackTrace`,
// its function is stored, and what V8 actually calls is a wrapper that hands it call sites whose
// `getFileName()` falls back to the sourceURL. Assigning nothing changes nothing (the getter
// returns undefined, V8's default formatting stays in effect).

// Declared here (not `ICallSite`) so this file typechecks without `@types/node`.
export interface ICallSite {
  getThis(): unknown;
  getTypeName(): string | null;
  getFunction(): Function | undefined;
  getFunctionName(): string | null;
  getMethodName(): string | null;
  getFileName(): string | undefined;
  getLineNumber(): number | null;
  getColumnNumber(): number | null;
  getEvalOrigin(): string | undefined;
  getScriptNameOrSourceURL(): string;
  isToplevel(): boolean;
  isEval(): boolean;
  isNative(): boolean;
  isConstructor(): boolean;
  toString(): string;
}

// `any[]`: with @types/node present, `Error.prepareStackTrace` is typed against its own, larger CallSite.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type PrepareStackTrace = (error: Error, callSites: any[]) => unknown;

type ErrorConstructorLike = {
  prepareStackTrace?: PrepareStackTrace;
  captureStackTrace?: (target: object, constructorOpt?: Function) => void;
};

// Safari (JavaScriptCore) has `Error.captureStackTrace` but never calls `Error.prepareStackTrace`:
// `obj.stack` stays a string of `fn@file:line:col` lines. depd (Next.js, Express) asks for call
// sites that way and died at load with `callSite.getFileName is not a function`. Detected once by
// asking the engine; only then do we parse the string ourselves.
const engineCallsPrepareStackTrace = (errorConstructor: ErrorConstructorLike): boolean => {
  if (typeof errorConstructor.captureStackTrace !== "function") return true;
  const previous = errorConstructor.prepareStackTrace;
  const marker = {};
  try {
    errorConstructor.prepareStackTrace = () => marker;
    const probe: { stack?: unknown } = {};
    errorConstructor.captureStackTrace(probe);
    return probe.stack === marker;
  } catch {
    return true;
  } finally {
    errorConstructor.prepareStackTrace = previous;
  }
};

// One JavaScriptCore frame (`fn@file:line:col`, `@file:line:col`, `[native code]`) as a call site.
export const parseStackFrame = (line: string): ICallSite => {
  const at = line.indexOf("@");
  const functionName = at > 0 ? line.slice(0, at) : null;
  const location = at >= 0 ? line.slice(at + 1) : line;
  const match = /^(.*?)(?::(\d+))?(?::(\d+))?$/.exec(location);
  const native = location === "[native code]";
  const file = native ? null : match?.[1] || null;
  const lineNumber = match?.[2] ? Number(match[2]) : null;
  const columnNumber = match?.[3] ? Number(match[3]) : null;
  return {
    getThis: () => undefined,
    getTypeName: () => null,
    getFunction: () => undefined,
    getFunctionName: () => functionName,
    getMethodName: () => null,
    getFileName: () => file ?? undefined,
    getLineNumber: () => lineNumber,
    getColumnNumber: () => columnNumber,
    getEvalOrigin: () => undefined,
    getScriptNameOrSourceURL: () => file ?? "",
    isToplevel: () => functionName === null,
    isEval: () => false,
    isNative: () => native,
    isConstructor: () => false,
    toString: () => line,
  };
};

export const installCallSiteFileNames = (errorConstructor: ErrorConstructorLike): void => {
  const polyfill = !engineCallsPrepareStackTrace(errorConstructor);
  const nativeCapture = errorConstructor.captureStackTrace;
  let user = errorConstructor.prepareStackTrace;

  const withFileName = (site: ICallSite): ICallSite =>
    new Proxy(site, {
      get(target, key) {
        if (key === "getFileName") return () => target.getFileName() ?? target.getScriptNameOrSourceURL?.();
        const value = Reflect.get(target, key, target);
        // CallSite methods are brand-checked natively: they need the real object as `this`.
        return typeof value === "function" ? value.bind(target) : value;
      },
    });

  const wrapped: PrepareStackTrace = (error, callSites) => user!(error, callSites.map(withFileName));

  Object.defineProperty(errorConstructor, "prepareStackTrace", {
    configurable: true,
    enumerable: false,
    get: () => (user ? wrapped : undefined),
    set: (value: unknown) => {
      // Code that saves and restores the previous value (get-caller-file does) hands the wrapper
      // straight back: keep what it wraps rather than wrapping the wrapper.
      if (value === wrapped) return;
      user = typeof value === "function" ? (value as PrepareStackTrace) : undefined;
    },
  });

  if (polyfill && nativeCapture) {
    errorConstructor.captureStackTrace = function (this: unknown, target: object, constructorOpt?: Function) {
      nativeCapture.call(this, target, constructorOpt);
      const holder = target as { stack?: unknown };
      if (!user || typeof holder.stack !== "string") return;
      const frames = holder.stack.split("\n").filter((line) => line !== "").map(parseStackFrame);
      holder.stack = user(target as Error, frames) as string;
    };
  }
};

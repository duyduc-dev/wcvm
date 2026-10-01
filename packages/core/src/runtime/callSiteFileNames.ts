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

type PrepareStackTrace = (error: Error, callSites: NodeJS.CallSite[]) => unknown;

export const installCallSiteFileNames = (errorConstructor: { prepareStackTrace?: PrepareStackTrace }): void => {
  let user = errorConstructor.prepareStackTrace;

  const withFileName = (site: NodeJS.CallSite): NodeJS.CallSite =>
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
};

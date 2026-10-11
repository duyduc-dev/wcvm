import { perContextFactories } from "./node/registry";

/**
 * Node's "safe intrinsics" object. Node's own startup builds it by running
 * `lib/internal/per_context/primordials.js` against an empty object; we run that
 * same vendored file, so every name (SafeMap, SafePromiseAll, uncurried
 * prototype methods, ...) is exactly what the vendored `lib/` was written for.
 */
// Safari has no `Symbol.dispose`/`Symbol.asyncDispose`; Node's lib reads them as
// primordials (`SymbolDispose`) and names functions after them, which throws on
// `undefined`. Node itself polyfills the same two well-known symbols.
const ensureDisposeSymbols = (): void => {
  const sym = Symbol as unknown as Record<string, symbol | undefined>;
  for (const name of ["dispose", "asyncDispose"]) {
    if (sym[name] === undefined) {
      Object.defineProperty(Symbol, name, {
        value: Symbol.for(`nodejs.${name}`),
        writable: false,
        enumerable: false,
        configurable: false,
      });
    }
  }
};

const createPrimordials = (): Record<string | symbol, any> => {
  ensureDisposeSymbols();
  const primordials: Record<string | symbol, any> = {};
  perContextFactories["internal/per_context/primordials"](
    {},
    primordials,
    {},
    {},
  );
  return primordials;
};

export { createPrimordials };

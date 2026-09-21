import { perContextFactories } from "./node/registry";

/**
 * Node's "safe intrinsics" object. Node's own startup builds it by running
 * `lib/internal/per_context/primordials.js` against an empty object; we run that
 * same vendored file, so every name (SafeMap, SafePromiseAll, uncurried
 * prototype methods, ...) is exactly what the vendored `lib/` was written for.
 */
const createPrimordials = (): Record<string | symbol, any> => {
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

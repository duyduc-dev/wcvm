import { createInternalBinding } from "./bindings";
import { createBuiltinLoader } from "./loader";
import { createPrimordials } from "./primordials";

/** A loader over the real vendored modules and real bindings, with a minimal process. */
export const createTestLoader = (processOverrides: Record<string, unknown> = {}) => {
  const warnings: unknown[] = [];
  const process = {
    versions: { node: "24.18.0", v8: "0.0" },
    version: "v24.18.0",
    env: {},
    argv: ["node"],
    execArgv: [],
    platform: "linux",
    arch: "x64",
    pid: 1,
    cwd: () => "/",
    emitWarning: (w: unknown) => warnings.push(w),
    nextTick: (fn: (...a: unknown[]) => void, ...args: unknown[]) =>
      queueMicrotask(() => fn(...args)),
    ...processOverrides,
  };
  let loader: ReturnType<typeof createBuiltinLoader>;
  const internalBinding = createInternalBinding({
    requireBuiltin: (id) => loader.requireBuiltin(id),
  });
  loader = createBuiltinLoader({
    process,
    internalBinding,
    primordials: createPrimordials(),
  });
  return { loader, process, warnings, require: loader.requireBuiltin };
};

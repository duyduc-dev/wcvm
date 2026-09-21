import { WcvmError } from "../errors/WcvmError";
import { builtinFactories } from "./node/registry";
import type { BuiltinFactory } from "./node/types";
import { createShims } from "./shims";

type Module = { exports: any; id: string; loaded: boolean };

interface IBuiltinLoaderParams {
  process: any;
  internalBinding: (name: string) => any;
  primordials: Record<string | symbol, any>;
  /** Overrides/additions to the vendored set (tests, hand-written shims). */
  factories?: Record<string, BuiltinFactory>;
}

interface IBuiltinLoader {
  /** Loads any builtin, including `internal/*`; what vendored code itself uses. */
  requireBuiltin(id: string): any;
  /** True for ids user code may `require()`: public, and actually vendored. */
  canBeRequiredByUsers(id: string): boolean;
  has(id: string): boolean;
}

const stripScheme = (id: string) => (id.startsWith("node:") ? id.slice(5) : id);

/**
 * Links vendored Node modules the way Node's own BuiltinModule loader does:
 * each factory gets (exports, require, module, process, internalBinding,
 * primordials), instances are cached, and a require cycle sees the partial
 * `exports` rather than recursing.
 */
const createBuiltinLoader = ({
  process,
  internalBinding,
  primordials,
  factories = {},
}: IBuiltinLoaderParams): IBuiltinLoader => {
  const table: Record<string, BuiltinFactory> = { ...builtinFactories };
  const cache = new Map<string, Module>();

  const requireBuiltin = (rawId: string): any => {
    const id = stripScheme(rawId);
    const cached = cache.get(id);
    if (cached) return cached.exports;

    const factory = table[id];
    if (!factory) {
      // Deliberately loud: a missing builtin means a vendored module needs
      // adding to manifest.json, not a silent fallback.
      throw new WcvmError(
        "ERR_NOT_IMPLEMENTED",
        `Builtin module '${id}' is not vendored yet (add it to runtime/node/manifest.json)`,
        { code: "ERR_UNKNOWN_BUILTIN_MODULE" },
      );
    }

    const module: Module = { exports: {}, id, loaded: false };
    cache.set(id, module);
    try {
      factory(module.exports, requireBuiltin, module, process, internalBinding, primordials);
    } catch (error) {
      cache.delete(id);
      throw error;
    }
    module.loaded = true;
    return module.exports;
  };

  const has = (id: string) => Object.hasOwn(table, stripScheme(id));

  Object.assign(
    table,
    createShims({ has, requireBuiltin, internalBinding }),
    factories,
  );

  return {
    requireBuiltin,
    has,
    canBeRequiredByUsers: (id) => {
      const name = stripScheme(id);
      return !name.startsWith("internal/") && has(name);
    },
  };
};

export { createBuiltinLoader };
export type { IBuiltinLoader };

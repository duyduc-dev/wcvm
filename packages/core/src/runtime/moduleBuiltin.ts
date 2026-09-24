// `require("module")` - hand-written, not vendored: real Node's lib/module.js is a facade over its
// own C++-backed CommonJS loader (internal/modules/cjs/loader), which this runtime replaces
// wholesale with cjs.ts. So this is that same public surface over OUR loader: `createRequire` (what
// ESM code - Vite included - uses to require CJS: `createRequire(import.meta.url)`),
// `builtinModules`, `isBuiltin`, and the `Module` class with the statics code commonly reaches for.
//
// Deliberately absent: `register`/`registerHooks` (module customization hooks - this loader has no
// hook points; tools like Vite check for them and fall back cleanly when they're missing, which is
// better than a stub that pretends to work), `runMain`, `_preloadModules`, `stripTypeScriptTypes`.

import type { createModuleSystem } from "./cjs";

type ModuleSystem = ReturnType<typeof createModuleSystem>;

export interface IModuleBuiltinContext {
  modules(): ModuleSystem;
  requireBuiltin(id: string): any;
  canBeRequiredByUsers(id: string): boolean;
  publicIds(): string[];
  cwd(): string;
}

const WRAPPER = ["(function (exports, require, module, __filename, __dirname) { ", "\n});"];

export const createModuleBuiltin = (ctx: IModuleBuiltinContext) => {
  const { codes } = ctx.requireBuiltin("internal/errors");
  const { fileURLToPath } = ctx.requireBuiltin("internal/url");
  const modules = ctx.modules();

  /** A path or a `file:` URL (string or URL object) - what createRequire accepts, like real Node. */
  const toPath = (filename: unknown): string => {
    if (filename instanceof URL || (typeof filename === "string" && filename.startsWith("file:"))) return fileURLToPath(filename);
    if (typeof filename === "string" && filename.startsWith("/")) return filename;
    throw new codes.ERR_INVALID_ARG_VALUE("filename", filename, "must be a file URL object, file URL string, or absolute path string");
  };

  const builtinModules = Object.freeze(ctx.publicIds());
  const isBuiltin = (id: string) => typeof id === "string" && ctx.canBeRequiredByUsers(id);
  const notSupported = (name: string) => () => {
    throw Object.assign(new Error(`module.${name}() isn't supported by wcvm's CommonJS loader`), { code: "ERR_METHOD_NOT_IMPLEMENTED" });
  };

  // Our own Module class, so `require("module").Module`, `module.constructor` and
  // `m instanceof Module` all agree with what require() actually produces.
  const Module = modules.Module as any;
  Object.assign(Module, {
    Module,
    builtinModules,
    isBuiltin,
    createRequire: (filename: unknown) => modules.createRequire(toPath(filename)),
    _cache: modules.cache,
    _pathCache: Object.create(null),
    _extensions: Object.assign(Object.create(null), { ".js": notSupported("_extensions['.js']"), ".json": notSupported("_extensions['.json']"), ".node": notSupported("_extensions['.node']") }),
    globalPaths: [],
    _nodeModulePaths: (from: string) => modules.nodeModulesPaths(from),
    _resolveFilename: (request: string, parent?: { path?: string } | null) => {
      const resolved = modules.resolve(request, null, parent?.path ?? ctx.cwd());
      return resolved.startsWith("node:") ? resolved.slice(5) : resolved;
    },
    _load: (request: string, parent?: { path?: string } | null) => modules.require(request, parent?.path ?? ctx.cwd()),
    wrap: (script: string) => `${WRAPPER[0]}${script}${WRAPPER[1]}`,
    wrapper: WRAPPER,
    syncBuiltinESMExports: () => {},
    findSourceMap: () => undefined,
    SourceMap: class SourceMap {
      constructor() {
        notSupported("SourceMap")();
      }
    },
    constants: { compileCacheStatus: { FAILED: 0, ENABLED: 1, ALREADY_ENABLED: 2, DISABLED: 3 } },
    enableCompileCache: () => ({ status: 3 }),
    getCompileCacheDir: () => undefined,
    flushCompileCache: () => {},
    getSourceMapsSupport: () => ({ enabled: false, nodeModules: false, generatedCode: false }),
    setSourceMapsSupport: () => {},
  });
  return Module;
};

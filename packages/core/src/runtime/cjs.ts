// CommonJS loader for user code (the `node script.js` half of a runtime).
//
// Everything is synchronous, because the fs under it is: `require()` blocks on
// the SharedArrayBuffer bridge like any other syscall. Resolution follows the
// Node docs' algorithm: builtins, relative/absolute paths (file, then
// directory), then node_modules up the tree, with package.json `main` and
// `exports` (string, conditions, subpath maps and `*` patterns).

import type { IFsClient } from "../fs/fsClient";
import { EXPORTS_PARAM, IMPORT_SYNC_BRIDGE } from "./esm/syncRequire";

export interface ICjsParams {
  fs: IFsClient;
  path: { resolve(...p: string[]): string; dirname(p: string): string; join(...p: string[]): string; extname(p: string): string; sep: string };
  builtins: { canBeRequiredByUsers(id: string): boolean; requireBuiltin(id: string): any };
  process: any;
  /** Node globals to shadow inside module scope (setTimeout, Buffer, console, ...). */
  globals: Record<string, unknown>;
  /** Extra condition names besides node/require/default. */
  conditions?: string[];
  /** Rewrites a module's `import(...)` calls so they resolve from `selfPath` (runtime/esm/
   *  loader.ts's rewriteScript); only ever called for source that might contain one. */
  rewriteDynamicImports?: (source: string, selfPath: string) => string;
  /** Synchronous `require(esm)` (see runtime/esm/syncRequire.ts). Without it, requiring an ES
   *  module fails with a SyntaxError, as it did before this existed. */
  esmSync?: {
    /** Extension + nearest package.json "type", the same rule `import` uses. */
    formatOfPath(path: string): "esm" | "cjs" | "json" | "builtin";
    /** An ESM `import` specifier resolved with the "import" conditions (not "require"). */
    resolveImport(specifier: string, referrerDir: string): { format: "esm" | "cjs" | "json" | "builtin"; key: string };
    /** ES module source -> a function body (see rewriteEsmForSyncRequire). */
    transform(source: string, filename: string): string;
  };
}

class Module {
  id: string;
  filename: string;
  path: string;
  exports: any = {};
  loaded = false;
  children: Module[] = [];
  parent: Module | null;
  paths: string[] = [];
  require!: (id: string) => any;
  /** Compiles and runs `content` as this module (installed per module - see `loadResolved`). Real
   *  extension handlers call it, and tools like Next's config loader wrap it to transpile first. */
  _compile!: (content: string, filename: string) => void;

  constructor(filename: string, parent: Module | null) {
    this.id = filename;
    this.filename = filename;
    this.path = filename.slice(0, filename.lastIndexOf("/")) || "/";
    this.parent = parent;
  }
}

const codedError = (code: string, message: string, extra: object = {}) =>
  Object.assign(new Error(message), { code }, extra);


// A cheap pre-check, so the parser only ever runs for source that might contain an import():
// false positives (in a string or comment) just cost a parse that finds nothing to rewrite.
const MIGHT_IMPORT = /\bimport\s*\(/;

const createModuleSystem = ({ fs, path, builtins, process, globals, conditions = [], rewriteDynamicImports, esmSync }: ICjsParams) => {
  const cache: Record<string, Module> = Object.create(null);
  const conditionSet = new Set(["node", "require", "module-sync", "default", ...conditions]);
  const decoder = new TextDecoder();
  const packageCache = new Map<string, any | null>();

  const kindOf = (p: string): "file" | "dir" | null => {
    try {
      const kind = fs.stat(p).kind;
      return kind === "file" || kind === "dir" ? kind : null;
    } catch {
      return null;
    }
  };
  const isFile = (p: string) => kindOf(p) === "file";
  const isDir = (p: string) => kindOf(p) === "dir";

  const readPackage = (dir: string): any | null => {
    const file = `${dir === "/" ? "" : dir}/package.json`;
    if (packageCache.has(file)) return packageCache.get(file);
    let pkg: any = null;
    if (isFile(file)) {
      try {
        pkg = JSON.parse(decoder.decode(fs.readFile(file)));
      } catch (error) {
        throw codedError("ERR_INVALID_PACKAGE_CONFIG", `Invalid package config ${file}: ${(error as Error).message}`);
      }
    }
    packageCache.set(file, pkg);
    return pkg;
  };

  // ---- resolution ------------------------------------------------------------

  // `require.extensions` / `Module._extensions`: extension -> `(module, filename) => void`. Real Node's
  // own table, and the hook transpiler registrations (ts-node, @babel/register, esbuild-register,
  // Next's next.config.ts loader) have always used: a handler is added for `.ts` and `require()`
  // then resolves and loads such files through it. `.node` is listed but cannot load (no dlopen).
  const extensions: Record<string, (module: Module, filename: string) => void> = Object.create(null);
  /** What a bare `require("./x")` tries, in order: every registered extension that can hold source. */
  const resolvableExtensions = () => Object.keys(extensions).filter((ext) => ext !== ".node");
  /** Node's findLongestRegisteredExtension: `a.test.ts` -> `.test.ts` if registered, else `.ts`, else `.js`. */
  const registeredExtension = (filename: string): string => {
    const name = filename.slice(filename.lastIndexOf("/") + 1);
    for (let index = name.indexOf("."); index !== -1; index = name.indexOf(".", index + 1)) {
      if (index === 0) continue;
      const candidate = name.slice(index);
      if (extensions[candidate]) return candidate;
    }
    return ".js";
  };

  const loadAsFile = (p: string): string | null => {
    if (isFile(p)) return p;
    for (const ext of resolvableExtensions()) if (isFile(p + ext)) return p + ext;
    return null;
  };

  const loadIndex = (p: string): string | null => {
    for (const ext of resolvableExtensions()) {
      const candidate = `${p === "/" ? "" : p}/index${ext}`;
      if (isFile(candidate)) return candidate;
    }
    return null;
  };

  const loadAsDirectory = (p: string): string | null => {
    const pkg = readPackage(p);
    if (pkg && typeof pkg.main === "string" && pkg.main) {
      const main = path.resolve(p, pkg.main);
      const found = loadAsFile(main) ?? loadIndex(main);
      if (found) return found;
    }
    return loadIndex(p);
  };

  /** `resolveBare` is only passed for "imports" (`#x`), whose targets may name another package -
   *  see esm/resolve.ts's resolveExportsTarget for the same rule. */
  const resolveTarget = (
    target: any,
    pkgDir: string,
    match: string,
    isPattern: boolean,
    request: string,
    resolveBare?: (specifier: string) => string,
  ): string | null | undefined => {
    if (typeof target === "string") {
      const substituted = isPattern ? target.replaceAll("*", match) : target;
      if (target.startsWith("./")) return path.resolve(pkgDir, substituted);
      if (resolveBare && !target.startsWith("../") && !target.startsWith("/") && !/^[a-z][a-z0-9+.-]*:/i.test(target)) return resolveBare(substituted);
      throw codedError("ERR_INVALID_PACKAGE_TARGET", `Invalid "${resolveBare ? "imports" : "exports"}" target "${target}" in ${pkgDir}/package.json`);
    }
    if (Array.isArray(target)) {
      for (const item of target) {
        const resolved = resolveTarget(item, pkgDir, match, isPattern, request, resolveBare);
        if (resolved !== undefined) return resolved;
      }
      return undefined;
    }
    if (target && typeof target === "object") {
      for (const [key, value] of Object.entries(target)) {
        if (conditionSet.has(key)) {
          const resolved = resolveTarget(value, pkgDir, match, isPattern, request, resolveBare);
          if (resolved !== undefined) return resolved;
        }
      }
      return undefined;
    }
    return target === null ? null : undefined;
  };

  /** An exact key, else the longest-prefix "*" pattern that matches - shared by "exports" and "imports". */
  const matchSubpathMap = (map: Record<string, any>, key: string): { target: any; match: string; isPattern: boolean } | undefined => {
    if (Object.hasOwn(map, key) && !key.includes("*")) return { target: map[key], match: "", isPattern: false };
    let best: { key: string; match: string } | null = null;
    for (const candidate of Object.keys(map)) {
      const star = candidate.indexOf("*");
      if (star === -1) continue;
      const prefix = candidate.slice(0, star);
      const suffix = candidate.slice(star + 1);
      if (key.startsWith(prefix) && key.length >= candidate.length && key.endsWith(suffix)) {
        // Node's PATTERN_KEY_COMPARE: the longer prefix wins; on a tie, the longer whole key
        // (`"./src/*.js"` beats `"./src/*"`, as @embroider/macros' own exports map relies on).
        const bestPrefix = best ? best.key.indexOf("*") : -1;
        if (!best || prefix.length > bestPrefix || (prefix.length === bestPrefix && candidate.length > best.key.length)) best = { key: candidate, match: key.slice(prefix.length, key.length - suffix.length) };
      }
    }
    return best ? { target: map[best.key], match: best.match, isPattern: true } : undefined;
  };

  /** `require("#x")`: the nearest package.json's "imports" field (Node's PACKAGE_IMPORTS_RESOLVE). */
  const resolvePackageImports = (request: string, parent: Module | null, fromDir: string): string => {
    const notDefined = (where: string) =>
      codedError("ERR_PACKAGE_IMPORT_NOT_DEFINED", `Package import specifier "${request}" is not defined${where} imported from ${parent?.filename ?? fromDir}`);
    if (request === "#" || request.startsWith("#/")) throw notDefined("");
    for (let dir = fromDir; ; dir = path.dirname(dir)) {
      if (isFile(`${dir === "/" ? "" : dir}/package.json`)) {
        const imports = readPackage(dir)?.imports;
        const found = imports && typeof imports === "object" && !Array.isArray(imports) ? matchSubpathMap(imports, request) : undefined;
        const resolved = found ? resolveTarget(found.target, dir, found.match, found.isPattern, request, (bare) => resolve(bare, parent, dir)) : undefined;
        if (!resolved) throw notDefined(` in package ${dir === "/" ? "" : dir}/package.json`);
        if (resolved.startsWith("node:") || isFile(resolved)) return resolved.startsWith("node:") ? resolved : realpath(resolved);
        throw notFound(request, parent);
      }
      if (dir === "/") throw notDefined("");
    }
  };

  const resolveExports = (pkgDir: string, exportsField: any, subpath: string, request: string): string => {
    let map: Record<string, any>;
    const isConditionsOnly =
      typeof exportsField === "string" ||
      Array.isArray(exportsField) ||
      (exportsField && typeof exportsField === "object" && !Object.keys(exportsField).some((k) => k.startsWith(".")));
    map = isConditionsOnly ? { ".": exportsField } : exportsField;

    const notExported = () =>
      codedError(
        "ERR_PACKAGE_PATH_NOT_EXPORTED",
        subpath === "."
          ? `No "exports" main defined in ${pkgDir}/package.json`
          : `Package subpath '${subpath}' is not defined by "exports" in ${pkgDir}/package.json`,
      );

    const found = matchSubpathMap(map, subpath);
    const resolved = found ? resolveTarget(found.target, pkgDir, found.match, found.isPattern, request) : undefined;
    if (!resolved) throw notExported();
    return resolved;
  };

  const splitPackageRequest = (request: string): { name: string; subpath: string } => {
    const parts = request.split("/");
    const nameLength = request.startsWith("@") ? 2 : 1;
    return {
      name: parts.slice(0, nameLength).join("/"),
      subpath: parts.length > nameLength ? `./${parts.slice(nameLength).join("/")}` : ".",
    };
  };

  const nodeModulesPaths = (from: string): string[] => {
    const out: string[] = [];
    let dir = from;
    for (;;) {
      if (!dir.endsWith("/node_modules")) out.push(`${dir === "/" ? "" : dir}/node_modules`);
      if (dir === "/") break;
      dir = path.dirname(dir);
    }
    return out;
  };

  const notFound = (request: string, parent: Module | null) => {
    const stack: string[] = [];
    for (let m: Module | null = parent; m; m = m.parent) stack.push(m.filename);
    return codedError(
      "MODULE_NOT_FOUND",
      `Cannot find module '${request}'` + (stack.length ? `\nRequire stack:\n- ${stack.join("\n- ")}` : ""),
      { requireStack: stack },
    );
  };

  /** Returns a filesystem path, or `node:<id>` for a builtin. */
  function resolve(request: string, parent: Module | null, fromDir: string): string {
    if (request.startsWith("#")) return resolvePackageImports(request, parent, fromDir);
    if (request.startsWith("node:")) {
      if (builtins.canBeRequiredByUsers(request)) return request;
      throw codedError("ERR_UNKNOWN_BUILTIN_MODULE", `No such built-in module: ${request}`);
    }
    if (builtins.canBeRequiredByUsers(request)) return `node:${request}`;

    const relative = request === "." || request === ".." || /^\.\.?\//.test(request) || request.startsWith("/");
    if (relative) {
      const absolute = path.resolve(fromDir, request);
      const trailingSlash = request.endsWith("/") || request === "." || request === "..";
      const found = trailingSlash
        ? loadAsDirectory(absolute)
        : (loadAsFile(absolute) ?? (isDir(absolute) ? loadAsDirectory(absolute) : null));
      if (found) return realpath(found);
      throw notFound(request, parent);
    }

    const { name, subpath } = splitPackageRequest(request);
    for (const nm of nodeModulesPaths(fromDir)) {
      const pkgDir = `${nm}/${name}`;
      if (!isDir(pkgDir)) continue;
      const pkg = readPackage(pkgDir);
      if (pkg && pkg.exports != null) {
        const target = resolveExports(pkgDir, pkg.exports, subpath, request);
        if (isFile(target)) return realpath(target);
        throw notFound(request, parent);
      }
      const full = subpath === "." ? pkgDir : `${pkgDir}/${subpath.slice(2)}`;
      const found = subpath === "." ? loadAsDirectory(full) : (loadAsFile(full) ?? (isDir(full) ? loadAsDirectory(full) : null));
      if (found) return realpath(found);
    }
    throw notFound(request, parent);
  }

  const realpath = (p: string): string => {
    try {
      return fs.realpath(p);
    } catch {
      return p;
    }
  };

  // ---- loading ---------------------------------------------------------------

  const globalNames = Object.keys(globals);
  const globalValues = globalNames.map((name) => globals[name]);

  const compile = (source: string, filename: string, selfPath = filename) => {
    const rewritten = rewriteDynamicImports && MIGHT_IMPORT.test(source) ? rewriteDynamicImports(source, selfPath) : source;
    const body = rewritten.startsWith("#!") ? `//${rewritten}` : rewritten;
    // The trailing sourceURL keeps stack traces pointing at the real filename.
    const wrapper = `(function (exports, require, module, __filename, __dirname, ${globalNames.join(", ")}) {${body}\n})\n//# sourceURL=${filename}`;
    return (0, eval)(wrapper) as (...args: unknown[]) => void;
  };

  const makeRequire = (module: Module) => {
    const req = (request: string) => load(request, module);
    req.resolve = (request: string) => {
      const resolved = resolve(request, module, module.path);
      return resolved.startsWith("node:") ? resolved.slice(5) : resolved;
    };
    req.cache = cache;
    req.main = mainModule;
    req.extensions = extensions;
    return req;
  };

  let mainModule: Module | undefined;

  // What V8 reports when a CommonJS-compiled file turns out to be an ES module. Node 24 does the
  // same "syntax detection" for a `.js` file with no package.json "type" to go by.
  const ESM_SYNTAX_ERROR = /Cannot use import statement outside a module|Unexpected token 'export'|Cannot use 'import\.meta' outside a module/;

  /** What `import x, { a } from "cjs-or-builtin"` sees: the whole value as `default`, plus a
   *  snapshot of its own enumerable keys as named exports (real Node derives those statically). */
  const namespaceOf = (value: any) => {
    const ns: Record<string | symbol, unknown> = Object.create(null);
    if (value !== null && (typeof value === "object" || typeof value === "function")) {
      for (const key of Object.keys(value)) {
        if (key === "default") continue;
        try {
          ns[key] = value[key];
        } catch {
          // a lazy getter this sandbox can't satisfy: leave the name out rather than fail them all
        }
      }
    }
    ns.default = value;
    Object.defineProperty(ns, Symbol.toStringTag, { value: "Module" });
    return ns;
  };

  const compileEsm = (source: string, filename: string) => {
    const body = esmSync!.transform(source, filename);
    const wrapper = `(function (${EXPORTS_PARAM}, ${IMPORT_SYNC_BRIDGE}${globalNames.length ? ", " : ""}${globalNames.join(", ")}) {"use strict";${body}\n})\n//# sourceURL=${filename}`;
    try {
      return (0, eval)(wrapper) as (...args: unknown[]) => void;
    } catch (error) {
      if (error instanceof SyntaxError && /\bawait\b/.test(error.message)) {
        throw codedError("ERR_REQUIRE_ASYNC_MODULE", `require() cannot be used on an ESM graph with top-level await: ${filename}`);
      }
      throw error;
    }
  };

  /** Runs `source` as an ES module, synchronously: `module.exports` becomes its namespace object. */
  const runEsm = (module: Module, source: string, resolved: string, fn = compileEsm(source, resolved)) => {
    const ns = Object.create(null);
    Object.defineProperty(ns, Symbol.toStringTag, { value: "Module" });
    module.exports = ns; // installed before evaluating, so a circular import sees the live getters
    const importSync = (specifier: string) => {
      const target = esmSync!.resolveImport(specifier, module.path);
      if (target.format !== "builtin" && !isFile(target.key)) {
        throw codedError("ERR_MODULE_NOT_FOUND", `Cannot find module '${target.key}' imported from ${module.filename} (specifier '${specifier}')`);
      }
      switch (target.format) {
        case "builtin":
          return namespaceOf(builtins.requireBuiltin(`node:${target.key}`));
        case "esm":
          return loadResolved(target.key, module);
        case "json":
          return namespaceOf(loadResolved(target.key, module));
        default:
          return namespaceOf(loadResolved(target.key, module));
      }
    };
    fn.call(undefined, ns, importSync, ...globalValues);
  };

  const load = (request: string, parent: Module | null): any => {
    const resolved = resolve(request, parent, parent ? parent.path : process.cwd());
    if (resolved.startsWith("node:")) return builtins.requireBuiltin(resolved);
    return loadResolved(resolved, parent);
  };

  /** The default `.js` handler's second half: run `source` as this module - an ES module (by its
   *  format), CommonJS, or CommonJS that turns out to be ESM (Node's syntax detection). */
  const compileModule = (module: Module, source: string, resolved: string): void => {
    if (esmSync && esmSync.formatOfPath(resolved) === "esm") {
      runEsm(module, source, resolved);
      return;
    }
    // Compile first, run second: only a SyntaxError from compiling can mean "this was really an ES
    // module" - one thrown while RUNNING it came from a dependency, and retrying would execute the
    // module twice.
    let fn: (...args: unknown[]) => void;
    try {
      fn = compile(source, resolved);
    } catch (error) {
      if (esmSync && error instanceof SyntaxError && ESM_SYNTAX_ERROR.test(error.message)) {
        runEsm(module, source, resolved);
        return;
      }
      throw error;
    }
    fn.call(module.exports, module.exports, makeRequire(module), module, resolved, module.path, ...globalValues);
  };

  extensions[".js"] = (module, filename) => {
    module._compile(decoder.decode(fs.readFile(filename)), filename);
  };
  extensions[".json"] = (module, filename) => {
    try {
      module.exports = JSON.parse(decoder.decode(fs.readFile(filename)).replace(/^﻿/, ""));
    } catch (error) {
      (error as Error).message = `${filename}: ${(error as Error).message}`;
      throw error;
    }
  };
  extensions[".node"] = (_module, filename) => {
    throw codedError("ERR_DLOPEN_FAILED", `Cannot load native addon '${filename}': there is no dlopen in a browser`);
  };

  const loadResolved = (resolved: string, parent: Module | null): any => {

    const existing = cache[resolved];
    if (existing) {
      if (parent && !parent.children.includes(existing)) parent.children.push(existing);
      return existing.exports;
    }

    const module = new Module(resolved, parent);
    module.paths = nodeModulesPaths(module.path);
    module.require = (id) => load(id, module);
    cache[resolved] = module;
    parent?.children.push(module);
    if (!mainModule && !parent) mainModule = module;

    module._compile = (content, filename) => compileModule(module, content, filename);
    try {
      const handler = extensions[registeredExtension(resolved)];
      handler(module, resolved);
    } catch (error) {
      delete cache[resolved];
      parent?.children.splice(parent.children.indexOf(module), 1);
      throw error;
    }
    module.loaded = true;
    return module.exports;
  };

  return {
    cache,
    /** Runs `entry` as the main module. `entry` may be relative to the cwd. */
    runMain: (entry: string) => {
      const absolute = path.resolve(process.cwd(), entry);
      const resolved = resolve(absolute, null, process.cwd());
      mainModule = undefined;
      load(resolved, null);
    },
    /** Runs source text as `[eval]` (node -e): module scope, cwd-relative require. */
    runEval: (source: string) => {
      const dir = process.cwd();
      const filename = `${dir === "/" ? "" : dir}/[eval]`;
      const module = new Module(filename, null);
      module.filename = "[eval]";
      module.id = "[eval]";
      module.paths = nodeModulesPaths(dir);
      module.require = (id) => load(id, module);
      mainModule = module;
      compile(source, "[eval]", filename).call(
        module.exports,
        module.exports,
        makeRequire(module),
        module,
        "[eval]",
        dir,
        ...globalValues,
      );
      module.loaded = true;
    },
    require: (request: string, fromDir = process.cwd()) => {
      const anchor = new Module(`${fromDir === "/" ? "" : fromDir}/[eval]`, null);
      return load(request, anchor);
    },
    /** `module.createRequire(filename)`: a require() that resolves as if called from `filename`
     *  (an absolute path; one ending in `/` means "from inside this directory"). */
    createRequire: (filename: string) => {
      const module = new Module(filename.endsWith("/") ? `${filename}[createRequire]` : filename, null);
      module.paths = nodeModulesPaths(module.path);
      module.require = (id) => load(id, module);
      return makeRequire(module);
    },
    nodeModulesPaths,
    resolve,
    extensions,
    Module,
  };
};

export { Module, createModuleSystem };

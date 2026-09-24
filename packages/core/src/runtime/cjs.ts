// CommonJS loader for user code (the `node script.js` half of a runtime).
//
// Everything is synchronous, because the fs under it is: `require()` blocks on
// the SharedArrayBuffer bridge like any other syscall. Resolution follows the
// Node docs' algorithm: builtins, relative/absolute paths (file, then
// directory), then node_modules up the tree, with package.json `main` and
// `exports` (string, conditions, subpath maps and `*` patterns).

import type { IFsClient } from "../fs/fsClient";

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

  constructor(filename: string, parent: Module | null) {
    this.id = filename;
    this.filename = filename;
    this.path = filename.slice(0, filename.lastIndexOf("/")) || "/";
    this.parent = parent;
  }
}

const codedError = (code: string, message: string, extra: object = {}) =>
  Object.assign(new Error(message), { code }, extra);

const MODULE_EXTENSIONS = [".js", ".json"];

// A cheap pre-check, so the parser only ever runs for source that might contain an import():
// false positives (in a string or comment) just cost a parse that finds nothing to rewrite.
const MIGHT_IMPORT = /\bimport\s*\(/;

const createModuleSystem = ({ fs, path, builtins, process, globals, conditions = [], rewriteDynamicImports }: ICjsParams) => {
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

  const loadAsFile = (p: string): string | null => {
    if (isFile(p)) return p;
    for (const ext of MODULE_EXTENSIONS) if (isFile(p + ext)) return p + ext;
    return null;
  };

  const loadIndex = (p: string): string | null => {
    for (const ext of MODULE_EXTENSIONS) {
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
        if (!best || prefix.length > best.key.indexOf("*")) best = { key: candidate, match: key.slice(prefix.length, key.length - suffix.length) };
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
    return req;
  };

  let mainModule: Module | undefined;

  const load = (request: string, parent: Module | null): any => {
    const resolved = resolve(request, parent, parent ? parent.path : process.cwd());
    if (resolved.startsWith("node:")) return builtins.requireBuiltin(resolved);

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

    try {
      const source = decoder.decode(fs.readFile(resolved));
      if (resolved.endsWith(".json")) {
        try {
          module.exports = JSON.parse(source.replace(/^﻿/, ""));
        } catch (error) {
          (error as Error).message = `${resolved}: ${(error as Error).message}`;
          throw error;
        }
      } else {
        compile(source, resolved).call(
          module.exports,
          module.exports,
          makeRequire(module),
          module,
          resolved,
          module.path,
          ...globalValues,
        );
      }
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
    Module,
  };
};

export { Module, createModuleSystem };

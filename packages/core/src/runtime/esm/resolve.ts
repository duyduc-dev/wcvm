// ESM specifier resolution: deliberately simpler than cjs.ts's (own copy, not
// shared - the algorithms genuinely differ). No extension guessing and no
// directory/index fallback for relative specifiers, matching real Node ESM's
// defaults; package.json "exports" (with "import"/"node"/"default"
// conditions) for bare specifiers, falling back to "main" only when a
// package has no "exports" field at all.

import type { IFsClient } from "../../fs/fsClient";

export type EsmFormat = "esm" | "cjs" | "json" | "builtin";

export interface IResolvedModule {
  format: EsmFormat;
  /** An absolute VFS path for esm/cjs/json; a builtin id (no "node:") for "builtin". */
  key: string;
}

export interface IEsmResolveContext {
  fs: IFsClient;
  path: { resolve(...p: string[]): string; dirname(p: string): string };
  builtins: { canBeRequiredByUsers(id: string): boolean };
}

class EsmResolveError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = "EsmResolveError";
    this.code = code;
  }
}

const isRelative = (specifier: string) => specifier === "." || specifier === ".." || /^\.\.?\//.test(specifier) || specifier.startsWith("/");

const CONDITIONS = new Set(["import", "node", "default"]);

export interface IEsmResolver {
  resolveEsmSpecifier(specifier: string, referrerDir: string): IResolvedModule;
  /** Format of an already-resolved absolute path (e.g. the `node` entry file itself). */
  formatOfPath(path: string): EsmFormat;
}

/** One resolver per runtime instance: its package.json caches must not leak across separate `node` runs (each gets a fresh worker in production; tests share a realm). */
export const createEsmResolver = (ctx: IEsmResolveContext): IEsmResolver => {
  const packageTypeCache = new Map<string, "module" | "commonjs">();
  const packageJsonCache = new Map<string, unknown>();

  const isFile = (path: string): boolean => {
    try {
      return ctx.fs.stat(path).kind === "file";
    } catch {
      return false;
    }
  };
  const isDir = (path: string): boolean => {
    try {
      return ctx.fs.stat(path).kind === "dir";
    } catch {
      return false;
    }
  };

  const readJson = (path: string): any | undefined => {
    if (packageJsonCache.has(path)) return packageJsonCache.get(path);
    let value: unknown;
    if (isFile(path)) {
      try {
        value = JSON.parse(new TextDecoder().decode(ctx.fs.readFile(path)));
      } catch (error) {
        throw new EsmResolveError("ERR_INVALID_PACKAGE_CONFIG", `Invalid package config ${path}: ${(error as Error).message}`);
      }
    }
    packageJsonCache.set(path, value);
    return value;
  };

  const nearestPackageType = (fromPath: string): "module" | "commonjs" => {
    let dir = ctx.path.dirname(fromPath);
    for (;;) {
      const cached = packageTypeCache.get(dir);
      if (cached) return cached;
      const pkg = readJson(`${dir === "/" ? "" : dir}/package.json`);
      if (pkg !== undefined) {
        const type = (pkg as { type?: string }).type === "module" ? "module" : "commonjs";
        packageTypeCache.set(dir, type);
        return type;
      }
      if (dir === "/") {
        packageTypeCache.set(dir, "commonjs");
        return "commonjs";
      }
      dir = ctx.path.dirname(dir);
    }
  };

  const formatOf = (path: string): EsmFormat => {
    if (path.endsWith(".mjs")) return "esm";
    if (path.endsWith(".cjs")) return "cjs";
    if (path.endsWith(".json")) return "json";
    // A bare/extensionless resolution (from an "exports"/"main" target) or a
    // plain .js file: consult the nearest package.json's "type" field.
    return nearestPackageType(path) === "module" ? "esm" : "cjs";
  };

  /**
   * Same shape/precedence rules as cjs.ts's own (string | conditions | subpath map | "*" pattern),
   * for the "import" condition set. `resolveBare` is only passed for "imports" (`#x`): unlike an
   * "exports" target, an imports target may name another package (`"#dep": "some-pkg"`), which
   * resolves like any bare specifier - to a path, or `node:<id>` for a builtin.
   */
  const resolveExportsTarget = (
    target: unknown,
    pkgDir: string,
    match: string,
    isPattern: boolean,
    resolveBare?: (specifier: string) => string,
  ): string | null | undefined => {
    if (typeof target === "string") {
      const substituted = isPattern ? target.replaceAll("*", match) : target;
      if (target.startsWith("./")) return ctx.path.resolve(pkgDir, substituted);
      if (resolveBare && !target.startsWith("../") && !target.startsWith("/") && !/^[a-z][a-z0-9+.-]*:/i.test(target)) return resolveBare(substituted);
      throw new EsmResolveError("ERR_INVALID_PACKAGE_TARGET", `Invalid "${resolveBare ? "imports" : "exports"}" target "${target}" in ${pkgDir}/package.json`);
    }
    if (Array.isArray(target)) {
      for (const item of target) {
        const resolved = resolveExportsTarget(item, pkgDir, match, isPattern, resolveBare);
        if (resolved !== undefined) return resolved;
      }
      return undefined;
    }
    if (target && typeof target === "object") {
      for (const [key, value] of Object.entries(target)) {
        if (CONDITIONS.has(key)) {
          const resolved = resolveExportsTarget(value, pkgDir, match, isPattern, resolveBare);
          if (resolved !== undefined) return resolved;
        }
      }
      return undefined;
    }
    return target === null ? null : undefined;
  };

  /** An exact key, else the longest-prefix "*" pattern that matches - shared by "exports" and "imports". */
  const matchSubpathMap = (map: Record<string, unknown>, key: string): { target: unknown; match: string; isPattern: boolean } | undefined => {
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

  /**
   * An absolute `file:` URL (`import(pathToFileURL(p).href)` - how Vite loads the config file it
   * just bundled). A `?query`/`#hash` makes a separate module instance, as in real Node (tools
   * append `?t=<timestamp>` to re-import a changed file fresh), so it stays in the key - after a
   * NUL, which no real path contains; see modulePath() for getting the file back out.
   */
  const resolveFileUrl = (specifier: string, referrerDir: string): IResolvedModule => {
    let url: URL;
    try {
      url = new URL(specifier);
    } catch {
      throw new EsmResolveError("ERR_INVALID_URL", `Invalid URL: ${specifier}`);
    }
    if (url.hostname !== "" && url.hostname !== "localhost") {
      throw new EsmResolveError("ERR_INVALID_FILE_URL_HOST", `File URL host must be "localhost" or empty on linux: ${specifier}`);
    }
    const path = decodeURIComponent(url.pathname);
    if (!isFile(path)) throw new EsmResolveError("ERR_MODULE_NOT_FOUND", `Cannot find module '${path}' imported from ${referrerDir}`);
    const suffix = url.search + url.hash;
    return { format: formatOf(path), key: suffix ? `${path}\0${suffix}` : path };
  };

  /** `#x`: the nearest package.json's "imports" field (Node's PACKAGE_IMPORTS_RESOLVE). */
  const resolvePackageImports = (specifier: string, referrerDir: string): IResolvedModule => {
    const notDefined = (where: string) =>
      new EsmResolveError("ERR_PACKAGE_IMPORT_NOT_DEFINED", `Package import specifier "${specifier}" is not defined${where} imported from ${referrerDir}`);
    if (specifier === "#" || specifier.startsWith("#/")) throw notDefined("");
    for (let dir = referrerDir; ; dir = ctx.path.dirname(dir)) {
      const pkgPath = `${dir === "/" ? "" : dir}/package.json`;
      const pkg = readJson(pkgPath);
      if (pkg !== undefined) {
        const imports = (pkg as { imports?: unknown }).imports;
        const found = imports && typeof imports === "object" && !Array.isArray(imports) ? matchSubpathMap(imports as Record<string, unknown>, specifier) : undefined;
        const resolved = found
          ? resolveExportsTarget(found.target, dir, found.match, found.isPattern, (bare) => {
              const target = resolveEsmSpecifier(bare, dir);
              return target.format === "builtin" ? `node:${target.key}` : target.key;
            })
          : undefined;
        if (!resolved) throw notDefined(` in package ${pkgPath}`);
        if (resolved.startsWith("node:")) return { format: "builtin", key: resolved.slice(5) };
        if (!isFile(resolved)) throw new EsmResolveError("ERR_MODULE_NOT_FOUND", `Cannot find module '${resolved}' imported from ${referrerDir}`);
        return { format: formatOf(resolved), key: resolved };
      }
      if (dir === "/") throw notDefined("");
    }
  };

  const resolveExports = (pkgDir: string, exportsField: unknown, subpath: string): string => {
    const isConditionsOnly =
      typeof exportsField === "string" || Array.isArray(exportsField) || (exportsField && typeof exportsField === "object" && !Object.keys(exportsField).some((k) => k.startsWith(".")));
    const map: Record<string, unknown> = isConditionsOnly ? { ".": exportsField } : (exportsField as Record<string, unknown>);

    const notExported = () =>
      new EsmResolveError(
        "ERR_PACKAGE_PATH_NOT_EXPORTED",
        subpath === "." ? `No "exports" main defined in ${pkgDir}/package.json` : `Package subpath '${subpath}' is not defined by "exports" in ${pkgDir}/package.json`,
      );

    const found = matchSubpathMap(map, subpath);
    const resolved = found ? resolveExportsTarget(found.target, pkgDir, found.match, found.isPattern) : undefined;
    if (!resolved) throw notExported();
    return resolved;
  };

  const splitPackageRequest = (specifier: string): { name: string; subpath: string } => {
    const parts = specifier.split("/");
    const nameLength = specifier.startsWith("@") ? 2 : 1;
    return { name: parts.slice(0, nameLength).join("/"), subpath: parts.length > nameLength ? `./${parts.slice(nameLength).join("/")}` : "." };
  };

  const nodeModulesPaths = (from: string): string[] => {
    const out: string[] = [];
    let dir = from;
    for (;;) {
      if (!dir.endsWith("/node_modules")) out.push(`${dir === "/" ? "" : dir}/node_modules`);
      if (dir === "/") break;
      dir = dir.slice(0, dir.lastIndexOf("/")) || "/";
    }
    return out;
  };

  const resolveBarePackage = (specifier: string, fromDir: string): string => {
    const { name, subpath } = splitPackageRequest(specifier);
    for (const nm of nodeModulesPaths(fromDir)) {
      const pkgDir = `${nm}/${name}`;
      if (!isDir(pkgDir)) continue;
      const pkg = readJson(`${pkgDir}/package.json`);
      if (pkg?.exports != null) return resolveExports(pkgDir, pkg.exports, subpath);
      if (subpath !== ".") throw new EsmResolveError("ERR_PACKAGE_PATH_NOT_EXPORTED", `Package subpath '${subpath}' is not defined (no "exports" in ${pkgDir}/package.json)`);
      const main = typeof pkg?.main === "string" ? pkg.main : "index.js";
      const resolved = ctx.path.resolve(pkgDir, main);
      if (!isFile(resolved)) throw new EsmResolveError("ERR_MODULE_NOT_FOUND", `Cannot find module '${specifier}'`);
      return resolved;
    }
    throw new EsmResolveError("ERR_MODULE_NOT_FOUND", `Cannot find package '${name}' imported from ${fromDir}`);
  };

  function resolveEsmSpecifier(specifier: string, referrerDir: string): IResolvedModule {
    if (specifier.startsWith("#")) return resolvePackageImports(specifier, referrerDir);
    if (specifier.startsWith("file:")) return resolveFileUrl(specifier, referrerDir);
    const bare = specifier.startsWith("node:") ? specifier.slice(5) : specifier;
    if (specifier.startsWith("node:") || (!isRelative(specifier) && ctx.builtins.canBeRequiredByUsers(bare))) {
      if (!ctx.builtins.canBeRequiredByUsers(bare)) throw new EsmResolveError("ERR_UNKNOWN_BUILTIN_MODULE", `No such built-in module: ${specifier}`);
      return { format: "builtin", key: bare };
    }

    if (isRelative(specifier)) {
      const resolved = ctx.path.resolve(referrerDir, specifier);
      if (!isFile(resolved)) {
        throw new EsmResolveError(
          "ERR_MODULE_NOT_FOUND",
          `Cannot find module '${resolved}' imported from ${referrerDir} (ESM requires an explicit file extension; no directory/index fallback)`,
        );
      }
      return { format: formatOf(resolved), key: resolved };
    }

    const resolved = resolveBarePackage(specifier, referrerDir);
    return { format: formatOf(resolved), key: resolved };
  }

  return { resolveEsmSpecifier, formatOfPath: formatOf };
};

export { EsmResolveError };

/** The file behind a module key: keys for a `file:` URL with a query/hash carry it after a NUL
 *  (see resolveFileUrl) - one module instance per distinct URL, one file on disk. */
export const modulePath = (key: string): string => {
  const nul = key.indexOf("\0");
  return nul === -1 ? key : key.slice(0, nul);
};

/** The `?query#hash` part of a module key, if any. */
export const moduleUrlSuffix = (key: string): string => {
  const nul = key.indexOf("\0");
  return nul === -1 ? "" : key.slice(nul + 1);
};

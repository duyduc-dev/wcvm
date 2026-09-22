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

  /** Same shape/precedence rules as cjs.ts's own (string | conditions | subpath map | "*" pattern), for the "import" condition set. */
  const resolveExportsTarget = (target: unknown, pkgDir: string, match: string, isPattern: boolean): string | null | undefined => {
    if (typeof target === "string") {
      if (!target.startsWith("./")) throw new EsmResolveError("ERR_INVALID_PACKAGE_TARGET", `Invalid "exports" target "${target}" in ${pkgDir}/package.json`);
      return ctx.path.resolve(pkgDir, isPattern ? target.replaceAll("*", match) : target);
    }
    if (Array.isArray(target)) {
      for (const item of target) {
        const resolved = resolveExportsTarget(item, pkgDir, match, isPattern);
        if (resolved !== undefined) return resolved;
      }
      return undefined;
    }
    if (target && typeof target === "object") {
      for (const [key, value] of Object.entries(target)) {
        if (CONDITIONS.has(key)) {
          const resolved = resolveExportsTarget(value, pkgDir, match, isPattern);
          if (resolved !== undefined) return resolved;
        }
      }
      return undefined;
    }
    return target === null ? null : undefined;
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

    if (Object.hasOwn(map, subpath) && !subpath.includes("*")) {
      const resolved = resolveExportsTarget(map[subpath], pkgDir, "", false);
      if (!resolved) throw notExported();
      return resolved;
    }

    let best: { key: string; match: string } | null = null;
    for (const key of Object.keys(map)) {
      const star = key.indexOf("*");
      if (star === -1) continue;
      const prefix = key.slice(0, star);
      const suffix = key.slice(star + 1);
      if (subpath.startsWith(prefix) && subpath.length >= key.length && subpath.endsWith(suffix)) {
        if (!best || prefix.length > best.key.indexOf("*")) best = { key, match: subpath.slice(prefix.length, subpath.length - suffix.length) };
      }
    }
    if (best) {
      const resolved = resolveExportsTarget(map[best.key], pkgDir, best.match, true);
      if (resolved) return resolved;
    }
    throw notExported();
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

  const resolveEsmSpecifier = (specifier: string, referrerDir: string): IResolvedModule => {
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
  };

  return { resolveEsmSpecifier, formatOfPath: formatOf };
};

export { EsmResolveError };

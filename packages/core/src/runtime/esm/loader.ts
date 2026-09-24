// Orchestrates real ESM: resolves the static import graph, rewrites each
// module's specifiers to Blob URLs (dependency-first, so a module is only
// blobbed once every static dependency already has one), then lets the
// browser's own dynamic import() do the actual linking/evaluation - real
// live bindings, real circular-import semantics, real top-level await, none
// of it reimplemented here. See resolve.ts and rewrite.ts for the pieces.
//
// Genuinely circular static imports can't work this way: creating A's blob
// needs B's URL and vice versa, and a Blob's content is fixed at creation,
// unlike a real fetchable URL a server could answer lazily. That case throws
// a clear ERR_CIRCULAR_ESM_NOT_SUPPORTED instead of silently breaking live
// bindings; dynamic import() has no such limit (it resolves lazily, so it
// works as the standard way to break a cycle) - see PLAN.md.
//
// import.meta.url is the module's Blob URL, not its real path (a known,
// deliberate difference - see PLAN.md "Known differences").

import type { IFsClient } from "../../fs/fsClient";
import type { EventLoop } from "../eventLoop";
import { EsmSyntaxError, parseModule, parseScript, type IAcorn } from "./ast";
import { createEsmResolver, EsmResolveError, type EsmFormat, type IEsmResolveContext } from "./resolve";
import { DYNAMIC_IMPORT_BRIDGE, rewriteModule } from "./rewrite";

const REQUIRE_BUILTIN_BRIDGE = "__wcvm_require_builtin__";
const REQUIRE_CJS_BRIDGE = "__wcvm_require_cjs__";
const IDENTIFIER = /^[A-Za-z_$][A-Za-z0-9_$]*$/;

export interface IEsmLoaderContext extends IEsmResolveContext {
  fs: IFsClient;
  acorn: IAcorn;
  builtins: { canBeRequiredByUsers(id: string): boolean; requireBuiltin(id: string): any };
  /** cjs.ts's own `require`, for importing a plain CJS file from ESM. */
  requireCjs(path: string): any;
  loop: EventLoop;
  /** Where the dynamic-import/interop bridge functions are installed (`self` in a real worker). */
  globalObject: Record<string, unknown>;
}

const namedReexports = (bridgeExpr: string, value: unknown): string => {
  if (!value || (typeof value !== "object" && typeof value !== "function")) return "";
  return Object.keys(value)
    .filter((key) => IDENTIFIER.test(key) && key !== "default")
    .map((key) => `export const ${key} = ${bridgeExpr}[${JSON.stringify(key)}];`)
    .join("\n");
};

export const createEsmLoader = (ctx: IEsmLoaderContext) => {
  const resolver = createEsmResolver(ctx);
  const decoder = new TextDecoder();
  const blobUrls = new Map<string, string>();
  const inProgress = new Set<string>();
  let bridgeInstalled = false;

  const blobFor = (source: string): string => URL.createObjectURL(new Blob([source], { type: "text/javascript" }));

  const installBridge = () => {
    if (bridgeInstalled) return;
    bridgeInstalled = true;
    Object.assign(ctx.globalObject, {
      [DYNAMIC_IMPORT_BRIDGE]: (specifier: string, selfUrl: string) => {
        const release = ctx.loop.ref();
        try {
          const resolved = resolver.resolveEsmSpecifier(specifier, ctx.path.dirname(selfUrl));
          const url = prepare(resolved.key, resolved.format);
          return import(/* @vite-ignore */ url).finally(release);
        } catch (error) {
          release();
          return Promise.reject(error);
        }
      },
      [REQUIRE_BUILTIN_BRIDGE]: (id: string) => ctx.builtins.requireBuiltin(id),
      [REQUIRE_CJS_BRIDGE]: (path: string) => ctx.requireCjs(path),
    });
  };

  /** Returns `key`'s Blob URL, creating it (and every static dependency it needs first) if not already cached. */
  const prepare = (key: string, format: EsmFormat): string => {
    const cached = blobUrls.get(key);
    if (cached) return cached;

    if (format === "builtin") {
      const value = ctx.builtins.requireBuiltin(key);
      const bridge = `${REQUIRE_BUILTIN_BRIDGE}(${JSON.stringify(key)})`;
      const url = blobFor(`const __m = ${bridge};\nexport default __m;\n${namedReexports("__m", value)}`);
      blobUrls.set(key, url);
      return url;
    }
    if (format === "cjs") {
      const bridge = `${REQUIRE_CJS_BRIDGE}(${JSON.stringify(key)})`;
      // The CJS module must actually run before we know its export names.
      const value = ctx.requireCjs(key);
      const url = blobFor(`const __m = ${bridge};\nexport default __m;\n${namedReexports("__m", value)}`);
      blobUrls.set(key, url);
      return url;
    }
    if (format === "json") {
      const url = blobFor(`export default ${decoder.decode(ctx.fs.readFile(key))};`);
      blobUrls.set(key, url);
      return url;
    }

    if (inProgress.has(key)) {
      throw new EsmResolveError("ERR_CIRCULAR_ESM_NOT_SUPPORTED", `Circular static ESM import involving '${key}' is not supported yet (use a dynamic import() to break the cycle)`);
    }
    inProgress.add(key);
    try {
      const source = decoder.decode(ctx.fs.readFile(key));
      const ast = parseModule(ctx.acorn, source, key);
      const dir = ctx.path.dirname(key);
      const rewritten = rewriteModule(
        source,
        ast,
        (specifier) => {
          const resolved = resolver.resolveEsmSpecifier(specifier, dir);
          return prepare(resolved.key, resolved.format);
        },
        key,
      );
      const url = blobFor(rewritten);
      blobUrls.set(key, url);
      return url;
    } finally {
      inProgress.delete(key);
    }
  };

  /** Runs `entryPath` (already resolved to an ESM-formatted file) as the program's entry module. */
  const importEntry = (entryPath: string): void => {
    installBridge();
    const release = ctx.loop.ref();
    const url = prepare(entryPath, "esm");
    import(/* @vite-ignore */ url).then(release, (error: unknown) => {
      release();
      ctx.loop.callback(() => {
        throw error;
      });
    });
  };

  /**
   * A CommonJS module's (or `node -e`'s) own `import(...)` calls, rewritten to the same bridge an
   * ES module's use - left alone, they'd reach the browser's native import(), which can't resolve
   * a bare specifier or a VFS path at all (and fails silently: nothing refs the event loop while it
   * rejects). `selfPath` is what a relative specifier resolves against: the module's own file, or
   * `<cwd>/[eval]`. Source acorn can't parse is returned untouched, for eval to report (or run).
   */
  const rewriteScript = (source: string, selfPath: string): string => {
    let program;
    try {
      program = parseScript(ctx.acorn, source, selfPath);
    } catch {
      return source;
    }
    installBridge();
    return rewriteModule(
      source,
      program,
      () => {
        throw new Error("a script has no static imports");
      },
      selfPath,
    );
  };

  return { importEntry, rewriteScript, formatOfPath: resolver.formatOfPath };
};

export { EsmResolveError, EsmSyntaxError };

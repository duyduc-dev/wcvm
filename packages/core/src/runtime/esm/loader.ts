// Orchestrates real ESM: resolves the static import graph, rewrites each
// module's specifiers to Blob URLs (dependency-first, so a module is only
// blobbed once every static dependency already has one), then lets the
// browser's own dynamic import() do the actual linking/evaluation - real
// live bindings, real circular-import semantics, real top-level await, none
// of it reimplemented here. See resolve.ts and rewrite.ts for the pieces.
//
// A genuinely circular group of static ESM imports (a strongly connected
// component, SCC, of the import graph) can't get a plain per-module Blob URL
// each: creating A's blob needs B's already-known URL and vice versa, and a
// Blob's content is fixed at creation, unlike a real fetchable URL a server
// could answer lazily. Two things were tried and DIDN'T work before landing
// on cyclic.ts's approach (kept here so this isn't rediscovered the hard
// way): (1) just throwing a clear ERR_CIRCULAR_ESM_NOT_SUPPORTED - safe, but
// hit for real by zod v4's own core.js/util.js (a genuine 2-node cycle,
// reached transitively through @tanstack/router-plugin) and by Svelte's own
// compiler, both PARKED features as a result; (2) rewriting just the ONE
// edge that closes the cycle to the SAME lazy dynamic-import bridge a real
// `import()` call already uses - looks reasonable (dynamic import resolves
// lazily, so it should sidestep the "need the URL up front" problem) but
// DEADLOCKS instead: a dynamic `import()` of a module that's still
// mid-evaluation further up the SAME synchronous call chain does not
// resolve early with whatever's been computed so far - it waits for that
// evaluation to finish, which can't happen if THAT evaluation is itself
// waiting on this same `import()` (confirmed directly, not assumed: a
// real Chromium test of exactly this shape hung until the test's own
// timeout). The actual fix (below): every "esm"-format module reachable
// from a `prepare()` call is DISCOVERED first (parsed, its own static
// dependencies resolved) with NO blobbing yet, then partitioned into
// strongly connected components (Tarjan's algorithm, `computeSccs`) and
// processed dependency-first - a singleton SCC (no self-loop) is prepared
// exactly as before (a real blob, ordinary static imports, real live
// bindings); a genuine cycle is prepared via cyclic.ts's
// `rewriteCyclicModule` instead - see its own doc comment for the full
// design (live property reads against a shared registry, not a native
// import, so nothing ever re-enters a sibling's in-flight evaluation).
//
// `import.meta` is rewritten (rewrite.ts) to a per-module object carrying the
// module's REAL `file://` URL, filename, dirname and a resolve() - the
// browser's own would describe the Blob, which code like Vite's
// `fileURLToPath(new URL("../..", import.meta.url))` or
// `createRequire(import.meta.url)` can't do anything with.

import type { IFsClient } from "../../fs/fsClient";
import type { EventLoop } from "../eventLoop";
import { parseModule, parseScript, staticImportSpecifiers, type AnyNode, type IAcorn } from "./ast";
import { CYCLE_EXPORTS_BRIDGE, CYCLE_READY_BRIDGE, rewriteCyclicModule } from "./cyclic";
import { createEsmResolver, EsmResolveError, modulePath, moduleUrlSuffix, type EsmFormat, type IEsmResolveContext } from "./resolve";
import { DYNAMIC_IMPORT_BRIDGE, IMPORT_META_BRIDGE, rewriteModule } from "./rewrite";
import { rewriteEsmForSyncRequire } from "./syncRequire";

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

// ECMAScript reserved words, plus strict-mode-only reserved words and "await" (reserved at a
// module's top level) - every one is a perfectly valid ExportSpecifier/ImportSpecifier NAME (the
// public name after `as`), just never a bare BINDING identifier. A real CJS module can genuinely
// have an exported property named one of these - e.g. @babel/types's own `import` builder, for
// its `Import` AST node type - and real Node's own require()-from-ESM interop handles it fine
// because it only ever creates a NAMESPACE property, never a top-level `const <name> = ...`.
// namedReexports() below must do the same: emit those via an aliased local binding + `export {
// local as name }` rather than `export const <name> = ...`, which is a syntax error for a
// reserved word (confirmed for real: @babel/types's own `import` property, reached transitively
// through solid-refresh/babel -> @babel/generator -> @babel/types, produced exactly `export const
// import = ...` and broke Solid's whole dev server with a bare "SyntaxError: Unexpected token
// 'import'" - no stack, no indication which module, since the invalid syntax lived in this
// SYNTHESIZED shim rather than in any real file on disk).
const RESERVED_WORDS = new Set([
  "break", "case", "catch", "class", "const", "continue", "debugger", "default", "delete", "do",
  "else", "enum", "export", "extends", "false", "finally", "for", "function", "if", "import",
  "in", "instanceof", "new", "null", "return", "super", "switch", "this", "throw", "true", "try",
  "typeof", "var", "void", "while", "with", "implements", "interface", "let", "package",
  "private", "protected", "public", "static", "yield", "await",
]);

/**
 * One `export const` per enumerable own key, for named-import parity with real Node's facade -
 * which reads every export eagerly, lazy getters included. A getter that THROWS here (a lazily
 * required internal this sandbox doesn't have - e.g. `util.setTraceSigInt`) exports `undefined`
 * instead of failing every `import { anythingElse } from "node:util"` along with it; the module's
 * default export still throws the real error if that property is ever actually used.
 */
// Exported for direct unit testing (loader.test.ts) - everything else here needs a full
// fs client/acorn/event-loop context to exercise, but this piece is pure string-in/string-out.
export const namedReexports = (bridgeExpr: string, value: unknown): string => {
  if (!value || (typeof value !== "object" && typeof value !== "function")) return "";
  const keys = Object.keys(value).filter((key) => IDENTIFIER.test(key) && key !== "default");
  if (keys.length === 0) return "";
  const read = `const __read = (key) => { try { return ${bridgeExpr}[key]; } catch { return undefined; } };`;
  const lines = keys.map((key, i) => {
    if (RESERVED_WORDS.has(key)) {
      const local = `__reserved_export_${i}`;
      return `const ${local} = __read(${JSON.stringify(key)});\nexport { ${local} as ${key} };`;
    }
    return `export const ${key} = __read(${JSON.stringify(key)});`;
  });
  return [read, ...lines].join("\n");
};

export const createEsmLoader = (ctx: IEsmLoaderContext) => {
  const resolver = createEsmResolver(ctx);
  const decoder = new TextDecoder();
  const blobUrls = new Map<string, string>();
  let bridgeInstalled = false;

  const blobFor = (source: string): string => URL.createObjectURL(new Blob([source], { type: "text/javascript" }));

  // A cyclic module's own registry (its exports, as getters - see cyclic.ts) plus every OTHER
  // member of the same SCC it can reach the same way, indexed by resolved key - shared across the
  // whole loader instance since a sibling's registry object must be the SAME one on both sides.
  const cycleRegistries = new Map<string, Record<string, unknown>>();
  // A cycle member has no real static edge forcing the browser to ever evaluate it (that edge is
  // exactly what got removed) - the FIRST read of its registry from anywhere also kicks off a
  // one-time, fire-and-forget import() of it, so it eventually runs and installs its own getters.
  // Idempotent (real import() of an already-loading/loaded URL is itself cached by the browser),
  // but tracked anyway so this only ever happens once per key, not once per read.
  const cycleTriggered = new Set<string>();
  // Which properties of each registry have actually been installed, and who is waiting for one (a
  // module that natively re-exports a cyclic import - see cyclic.ts's local-re-export handling).
  const cycleInstalled = new Map<string, Set<string>>();
  let cycleWaiters: { key: string; prop: string; assign: (value: unknown) => void }[] = [];
  /** Tries every waiter whose property is installed. A getter can itself read ANOTHER sibling that
   *  has not finished yet (a re-export of a re-export), which throws - such a waiter just stays
   *  queued and is retried the next time anything installs. */
  const flushWaiters = () => {
    cycleWaiters = cycleWaiters.filter(({ key, prop, assign }) => {
      if (!cycleInstalled.get(key)?.has(prop)) return true;
      try {
        assign(Reflect.get(cycleRegistries.get(key)!, prop));
        return false;
      } catch {
        return true;
      }
    });
  };

  /** The shared registry object for `key` (created on first use), and - once - kicks off the import of
   *  that module. */
  const registryFor = (key: string): Record<string, unknown> => {
    let registry = cycleRegistries.get(key);
    if (!registry) {
      // A Proxy, not a plain object: a property that hasn't been installed YET (this
      // module's own `Object.defineProperties` call - see cyclic.ts - hasn't run yet) throws
      // instead of silently reading `undefined`. Real live ESM bindings have the exact same
      // shape of hazard (a TDZ ReferenceError for a binding read before its own declaration
      // has run) - reading a genuinely circular import's binding SYNCHRONOUSLY, at the
      // TOP LEVEL, right where the import used to be, is exactly the shape that would ALSO
      // TDZ-fail in real, un-transformed circular ESM, cycle or not; only a LAZY read (inside
      // a function, called later - the real, common shape, and the only one either of this
      // fix's two target cases - zod v4's core.js/util.js, reached through
      // @tanstack/router-plugin - actually needs) works. `Object.defineProperties`'s own
      // default (no explicit trap) forwards straight to the real target, so once a getter IS
      // installed, ordinary reads reach it exactly as if this were a plain object.
      const target: Record<string, unknown> = {};
      registry = new Proxy(target, {
        // `Object.defineProperties` (the end of every cycle member - see cyclic.ts) lands here:
        // record what is now readable and release anyone waiting for exactly that name.
        defineProperty(t, prop, descriptor) {
          const ok = Reflect.defineProperty(t, prop, descriptor);
          if (ok && typeof prop === "string") {
            const installed = cycleInstalled.get(key) ?? new Set<string>();
            installed.add(prop);
            cycleInstalled.set(key, installed);
            flushWaiters();
          }
          return ok;
        },
        get(t, prop, receiver) {
          if (typeof prop === "symbol" || prop in t) return Reflect.get(t, prop, receiver);
          throw new ReferenceError(
            `Cannot access '${String(prop)}' before initialization - a circular ESM import's own binding is only safe to read AFTER the module that declares it has finished running, never synchronously at the top level right where the import used to be (see loader.ts's own doc comment)`,
          );
        },
      });
      cycleRegistries.set(key, registry);
    }
    if (!cycleTriggered.has(key)) {
      cycleTriggered.add(key);
      const release = ctx.loop.ref();
      const reportUncaught = (error: unknown) => ctx.loop.callback(() => { throw error; });
      try {
        const url = prepare(key, "esm");
        import(/* @vite-ignore */ url).then(release, (error: unknown) => {
          release();
          reportUncaught(error);
        });
      } catch (error) {
        release();
        reportUncaught(error);
      }
    }
    return registry;
  };

  const installBridge = () => {
    if (bridgeInstalled) return;
    bridgeInstalled = true;
    Object.assign(ctx.globalObject, {
      [DYNAMIC_IMPORT_BRIDGE]: (specifier: unknown, selfUrl: string) => {
        const release = ctx.loop.ref();
        try {
          // import() converts its argument with ToString (a `URL` object is legal and common:
          // `import(pathToFileURL(file))`, which is how ember-cli loads ember-cli-build.mjs).
          const resolved = resolver.resolveEsmSpecifier(String(specifier), ctx.path.dirname(modulePath(selfUrl)));
          const url = prepare(resolved.key, resolved.format);
          return import(/* @vite-ignore */ url).finally(release);
        } catch (error) {
          release();
          return Promise.reject(error);
        }
      },
      [IMPORT_META_BRIDGE]: (path: string) => importMeta(path),
      [REQUIRE_BUILTIN_BRIDGE]: (id: string) => ctx.builtins.requireBuiltin(id),
      [REQUIRE_CJS_BRIDGE]: (path: string) => ctx.requireCjs(path),
      [CYCLE_EXPORTS_BRIDGE]: (key: string) => registryFor(key),
      [CYCLE_READY_BRIDGE]: (key: string, prop: string, assign: (value: unknown) => void) => {
        const registry = registryFor(key);
        void registry;
        cycleWaiters.push({ key, prop, assign });
        flushWaiters();
      },
    });
  };

  const metas = new Map<string, Record<string, unknown>>();
  /** A module's `import.meta`, like Node's own: one object per module, so what code stores on it
   *  sticks. `resolve()` answers the way the module's own imports would resolve. */
  const importMeta = (key: string) => {
    let meta = metas.get(key);
    if (!meta) {
      const { pathToFileURL } = ctx.builtins.requireBuiltin("url");
      const path = modulePath(key);
      const dirname = ctx.path.dirname(path);
      meta = {
        url: pathToFileURL(path).href + moduleUrlSuffix(key),
        filename: path,
        dirname,
        resolve: (specifier: string) => {
          const resolved = resolver.resolveEsmSpecifier(specifier, dirname);
          return resolved.format === "builtin" ? `node:${resolved.key}` : pathToFileURL(resolved.key).href;
        },
      };
      metas.set(key, meta);
    }
    return meta;
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
      const bridge = `${REQUIRE_CJS_BRIDGE}(${JSON.stringify(modulePath(key))})`;
      // The CJS module must actually run before we know its export names.
      const value = ctx.requireCjs(modulePath(key));
      const url = blobFor(`const __m = ${bridge};\nexport default __m;\n${namedReexports("__m", value)}`);
      blobUrls.set(key, url);
      return url;
    }
    if (format === "json") {
      const url = blobFor(`export default ${decoder.decode(ctx.fs.readFile(modulePath(key)))};`);
      blobUrls.set(key, url);
      return url;
    }

    // esm, not cached: discover the whole reachable-from-here subgraph (no blobbing yet), then
    // process it strongly-connected-component by strongly-connected-component, dependency-first -
    // see this file's own doc comment for why a cycle needs different treatment (cyclic.ts) than
    // an ordinary module (unchanged, below).
    discover(key);
    for (const scc of computeSccs(key)) {
      const isSelfLoop = scc.length === 1 && discovered.get(scc[0]!)!.deps.includes(scc[0]!);
      if (scc.length === 1 && !isSelfLoop) prepareSingleton(scc[0]!);
      else prepareCycle(scc);
    }
    return blobUrls.get(key)!;
  };

  interface IDiscovered {
    dir: string;
    source: string;
    ast: AnyNode;
    /** Resolved keys of this module's own "esm"-format static dependencies that AREN'T already
     *  prepared - i.e., genuinely part of THIS discovery pass's own graph. A non-esm dependency
     *  (builtin/cjs/json) is prepared immediately below instead: it can't participate in a cycle,
     *  and doing it eagerly here means every OTHER dependency-graph edge only ever needs to look
     *  esm-format keys up in `blobUrls`, never branch on format again. */
    deps: string[];
  }
  const discovered = new Map<string, IDiscovered>();
  // `discovered.has(key)` alone only becomes true once a key's WHOLE discover() call has
  // returned - for a genuine cycle, B's own discovery reaches back into A while A's own discover()
  // call is still on the stack (not in `discovered` yet), so without this SEPARATE "currently
  // being discovered" guard, `discover(A)` would just start over from scratch, which starts
  // discovering B again, forever (confirmed for real: a stack overflow, not a hang).
  const discovering = new Set<string>();

  const discover = (key: string): void => {
    if (discovered.has(key) || blobUrls.has(key) || discovering.has(key)) return;
    discovering.add(key);
    const path = modulePath(key);
    const source = decoder.decode(ctx.fs.readFile(path));
    const ast = parseModule(ctx.acorn, source, path);
    const dir = ctx.path.dirname(path);
    const deps: string[] = [];
    for (const spec of staticImportSpecifiers(ast, source)) {
      const resolved = resolver.resolveEsmSpecifier(spec.value, dir);
      if (resolved.format !== "esm") {
        prepare(resolved.key, resolved.format);
      } else if (!blobUrls.has(resolved.key)) {
        deps.push(resolved.key);
        discover(resolved.key);
      }
    }
    discovered.set(key, { dir, source, ast, deps });
  };

  /** Tarjan's SCC algorithm over the subgraph `discover(root)` just built, over the SAME `deps`
   *  edges - its natural output order is already dependency-first (an SCC is only ever popped
   *  once every OTHER SCC reachable FROM it has already been popped), exactly the order `prepare`
   *  needs to process them in. */
  const computeSccs = (root: string): string[][] => {
    let index = 0;
    const indices = new Map<string, number>();
    const lowlink = new Map<string, number>();
    const onStack = new Set<string>();
    const stack: string[] = [];
    const sccs: string[][] = [];

    const strongconnect = (v: string): void => {
      indices.set(v, index);
      lowlink.set(v, index);
      index++;
      stack.push(v);
      onStack.add(v);
      for (const w of discovered.get(v)!.deps) {
        if (!indices.has(w)) {
          strongconnect(w);
          lowlink.set(v, Math.min(lowlink.get(v)!, lowlink.get(w)!));
        } else if (onStack.has(w)) {
          lowlink.set(v, Math.min(lowlink.get(v)!, indices.get(w)!));
        }
      }
      if (lowlink.get(v) === indices.get(v)) {
        const scc: string[] = [];
        let w: string;
        do {
          w = stack.pop()!;
          onStack.delete(w);
          scc.push(w);
        } while (w !== v);
        sccs.push(scc);
      }
    };

    strongconnect(root);
    return sccs;
  };

  /** A single module, no cycle involved - every dependency (esm or not) is already in `blobUrls`
   *  by construction (dependency-first SCC processing order), so this never recurses into fresh
   *  discovery; it's the exact same rewrite `prepare` always did before cycles existed at all. */
  const prepareSingleton = (key: string): void => {
    const { source, ast, dir } = discovered.get(key)!;
    const rewritten = rewriteModule(
      source,
      ast,
      (specifier) => {
        const resolved = resolver.resolveEsmSpecifier(specifier, dir);
        return prepare(resolved.key, resolved.format);
      },
      key,
      ctx.acorn,
    );
    blobUrls.set(key, blobFor(rewritten));
  };

  /** A genuine cycle (SCC of size > 1, or a self-loop) - see cyclic.ts for the actual transform.
   *  Every member is rewritten and blobbed here, all before any of them is ever evaluated. */
  const prepareCycle = (scc: string[]): void => {
    const members = new Set(scc);
    for (const key of scc) {
      const { source, ast, dir } = discovered.get(key)!;
      const rewritten = rewriteCyclicModule(
        source,
        ast,
        (specifier) => {
          const resolved = resolver.resolveEsmSpecifier(specifier, dir);
          return resolved.format === "esm" && members.has(resolved.key) ? resolved.key : undefined;
        },
        (specifier) => {
          const resolved = resolver.resolveEsmSpecifier(specifier, dir);
          return prepare(resolved.key, resolved.format);
        },
        key,
        ctx.acorn,
      );
      blobUrls.set(key, blobFor(rewritten));
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
      ctx.acorn,
    );
  };

  /**
   * Blob-ifies the file at `path` (and, for a module, its whole static import graph) so it can be
   * handed to a REAL native `new Worker(...)` - see `runtime/bindings/rawWorker.ts`, the only
   * caller: a guest script's own `new Worker(new URL("./x.mjs", import.meta.url))` builds a
   * `file:` URL (this sandbox's own deliberate `import.meta.url` scheme, rewritten from the real
   * Blob URL the module was ACTUALLY loaded through - see this file's own doc comment), and a
   * real native Worker can never load a `file:` URL (confirmed: it throws `Failed to construct
   * 'Worker': Script ... cannot be accessed from origin ...` synchronously) - so that file needs
   * ITS OWN fresh Blob URL, the same way this loader already makes one for every ordinary import.
   * `module` picks ESM (parse + rewrite its own import graph, `type: "module"`) vs. a plain
   * classic script (blob the raw bytes as-is, no import resolution - `import()`/`import.meta`
   * aren't supported inside one, matching a real classic script's own restriction).
   */
  const blobUrlForFile = (path: string, module: boolean): string => {
    if (!module) return blobFor(decoder.decode(ctx.fs.readFile(path)));
    installBridge();
    return prepare(path, resolver.formatOfPath(path));
  };

  /** ES module source -> a synchronous function body, for `require(esm)` (see syncRequire.ts). */
  const transformForSyncRequire = (source: string, path: string): string => {
    const program = parseModule(ctx.acorn, source, path);
    installBridge();
    return rewriteEsmForSyncRequire(source, program, path, ctx.acorn);
  };

  return { importEntry, rewriteScript, transformForSyncRequire, resolveEsmSpecifier: resolver.resolveEsmSpecifier, formatOfPath: resolver.formatOfPath, blobUrlForFile };
};

export { EsmResolveError };
export { EsmSyntaxError } from "./ast";

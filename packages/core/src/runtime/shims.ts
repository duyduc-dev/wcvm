import { asyncLocalStorageShim, promiseHooksShim } from "./asyncContext";
import { createWebStreamAdaptersShim } from "./webStreamAdapters";
import type { BuiltinFactory } from "./node/types";
import { withFileUrlFix } from "./fileUrlFix";

interface IShimContext {
  has(id: string): boolean;
  requireBuiltin(id: string): any;
  internalBinding(name: string): any;
}

// The platform's own WHATWG classes, captured at module load - before `globalObject: self` can put
// Node's own same-named globals over them (CLAUDE.md's "never call a global by its bare name").
const WEB_STREAM_NAMES = [
  "ReadableStream", "ReadableStreamDefaultReader", "ReadableStreamBYOBReader", "ReadableStreamBYOBRequest",
  "ReadableByteStreamController", "ReadableStreamDefaultController", "TransformStream",
  "TransformStreamDefaultController", "WritableStream", "WritableStreamDefaultWriter",
  "WritableStreamDefaultController", "ByteLengthQueuingStrategy", "CountQueuingStrategy", "TextEncoderStream",
  "TextDecoderStream", "CompressionStream", "DecompressionStream",
] as const;

const platform = {
  /** Chromium's non-standard `performance.memory` (captured now: `globalObject: self` replaces `performance`). */
  memory: () => (globalThis.performance as unknown as { memory?: { usedJSHeapSize: number; totalJSHeapSize: number; jsHeapSizeLimit: number } } | undefined)?.memory,
  webStreams: Object.fromEntries(WEB_STREAM_NAMES.map((name) => [name, (globalThis as any)[name]]).filter(([, value]) => value)),
  crypto: globalThis.crypto,
  WebSocket: globalThis.WebSocket,
  CloseEvent: globalThis.CloseEvent,
  MessageEvent: globalThis.MessageEvent,
};

// Modules that only exist under a `node:` scheme (never loadable bare).
const SCHEME_ONLY = ["sea", "sqlite", "test", "test/reporters"];

const stripScheme = (id: string) => (id.startsWith("node:") ? id.slice(5) : id);

/**
 * Hand-written stand-ins, for two different reasons:
 *  - Node modules that are part of Node's C++ bootstrap rather than its `lib/`, so they cannot
 *    be vendored verbatim at all (`internal/url`, `internal/encoding`, `internal/blob`,
 *    `v8`). (`internal/perf/observe` used to be one too; it's the real vendored module now, over
 *    bindings/performance.ts, since `perf_hooks` needs a real PerformanceObserver.)
 *  - Modules that are built on V8 internals a Worker doesn't have (`internal/promise_hooks`, and the
 *    `AsyncLocalStorage` built on it) - see asyncContext.ts.
 *  - Real, vendorable `lib/` modules this sandbox deliberately answers with a fixed, simplified,
 *    or narrower result instead of fully implementing: `dns`/`cluster` because there's nothing
 *    real behind them to report; `tls`/`https`/`http2`/`inspector` because there's no TLS stack,
 *    nghttp2 or V8 inspector to put behind them (they load, and fail with real Node's own error on use); `crypto` because real Node's own `crypto.js` needs a much bigger
 *    native-crypto binding surface (KeyObject/PEM, X.509, DiffieHellman, scrypt, argon2 - none of
 *    it mappable onto the Web Crypto API) than this sandbox's actual need (hashing) justifies -
 *    see their own comments below for why.
 *
 * `internal/bootstrap/realm` is Node's own builtin loader. Vendored modules
 * reach it for `BuiltinModule` (does this id exist? may users require it?), so
 * we answer those questions from OUR loader's table.
 */
const createShims = (ctx: IShimContext): Record<string, BuiltinFactory> => {
  const isPublic = (id: string) => !id.startsWith("internal/") && ctx.has(id);

  const BuiltinModule = {
    exists: (id: string) => ctx.has(id),
    isBuiltin: (id: string) => ctx.has(stripScheme(id)),
    canBeRequiredByUsers: (id: string) => isPublic(id),
    canBeRequiredWithoutScheme: (id: string) =>
      isPublic(id) && !SCHEME_ONLY.includes(id),
    normalizeRequirableId: (id: string): string | undefined => {
      if (id.startsWith("node:")) {
        const bare = id.slice(5);
        if (isPublic(bare)) return bare;
      } else if (isPublic(id) && !SCHEME_ONLY.includes(id)) {
        return id;
      }
      return undefined;
    },
    getSchemeOnlyModuleNames: () => [...SCHEME_ONLY],
    getCanBeRequiredByUsersWithoutSchemeList: () => [],
    getAllBuiltinModuleIds: () => [],
  };

  /**
   * Node's `internal/url` is its URL class over ada, a C++ WHATWG parser. The
   * platform already ships a spec-compliant URL, so this is the API surface the
   * rest of lib/ uses, built on it.
   */
  const internalUrl: BuiltinFactory = (_exports, _require, module) => {
    const codes = () => ctx.requireBuiltin("internal/errors").codes;
    const nodePath = () => ctx.requireBuiltin("path");
    const URLCtor = withFileUrlFix(globalThis.URL);
    const URLSearchParamsCtor = globalThis.URLSearchParams;

    const isURL = (value: any): boolean =>
      Boolean(value?.href && value.protocol && value.auth === undefined && value.path === undefined);

    const fileURLToPath = (input: any): string => {
      const { ERR_INVALID_ARG_TYPE, ERR_INVALID_URL_SCHEME, ERR_INVALID_FILE_URL_HOST, ERR_INVALID_FILE_URL_PATH } = codes();
      if (typeof input === "string") input = new URLCtor(input);
      else if (!isURL(input)) throw new ERR_INVALID_ARG_TYPE("path", ["string", "URL"], input);
      if (input.protocol !== "file:") throw new ERR_INVALID_URL_SCHEME("file");
      if (input.hostname !== "") throw new ERR_INVALID_FILE_URL_HOST("linux");
      if (/%2f/i.test(input.pathname)) {
        throw new ERR_INVALID_FILE_URL_PATH("must not include encoded / characters");
      }
      return decodeURIComponent(input.pathname);
    };

    const pathToFileURL = (filepath: string): URL => {
      let resolved: string = nodePath().resolve(filepath);
      if (filepath.endsWith("/") && !resolved.endsWith("/")) resolved += "/";
      // Parsed from a string, not built by setting `pathname` on `file://`: Chrome on Windows turns
      // that into `file:////home/...` (an empty segment before the path), which fileURLToPath rejects.
      const encoded = resolved.replace(/%/g, "%25").replace(/\\/g, "%5C").replace(/\n/g, "%0A")
        .replace(/\r/g, "%0D").replace(/\t/g, "%09").replace(/\?/g, "%3F").replace(/#/g, "%23");
      return new URLCtor(`file://${encoded}`);
    };

    const toPathIfFileURL = (value: any) => (isURL(value) ? fileURLToPath(value) : value);

    const urlToHttpOptions = (url: any) => {
      const options: Record<string, unknown> = {
        protocol: url.protocol,
        hostname: url.hostname.startsWith("[") ? url.hostname.slice(1, -1) : url.hostname,
        hash: url.hash,
        search: url.search,
        pathname: url.pathname,
        path: `${url.pathname || ""}${url.search || ""}`,
        href: url.href,
      };
      if (url.port !== "") options.port = Number(url.port);
      if (url.username || url.password) {
        options.auth = `${decodeURIComponent(url.username)}:${decodeURIComponent(url.password)}`;
      }
      return options;
    };

    // The public `url` module's legacy url.parse()/format() protocol tables (real Node defines them
    // here too, in internal/url.js; it only ever calls `.has()` on them).
    const protocols = (...names: string[]) => new Set(names.flatMap((name) => [name, `${name}:`]));

    module.exports = {
      URL: URLCtor,
      URLSearchParams: URLSearchParamsCtor,
      isURL,
      fileURLToPath,
      fileURLToPathBuffer: (input: any) => ctx.requireBuiltin("buffer").Buffer.from(fileURLToPath(input)),
      unsafeProtocol: protocols("javascript"),
      hostlessProtocol: protocols("javascript"),
      slashedProtocol: protocols("http", "https", "ftp", "gopher", "file", "ws", "wss"),
      pathToFileURL,
      toPathIfFileURL,
      urlToHttpOptions,
      domainToASCII: (domain: string) => { try { return new URLCtor(`http://${domain}`).hostname; } catch { return ""; } },
      domainToUnicode: (domain: string) => { try { return new URLCtor(`http://${domain}`).hostname; } catch { return ""; } },
      installObjectURLMethods: () => {},
      isURLThis: (value: unknown) => value instanceof URLCtor,
    };
  };

  /** Node's TextEncoder/TextDecoder sit on a C++ binding; the platform's are the same standard. */
  const internalEncoding: BuiltinFactory = (_exports, _require, module) => {
    const getEncodingFromLabel = (label: string): string | undefined => {
      try {
        return new TextDecoder(label).encoding;
      } catch {
        return undefined;
      }
    };
    module.exports = {
      TextEncoder: globalThis.TextEncoder,
      TextDecoder: globalThis.TextDecoder,
      getEncodingFromLabel,
    };
  };

  /** Node's Blob is native (blob binding); the platform's is the same standard. */
  const internalBlob: BuiltinFactory = (_exports, _require, module) => {
    const BlobCtor = globalThis.Blob;
    module.exports = {
      Blob: BlobCtor,
      ClonedBlob: undefined,
      isBlob: (value: unknown) => value instanceof BlobCtor,
      kHandle: Symbol("kHandle"),
      resolveObjectURL: () => undefined,
      // fs.openAsBlob(path): a Blob over the file's current contents.
      createBlobFromFilePath: (path: string, options?: { type?: string }) =>
        new BlobCtor([ctx.internalBinding("fs").__readForBlob(path)], options),
    };
  };

  /**
   * dns.js (a real, sizable module wrapping cares_wrap's real getaddrinfo/queryA/etc.) isn't
   * vendored - this sandbox is a single virtual host with no real network to resolve names
   * against, so hostname resolution is a fixed answer, not a real lookup. Only `lookup()`:
   * net.js's own default `net.connect({port})` (no explicit host - 'localhost' is its default)
   * needs it to skip straight to internalConnect(); nothing else in this sandbox calls dns.*.
   */
  const dnsShim: BuiltinFactory = (_exports, _require, module, process) => {
    const ADDRESS = "127.0.0.1";
    const FAMILY = 4;
    const lookup = (
      _hostname: string,
      options: unknown,
      callback?: (error: Error | null, address: unknown, family?: number) => void,
    ) => {
      const cb = typeof options === "function" ? (options as typeof callback) : callback;
      const all = typeof options === "object" && options !== null && (options as { all?: boolean }).all === true;
      process.nextTick(() => cb?.(null, all ? [{ address: ADDRESS, family: FAMILY }] : ADDRESS, all ? undefined : FAMILY));
    };
    // dns.promises / require("dns/promises"): the same fixed answer, in the promise API's own
    // shape (`{ address, family }`, not the callback's separate arguments). Vite compares two
    // lookups of "localhost" to spot an OS that reorders them - identical answers mean "no".
    const promises = {
      lookup: async (_hostname: string, options?: unknown) => {
        const all = typeof options === "object" && options !== null && (options as { all?: boolean }).all === true;
        return all ? [{ address: ADDRESS, family: FAMILY }] : { address: ADDRESS, family: FAMILY };
      },
      getDefaultResultOrder: () => "verbatim",
      setDefaultResultOrder: () => {},
    };
    module.exports = {
      lookup,
      promises,
      getDefaultResultOrder: () => "verbatim",
      setDefaultResultOrder: () => {},
      ADDRCONFIG: 0,
      ALL: 0,
      V4MAPPED: 0,
    };
  };

  /**
   * v8's serialize/deserialize sits on a real V8 ValueSerializer C++ binding we don't
   * implement. `internal/child_process/serialization.js` needs `v8.DefaultSerializer`/
   * `DefaultDeserializer` to exist as extendable classes at module load time (`class
   * ChildProcessSerializer extends v8.DefaultSerializer`) - extending only wires up the
   * prototype chain, it never constructs the base class. fork()'s default and only supported
   * IPC serialization mode here, "json", never actually instantiates them.
   */
  const v8Shim: BuiltinFactory = (_exports, _require, module) => {
    const notImplemented = () => {
      throw new Error("v8 serialize/deserialize is not implemented");
    };
    class DefaultSerializer {
      constructor() {
        notImplemented();
      }
    }
    class DefaultDeserializer {
      constructor() {
        notImplemented();
      }
    }
    const { codes } = ctx.requireBuiltin("internal/errors");
    const unsupported = (name: string) => () => {
      throw new codes.ERR_METHOD_NOT_IMPLEMENTED(`v8.${name}()`);
    };
    // Real Node's field set. Used/total/limit come from Chromium's `performance.memory` when it exists;
    // the rest (executable memory, handles, native contexts) have no browser counterpart and are 0/1.
    const getHeapStatistics = () => {
      const memory = platform.memory();
      const used = memory?.usedJSHeapSize ?? 0;
      const total = memory?.totalJSHeapSize ?? used;
      const limit = memory?.jsHeapSizeLimit ?? 4 * 1024 * 1024 * 1024;
      return {
        total_heap_size: total,
        total_heap_size_executable: 0,
        total_physical_size: total,
        total_available_size: Math.max(0, limit - used),
        used_heap_size: used,
        heap_size_limit: limit,
        malloced_memory: 0,
        peak_malloced_memory: 0,
        does_zap_garbage: 0,
        number_of_native_contexts: 1,
        number_of_detached_contexts: 0,
        total_global_handles_size: 0,
        used_global_handles_size: 0,
        external_memory: 0,
      };
    };
    const noopHook = () => () => {};
    module.exports = {
      DefaultSerializer,
      DefaultDeserializer,
      Serializer: DefaultSerializer,
      Deserializer: DefaultDeserializer,
      serialize: notImplemented,
      deserialize: notImplemented,
      getHeapStatistics,
      getHeapSpaceStatistics: () => [],
      getHeapCodeStatistics: () => ({ code_and_metadata_size: 0, bytecode_and_metadata_size: 0, external_script_source_size: 0, cpu_profiler_metadata_size: 0 }),
      // No `--v8-options` to set from inside a Worker (see the process-worker notes in CLAUDE.md).
      setFlagsFromString: () => {},
      cachedDataVersionTag: () => 0,
      getHeapSnapshot: unsupported("getHeapSnapshot"),
      writeHeapSnapshot: unsupported("writeHeapSnapshot"),
      setHeapSnapshotNearHeapLimit: () => {},
      isStringOneByteRepresentation: (value: string) => !/[^\u0000-\u00ff]/.test(value),
      promiseHooks: { onInit: noopHook, onSettled: noopHook, onBefore: noopHook, onAfter: noopHook, createHook: noopHook },
      startupSnapshot: { isBuildingSnapshot: () => false, addSerializeCallback: () => {}, addDeserializeCallback: () => {}, setDeserializeMainFunction: () => {} },
    };
  };

  /**
   * vm.js sits on a real V8 Context/Script C++ binding this sandbox doesn't implement (no real
   * separate V8 contexts/realms to run code in) - found needed for real (not speculatively):
   * `jiti` (the TS/ESM-on-the-fly loader Vite 7's own config loader uses internally for
   * `vite.config.ts` when a plugin - `@tanstack/router-plugin` - needs the config synchronously
   * required, not just imported) calls exactly one vm API, `vm.runInThisContext(code, options)` -
   * confirmed by reading jiti's own real published bundle (`dist/jiti.cjs`), not guessed: no
   * `Script`, `SourceTextModule`, `createContext`, or anything else from `vm` appears anywhere in
   * it. `runInThisContext` compiles and runs code in the CURRENT realm's global scope only (no
   * access to the caller's own local variables) - exactly what an INDIRECT `eval()` already does
   * (`(0, eval)(code)`, the same trick `cjs.ts`'s own `compile()` already uses for the same
   * reason), so this needs no new capability, just the right name and options handled: `filename`
   * (a `//# sourceURL=` comment, `cjs.ts`'s own convention, so stack traces still point at the
   * real file) and `lineOffset` (leading blank lines, so reported line numbers still line up).
   * Everything else `vm` exports is simply absent - the same honest "not a function"/"not a
   * constructor" failure shape `crypto`'s own missing ciphers already have - since nothing this
   * sandbox has actually exercised needs it.
   */
  const vmShim: BuiltinFactory = (_exports, _require, module) => {
    interface IRunOptions {
      filename?: string;
      lineOffset?: number;
    }
    const withSourceUrl = (code: string, options?: IRunOptions) => {
      const lineOffset = options?.lineOffset ?? 0;
      const padded = lineOffset > 0 ? "\n".repeat(lineOffset) + code : code;
      return options?.filename ? `${padded}\n//# sourceURL=${options.filename}` : padded;
    };
    const runInThisContext = (code: string, options?: IRunOptions) => (0, eval)(withSourceUrl(code, options));

    // `createContext`/`runInContext`: a real separate V8 context (own global, own intrinsics) cannot be
    // made from inside a Worker. What can be: run the code with the sandbox object as its SCOPE, so the
    // sandbox's properties are the globals it reads and writes - which is how these APIs are used in
    // practice (webpack evaluates `/* webpackChunkName: "x" */` magic comments in one; Next's edge
    // sandbox and test runners set up globals). A name the sandbox lacks falls through to this realm's
    // own global, so `JSON`, `Array`, ... resolve (as the same objects, not a context's own copies - no
    // `instanceof` isolation), and an assignment to an undeclared name lands on the real global, not
    // the sandbox. Top-level `var`/function declarations are not sandbox properties either; `globalThis`
    // and `this` are the sandbox.
    const contexts = new WeakSet<object>();
    const createContext = (contextObject?: object, _options?: unknown) => {
      const sandbox = contextObject ?? {};
      contexts.add(sandbox);
      return sandbox;
    };
    const isContext = (value: unknown) => typeof value === "object" && value !== null && contexts.has(value);
    // The scope the code sees: the sandbox's own properties, plus `globalThis` pointing back at the
    // sandbox (a context's global IS the sandbox - Next's manifests do `globalThis.__RSC_MANIFEST = ...`
    // and read it off the sandbox afterwards). Cached per sandbox.
    const scopes = new WeakMap<object, object>();
    const scopeOf = (sandbox: object): object => {
      let scope = scopes.get(sandbox);
      if (!scope) {
        scope = new Proxy(sandbox, {
          has: (target, key) => key !== Symbol.unscopables && (key === "globalThis" || Reflect.has(target, key)),
          get: (target, key, receiver) => {
            if (key === Symbol.unscopables) return undefined;
            if (key === "globalThis" && !Reflect.has(target, key)) return target;
            return Reflect.get(target, key, receiver);
          },
        });
        scopes.set(sandbox, scope);
      }
      return scope;
    };
    // Sloppy mode on purpose: `with` is a SyntaxError in strict code, and it is what makes the sandbox the scope.
    const evalInSandbox = new Function("__wcvm_scope", "__wcvm_code", "with (__wcvm_scope) { return eval(__wcvm_code); }") as (scope: object, code: string) => unknown;
    const runInContext = (code: string, contextifiedObject: object, options?: IRunOptions) => {
      if (!isContext(contextifiedObject)) {
        throw new (ctx.requireBuiltin("internal/errors").codes.ERR_INVALID_ARG_TYPE)("contextifiedObject", "vm.Context", contextifiedObject);
      }
      // `this` at the top level is the sandbox too.
      return evalInSandbox.call(contextifiedObject, scopeOf(contextifiedObject), withSourceUrl(code, options));
    };
    const runInNewContext = (code: string, contextObject?: object, options?: IRunOptions) =>
      runInContext(code, createContext(contextObject), options);

    class Script {
      private code: string;
      private options?: IRunOptions;
      cachedDataRejected?: boolean;
      sourceMapURL: string | undefined;
      constructor(code: string, options?: IRunOptions | string) {
        this.code = String(code);
        this.options = typeof options === "string" ? { filename: options } : options;
      }
      runInThisContext(options?: IRunOptions) {
        return runInThisContext(this.code, { ...this.options, ...options });
      }
      runInContext(contextifiedObject: object, options?: IRunOptions) {
        return runInContext(this.code, contextifiedObject, { ...this.options, ...options });
      }
      runInNewContext(contextObject?: object, options?: IRunOptions) {
        return runInNewContext(this.code, contextObject, { ...this.options, ...options });
      }
      createCachedData() {
        return ctx.requireBuiltin("buffer").Buffer.alloc(0);
      }
    }

    /** `vm.compileFunction(body, params)`: a function whose scope is this realm's global. */
    const compileFunction = (code: string, params: string[] = [], options?: IRunOptions) =>
      new Function(...params, withSourceUrl(code, options));

    module.exports = {
      Script,
      createContext,
      isContext,
      runInContext,
      runInNewContext,
      runInThisContext,
      compileFunction,
      constants: { USE_MAIN_CONTEXT_DEFAULT_LOADER: Symbol("vm_dynamic_import_main_context_default"), DONT_CONTEXTIFY: Symbol("vm_context_no_contextify") },
    };
  };

  /**
   * cluster.js (real multi-process load balancing over a real fork()) isn't vendored: this
   * sandbox has one process per net.Server, never several sharing a listen port, so there's
   * nothing to balance. net.js's Server.listen() checks `cluster.isPrimary` unconditionally
   * (even for a script that never touched cluster itself) before setting up the real listen -
   * always true here, matching a plain, non-clustered Node process exactly (not an approximation).
   */
  const clusterShim: BuiltinFactory = (_exports, _require, module) => {
    module.exports = { isPrimary: true, isMaster: true, isWorker: false };
  };

  /**
   * crypto.js (real Node's) unconditionally requires ~15 internal modules just to be
   * require()-able at all (cipher, sig, hash, x509, certificate, kem, webcrypto, random, argon2,
   * pbkdf2, scrypt, hkdf, keygen, keys, diffiehellman) - most needing native-crypto features
   * (KeyObject/PEM export, X.509 certificates, DiffieHellman groups, scrypt, argon2) the Web
   * Crypto API this sandbox would have to back them with simply has no equivalent for. This
   * sandbox's actual need (real npm/pacote's sha512/sha1 package integrity checks) is narrow, so
   * `crypto` is a small hand-written module instead, not vendored source: `createHash`/`Hash`
   * (backed by SubtleCrypto.digest() - real, native, already available - via the same
   * kernel-mediated sync bridge zlib's own `*Sync` family uses, since `Hash.digest()` is
   * synchronous but `SubtleCrypto.digest()` isn't) plus `randomBytes`/`randomUUID` (already
   * synchronous - `crypto.getRandomValues()`/`crypto.randomUUID()` are real globals here too, no
   * bridging needed at all). Everything else (ciphers, DiffieHellman, X.509 certificates,
   * KeyObject, ...) is simply absent - requiring it throws a plain "is not a
   * function"/"is not a constructor", the same honest failure shape `zlib.ts`'s own missing
   * Brotli/Zstd support has.
   */
  const cryptoShim: BuiltinFactory = (_exports, require, module, process, internalBinding) => {
    // Hashing is plain JS, synchronous, in this thread (bindings/hash.ts via internalBinding
    // ('crypto')): md5, sha1, sha224/256, sha384/512 - no sha3-*/blake2*/md4.
    const { createHasher, hashAlgorithms } = internalBinding("crypto");
    const { codes } = require("internal/errors");
    const kHasher = Symbol("kHasher");

    // The sandbox's OWN Buffer (bindings/buffer.ts), not a real Node/platform one - same
    // "require the vendored module to get its class" pattern childProcess.ts's own exec()/
    // execFile() output already uses.
    const toBytes = (data: unknown, inputEncoding?: string): Uint8Array => {
      if (typeof data === "string") return new Uint8Array(require("buffer").Buffer.from(data, inputEncoding ?? "utf8"));
      if (ArrayBuffer.isView(data)) return new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
      throw new codes.ERR_INVALID_ARG_TYPE("data", ["string", "Buffer", "TypedArray", "DataView"], data);
    };

    const finalized = () => new codes.ERR_CRYPTO_HASH_FINALIZED();

    class Hash {
      algorithm: string;
      [kHasher]: { update(data: Uint8Array): void; digest(): Uint8Array; copy(): unknown } | null;

      constructor(algorithm: string, hasher?: Hash[typeof kHasher]) {
        const created = hasher ?? createHasher(algorithm);
        // Real Node's own message (OpenSSL's), with no `code` either.
        if (!created) throw new Error("Digest method not supported");
        this.algorithm = algorithm;
        this[kHasher] = created;
      }

      update(data: unknown, inputEncoding?: string) {
        if (!this[kHasher]) throw finalized();
        this[kHasher].update(toBytes(data, inputEncoding));
        return this;
      }

      digest(encoding?: string) {
        if (!this[kHasher]) throw finalized();
        const bytes = this[kHasher].digest();
        this[kHasher] = null;
        const result = require("buffer").Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
        return encoding && encoding !== "buffer" ? result.toString(encoding) : result;
      }

      copy() {
        if (!this[kHasher]) throw finalized();
        return new Hash(this.algorithm, this[kHasher].copy() as Hash[typeof kHasher]);
      }
    }

    const createHash = (algorithm: string) => new Hash(algorithm);

    // crypto.getRandomValues() caps out at 65536 bytes per call (the Web Crypto spec's own
    // limit, QuotaExceededError beyond it), so anything bigger is filled a slice at a time.
    const QUOTA = 65536;
    const fillRandom = (bytes: Uint8Array) => {
      for (let offset = 0; offset < bytes.length; offset += QUOTA) platform.crypto.getRandomValues(bytes.subarray(offset, offset + QUOTA));
    };
    const viewOf = (buffer: ArrayBuffer | ArrayBufferView): Uint8Array =>
      buffer instanceof ArrayBuffer ? new Uint8Array(buffer) : new Uint8Array(buffer.buffer, buffer.byteOffset, buffer.byteLength);

    const randomBytes = (size: number, callback?: (error: Error | null, buffer?: unknown) => void) => {
      const bytes = new Uint8Array(size);
      fillRandom(bytes);
      const result = require("buffer").Buffer.from(bytes.buffer);
      if (!callback) return result;
      process.nextTick(() => callback(null, result));
      return undefined;
    };

    const randomFillSync = (buffer: ArrayBuffer | ArrayBufferView, offset = 0, size?: number) => {
      const view = viewOf(buffer);
      const length = size ?? view.length - offset;
      if (offset < 0 || offset > view.length) throw new codes.ERR_OUT_OF_RANGE("offset", `>= 0 && <= ${view.length}`, offset);
      if (length < 0 || offset + length > view.length) throw new codes.ERR_OUT_OF_RANGE("size + offset", `<= ${view.length}`, offset + length);
      fillRandom(view.subarray(offset, offset + length));
      return buffer;
    };

    /** randomFill(buffer[, offset[, size]], callback) */
    const randomFill = (buffer: ArrayBuffer | ArrayBufferView, ...rest: unknown[]) => {
      const callback = rest.pop() as (error: Error | null, buffer?: unknown) => void;
      randomFillSync(buffer, ...(rest as [number?, number?]));
      process.nextTick(() => callback(null, buffer));
    };

    const timingSafeEqual = (a: ArrayBuffer | ArrayBufferView, b: ArrayBuffer | ArrayBufferView): boolean => {
      const x = viewOf(a);
      const y = viewOf(b);
      // Thrown from C++ in real Node, so not in internal/errors' own table - built to match.
      if (x.length !== y.length) {
        throw Object.assign(new RangeError("Input buffers must have the same byte length"), { code: "ERR_CRYPTO_TIMING_SAFE_EQUAL_LENGTH" });
      }
      let difference = 0;
      for (let i = 0; i < x.length; i++) difference |= x[i] ^ y[i];
      return difference === 0;
    };

    /** Node 21.7+'s one-shot `crypto.hash(algorithm, data[, outputEncoding = "hex"])`. */
    const hash = (algorithm: string, data: unknown, outputEncoding = "hex") => {
      const digest = createHash(algorithm).update(data).digest();
      return outputEncoding === "buffer" ? digest : digest.toString(outputEncoding);
    };

    module.exports = {
      createHash,
      Hash,
      hash,
      getHashes: () => [...hashAlgorithms],
      randomBytes,
      randomFill,
      randomFillSync,
      randomUUID: (): string => platform.crypto.randomUUID(),
      getRandomValues: (array: Uint8Array) => platform.crypto.getRandomValues(array),
      timingSafeEqual,
      // The Web Crypto API itself - here, literally the platform's own.
      webcrypto: platform.crypto,
      subtle: platform.crypto.subtle,
    };
  };

  /**
   * `tls`/`https` need a real TLS stack (OpenSSL behind a raw socket), which this sandbox has
   * neither of: its sockets are virtual, and the Web Crypto API can't secure a stream. Real Node
   * built without OpenSSL throws ERR_NO_CRYPTO the moment either module is required - but here
   * they must still LOAD: plenty of code imports them unconditionally and only reaches for TLS on
   * an opt-in path (Vite: only with `server.https` set). So both load, report nothing to offer
   * (no ciphers, no root certificates), and throw real Node's own ERR_NO_CRYPTO from anything that
   * would actually need TLS. `https.Agent` stays constructible - libraries build one at load time.
   */
  const tlsShim: BuiltinFactory = (_exports, _require, module) => {
    const { codes } = ctx.requireBuiltin("internal/errors");
    const net = ctx.requireBuiltin("net");
    const noCrypto = () => {
      throw new codes.ERR_NO_CRYPTO();
    };
    class TLSSocket extends net.Socket {
      constructor() {
        super();
        noCrypto();
      }
    }
    class Server extends net.Server {
      constructor() {
        super();
        noCrypto();
      }
    }
    class SecureContext {
      constructor() {
        noCrypto();
      }
    }
    module.exports = {
      CLIENT_RENEG_LIMIT: 3,
      CLIENT_RENEG_WINDOW: 600,
      DEFAULT_CIPHERS: "",
      DEFAULT_ECDH_CURVE: "auto",
      DEFAULT_MIN_VERSION: "TLSv1.2",
      DEFAULT_MAX_VERSION: "TLSv1.3",
      rootCertificates: Object.freeze([]),
      getCiphers: () => [],
      getCACertificates: () => [],
      setDefaultCACertificates: noCrypto,
      checkServerIdentity: noCrypto,
      convertALPNProtocols: noCrypto,
      createSecureContext: noCrypto,
      createSecurePair: noCrypto,
      connect: noCrypto,
      createServer: noCrypto,
      SecureContext,
      TLSSocket,
      Server,
    };
  };

  const httpsShim: BuiltinFactory = (_exports, _require, module) => {
    const { codes } = ctx.requireBuiltin("internal/errors");
    const http = ctx.requireBuiltin("http");
    const tls = ctx.requireBuiltin("tls");
    const noCrypto = () => {
      throw new codes.ERR_NO_CRYPTO();
    };
    class Agent extends http.Agent {
      constructor(options?: Record<string, unknown>) {
        super(options);
        this.defaultPort = 443;
        this.protocol = "https:";
      }
    }
    module.exports = {
      Agent,
      globalAgent: new Agent({ keepAlive: true, scheduling: "lifo", timeout: 5000 }),
      Server: tls.Server,
      createServer: noCrypto,
      request: noCrypto,
      get: noCrypto,
    };
  };

  /**
   * `http2` is real Node's nghttp2 binding (C++), with nothing here to put behind it. Like `tls`,
   * it must still LOAD - bundled code requires it at module init and only uses it on an opt-in
   * path (Vite's proxy: only for an `ssl` target) - so it does, with the constants callers read,
   * and every entry point throws: ERR_NO_CRYPTO for the TLS ones (as a Node without OpenSSL would),
   * ERR_METHOD_NOT_IMPLEMENTED for cleartext h2c.
   */
  const http2Shim: BuiltinFactory = (_exports, _require, module) => {
    const { codes } = ctx.requireBuiltin("internal/errors");
    const notImplemented = (name: string) => () => {
      throw new codes.ERR_METHOD_NOT_IMPLEMENTED(`http2.${name}()`);
    };
    const noCrypto = () => {
      throw new codes.ERR_NO_CRYPTO();
    };
    const pseudo = { HTTP2_HEADER_STATUS: ":status", HTTP2_HEADER_METHOD: ":method", HTTP2_HEADER_AUTHORITY: ":authority", HTTP2_HEADER_SCHEME: ":scheme", HTTP2_HEADER_PATH: ":path", HTTP2_HEADER_PROTOCOL: ":protocol" };
    // Not constructible in any useful way (no server ever hands one out), but real - and importable by
    // name: Astro's node adapter does `import { Http2ServerResponse } from "node:http2"` for an
    // `instanceof` check, and an ESM named import of a missing export is a link-time SyntaxError.
    const { Readable, Stream } = ctx.requireBuiltin("stream");
    class Http2ServerRequest extends Readable {}
    class Http2ServerResponse extends Stream {}
    module.exports = {
      Http2ServerRequest,
      Http2ServerResponse,
      constants: { ...pseudo, HTTP2_HEADER_CONTENT_TYPE: "content-type", HTTP2_HEADER_CONTENT_LENGTH: "content-length", HTTP2_METHOD_GET: "GET", HTTP2_METHOD_POST: "POST", NGHTTP2_NO_ERROR: 0, NGHTTP2_CANCEL: 8 },
      sensitiveHeaders: Symbol.for("nodejs.http2.sensitiveHeaders"),
      createServer: notImplemented("createServer"),
      createSecureServer: noCrypto,
      connect: notImplemented("connect"),
      getDefaultSettings: () => ({}),
      getPackedSettings: notImplemented("getPackedSettings"),
      getUnpackedSettings: notImplemented("getUnpackedSettings"),
      performServerHandshake: notImplemented("performServerHandshake"),
    };
  };

  /**
   * `inspector`: loads, but there is never a V8 inspector behind it - reachable from a Worker or not.
   * It used to throw `ERR_INSPECTOR_NOT_AVAILABLE` on require, like a Node built `--without-inspector`
   * (a build almost nobody runs), which broke a module that real Node always loads: Next.js's
   * `console-dim.external.js` does `require("node:inspector")` unguarded and then asks `inspector.url()`
   * whether a debugger is attached. Real Node with no debugger attached answers `undefined` to that, so
   * this does too; everything that needs an actual inspector (`open`, `waitForDebugger`,
   * `Session#connect`) fails with `ERR_INSPECTOR_NOT_AVAILABLE`, the same error as before, but at the
   * call that needs it rather than at require. A caller that guards its require in a try/catch still
   * ends up on the right path, because the first thing it does with the result fails.
   */
  const makeInspector = (promises: boolean) => {
    const { EventEmitter } = ctx.requireBuiltin("events");
    const { codes } = ctx.requireBuiltin("internal/errors");
    const unavailable = () => {
      throw new codes.ERR_INSPECTOR_NOT_AVAILABLE();
    };
    class Session extends EventEmitter {
      connect() {
        return unavailable();
      }
      connectToMainThread() {
        return unavailable();
      }
      disconnect() {}
      post() {
        if (promises) return Promise.reject(new codes.ERR_INSPECTOR_NOT_CONNECTED());
        throw new codes.ERR_INSPECTOR_NOT_CONNECTED();
      }
    }
    return {
      Session,
      open: unavailable,
      close: () => {},
      url: () => undefined,
      waitForDebugger: unavailable,
      console: ctx.requireBuiltin("console"),
      Network: {},
    };
  };
  const inspectorShim: BuiltinFactory = (_exports, _require, module) => {
    module.exports = makeInspector(false);
  };
  const inspectorPromisesShim: BuiltinFactory = (_exports, _require, module) => {
    module.exports = makeInspector(true);
  };

  /**
   * `internal/deps/undici/undici` - Node's bundled fetch/WebSocket client (a 1MB+ dependency, not
   * lib/ code). Vendored modules only ever reach for a few WHATWG classes from it, all of which the
   * browser ships natively: `http.WebSocket`/`CloseEvent`/`MessageEvent` (lazy getters - but an ESM
   * `import { ... } from "node:http"` reads every export, so they must not throw), and
   * `createFastMessageEvent` (internal/worker/io.js builds a MessagePort's event with it whenever
   * an EventTarget-style listener - `addEventListener("message")`, `port.onmessage =` - is used).
   * Undici's own dispatcher/proxy API (`setGlobalDispatcher`, `EnvHttpProxyAgent`) has no
   * counterpart and is simply absent.
   */
  const undiciShim: BuiltinFactory = (_exports, _require, module) => {
    module.exports = {
      WebSocket: platform.WebSocket,
      CloseEvent: platform.CloseEvent,
      MessageEvent: platform.MessageEvent,
      createFastMessageEvent: (type: string, init?: MessageEventInit) => new platform.MessageEvent(type, init),
    };
  };

  /**
   * `stream/web`: the WHATWG streams, which the browser already ships natively. Node's own
   * `lib/stream/web.js` re-exports 17 classes from `internal/webstreams/*` - a second, parallel
   * implementation (with worker-transfer plumbing in `internal/worker/io`) that would make
   * `require("stream/web").ReadableStream !== ReadableStream`; here they are the same objects, as in
   * Node. Next.js's edge-runtime primitives, Astro, undici and others `require("stream/web")` at load.
   */
  const streamWebShim: BuiltinFactory = (_exports, _require, module) => {
    module.exports = { ...platform.webStreams };
  };

  return {
    "stream/web": streamWebShim,
    "internal/webstreams/adapters": createWebStreamAdaptersShim(
      platform.webStreams as { ReadableStream: typeof ReadableStream; WritableStream: typeof WritableStream },
      ctx.requireBuiltin,
    ),
    "internal/deps/undici/undici": undiciShim,
    // No V8 PromiseHooks in a Worker; see asyncContext.ts for what stands in.
    "internal/promise_hooks": promiseHooksShim,
    "internal/async_local_storage/async_hooks": asyncLocalStorageShim,
    tls: tlsShim,
    https: httpsShim,
    http2: http2Shim,
    inspector: inspectorShim,
    "inspector/promises": inspectorPromisesShim,
    "internal/blob": internalBlob,
    "internal/encoding": internalEncoding,
    "internal/url": internalUrl,
    dns: dnsShim,
    "dns/promises": (_exports, _require, module) => {
      module.exports = ctx.requireBuiltin("dns").promises;
    },
    cluster: clusterShim,
    crypto: cryptoShim,
    v8: v8Shim,
    vm: vmShim,
    "internal/bootstrap/realm": (_exports, _require, module) => {
      module.exports = {
        BuiltinModule,
        internalBinding: ctx.internalBinding,
        require: ctx.requireBuiltin,
      };
    },
  };
};

export { createShims };

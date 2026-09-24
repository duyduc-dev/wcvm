import type { BuiltinFactory } from "./node/types";

interface IShimContext {
  has(id: string): boolean;
  requireBuiltin(id: string): any;
  internalBinding(name: string): any;
}

// Modules that only exist under a `node:` scheme (never loadable bare).
const SCHEME_ONLY = ["sea", "sqlite", "test", "test/reporters"];

const stripScheme = (id: string) => (id.startsWith("node:") ? id.slice(5) : id);

/**
 * Hand-written stand-ins, for two different reasons:
 *  - Node modules that are part of Node's C++ bootstrap rather than its `lib/`, so they cannot
 *    be vendored verbatim at all (`internal/url`, `internal/encoding`, `internal/blob`,
 *    `v8`). (`internal/perf/observe` used to be one too; it's the real vendored module now, over
 *    bindings/performance.ts, since `perf_hooks` needs a real PerformanceObserver.)
 *  - Real, vendorable `lib/` modules this sandbox deliberately answers with a fixed, simplified,
 *    or narrower result instead of fully implementing: `dns`/`cluster` because there's nothing
 *    real behind them to report; `tls`/`https`/`inspector` because there's no TLS stack or V8
 *    inspector to put behind them (they load, and fail with real Node's own error on use); `crypto` because real Node's own `crypto.js` needs a much bigger
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
    const URLCtor = globalThis.URL;
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
      const url = new URLCtor("file://");
      url.pathname = resolved.replace(/%/g, "%25").replace(/\\/g, "%5C").replace(/\n/g, "%0A")
        .replace(/\r/g, "%0D").replace(/\t/g, "%09").replace(/\?/g, "%3F").replace(/#/g, "%23");
      return url;
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
    module.exports = { lookup, ADDRCONFIG: 0, ALL: 0, V4MAPPED: 0 };
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
    module.exports = { DefaultSerializer, DefaultDeserializer, serialize: notImplemented, deserialize: notImplemented };
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
    // SubtleCrypto.digest() supports exactly these four - no md5, sha224, sha3-*, blake2*, etc.;
    // unsupported by the platform API itself, not a choice made here.
    const WEB_CRYPTO_ALGORITHM: Record<string, string> = {
      sha1: "SHA-1",
      sha256: "SHA-256",
      sha384: "SHA-384",
      sha512: "SHA-512",
    };

    const concatBytes = (parts: Uint8Array[]): Uint8Array => {
      const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
      let offset = 0;
      for (const part of parts) {
        out.set(part, offset);
        offset += part.length;
      }
      return out;
    };

    // The sandbox's OWN Buffer (bindings/buffer.ts), not a real Node/platform one - same
    // "require the vendored module to get its class" pattern childProcess.ts's own exec()/
    // execFile() output already uses.
    const toBytes = (data: unknown, inputEncoding?: string): Uint8Array => {
      if (typeof data === "string") return new Uint8Array(require("buffer").Buffer.from(data, inputEncoding ?? "utf8"));
      if (data instanceof Uint8Array) return data;
      throw new TypeError("crypto: Hash.update() expects a string, Buffer, or TypedArray");
    };

    class Hash {
      algorithm: string;
      chunks: Uint8Array[] = [];

      constructor(algorithm: string) {
        const normalized = algorithm.toLowerCase();
        if (!WEB_CRYPTO_ALGORITHM[normalized]) {
          throw new Error(`crypto.createHash: unsupported digest algorithm '${algorithm}' (supported: ${Object.keys(WEB_CRYPTO_ALGORITHM).join(", ")})`);
        }
        this.algorithm = normalized;
      }

      update(data: unknown, inputEncoding?: string) {
        this.chunks.push(toBytes(data, inputEncoding));
        return this;
      }

      digest(encoding?: string) {
        const input = concatBytes(this.chunks);
        const bytes = internalBinding("crypto").digestSync(WEB_CRYPTO_ALGORITHM[this.algorithm], input);
        const result = require("buffer").Buffer.from(bytes);
        return encoding ? result.toString(encoding) : result;
      }
    }

    const createHash = (algorithm: string) => new Hash(algorithm);

    // crypto.getRandomValues() caps out at 65536 bytes per call (the Web Crypto spec's own
    // limit, QuotaExceededError beyond it) - real npm/pacote only ever need small nonces/tokens,
    // so this isn't chunked; revisit if a real caller ever needs more.
    const randomBytes = (size: number, callback?: (error: Error | null, buffer?: unknown) => void) => {
      const bytes = new Uint8Array(size);
      crypto.getRandomValues(bytes);
      const result = require("buffer").Buffer.from(bytes);
      if (!callback) return result;
      process.nextTick(() => callback(null, result));
      return undefined;
    };

    const randomUUID = (): string => crypto.randomUUID();

    module.exports = { createHash, Hash, randomBytes, randomUUID };
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

  /** Real Node built without the inspector (`--without-inspector`) throws this on require; there's
   *  no V8 inspector protocol reachable from inside a Worker here either. */
  const inspectorShim: BuiltinFactory = () => {
    throw new (ctx.requireBuiltin("internal/errors").codes.ERR_INSPECTOR_NOT_AVAILABLE)();
  };

  return {
    tls: tlsShim,
    https: httpsShim,
    inspector: inspectorShim,
    "inspector/promises": inspectorShim,
    "internal/blob": internalBlob,
    "internal/encoding": internalEncoding,
    "internal/url": internalUrl,
    dns: dnsShim,
    cluster: clusterShim,
    crypto: cryptoShim,
    v8: v8Shim,
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

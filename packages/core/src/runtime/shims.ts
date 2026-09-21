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
 * Hand-written stand-ins for the few Node modules that are part of Node's C++
 * bootstrap rather than its `lib/` (so they cannot be vendored verbatim).
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

    module.exports = {
      URL: URLCtor,
      URLSearchParams: URLSearchParamsCtor,
      isURL,
      fileURLToPath,
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

  return {
    "internal/blob": internalBlob,
    "internal/encoding": internalEncoding,
    "internal/url": internalUrl,
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

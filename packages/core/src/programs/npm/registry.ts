// The npm registry, over the browser's real fetch(): packuments (a package's list of versions and
// their manifests) and tarballs. The registry answers `Access-Control-Allow-Origin: *` on both,
// so a CORS-mode fetch passes this page's own COEP `require-corp` - checked against the real
// registry.npmjs.org. Everything platform-specific (fetch, SubtleCrypto, DecompressionStream) is
// injected: a Process Worker's own globals can be replaced by Node's once a `node` program has run
// in the same worker (see CLAUDE.md's "never call a global by its bare name" gotcha), and tests
// substitute an in-memory registry.

export interface IManifest {
  name: string;
  version: string;
  dependencies?: Record<string, string>;
  optionalDependencies?: Record<string, string>;
  peerDependencies?: Record<string, string>;
  peerDependenciesMeta?: Record<string, { optional?: boolean }>;
  bundleDependencies?: string[] | boolean;
  bundledDependencies?: string[] | boolean;
  os?: string[];
  cpu?: string[];
  deprecated?: string;
  hasInstallScript?: boolean;
  dist: { tarball: string; integrity?: string; shasum?: string };
}

export interface IPackument {
  name: string;
  "dist-tags": Record<string, string>;
  versions: Record<string, IManifest>;
}

export class NpmError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = "NpmError";
    this.code = code;
  }
}

export interface IRegistryDeps {
  fetch: typeof fetch;
  subtle: SubtleCrypto;
  DecompressionStream: typeof DecompressionStream;
}

export interface IRegistryClient {
  /** Cached per name, so a package required from many places is fetched once. */
  packument(name: string): Promise<IPackument>;
  /** Downloads, integrity-checks and gunzips a tarball: resolves to the raw tar bytes. */
  tarball(manifest: IManifest): Promise<Uint8Array>;
}

export const DEFAULT_REGISTRY = "https://registry.npmjs.org/";

// The abbreviated ("corgi") packument: every field an installer needs, a fraction of the size.
// A CORS-safelisted Accept value, so no preflight either.
const PACKUMENT_ACCEPT = "application/vnd.npm.install-v1+json; q=1.0, application/json; q=0.8, */*";

/** `@scope/name` keeps its `@` but escapes the `/`, like npm's own registry client. */
const packumentUrl = (registry: string, name: string): string =>
  `${registry.endsWith("/") ? registry : `${registry}/`}${name.startsWith("@") ? `@${encodeURIComponent(name.slice(1))}` : encodeURIComponent(name)}`;

const base64 = (bytes: Uint8Array): string => btoa(Array.from(bytes, (b) => String.fromCodePoint(b)).join(""));
const hex = (bytes: Uint8Array): string => Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");

const SRI_ALGORITHMS: Record<string, string> = { sha512: "SHA-512", sha384: "SHA-384", sha256: "SHA-256", sha1: "SHA-1" };

export const createRegistryClient = (registry: string, deps: IRegistryDeps): IRegistryClient => {
  const packuments = new Map<string, Promise<IPackument>>();

  /** Straight through the stream's own reader/writer - no Blob/Response, whose globals a `node`
   *  program run earlier in this same worker may have replaced. */
  const gunzip = async (gzipped: Uint8Array): Promise<Uint8Array> => {
    const stream = new deps.DecompressionStream("gzip");
    const writer = stream.writable.getWriter();
    const writing = writer.write(gzipped as Uint8Array<ArrayBuffer>).then(() => writer.close());
    writing.catch(() => {}); // surfaced by the read side (and awaited below) - never unhandled
    const reader = stream.readable.getReader();
    const chunks: Uint8Array[] = [];
    let length = 0;
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      chunks.push(value);
      length += value.length;
    }
    await writing;
    const out = new Uint8Array(length);
    let offset = 0;
    for (const chunk of chunks) {
      out.set(chunk, offset);
      offset += chunk.length;
    }
    return out;
  };

  const get = async (url: string, accept: string, what: string): Promise<Response> => {
    let response: Response;
    try {
      response = await deps.fetch(url, { headers: { accept } });
    } catch (error) {
      throw new NpmError("ENETWORK", `request to ${url} failed: ${error instanceof Error ? error.message : String(error)}`);
    }
    if (response.status === 404) throw new NpmError("E404", `${what} not found: ${url}`);
    if (!response.ok) throw new NpmError(`E${response.status}`, `${response.status} ${response.statusText} - GET ${url}`);
    return response;
  };

  const packument = (name: string): Promise<IPackument> => {
    let cached = packuments.get(name);
    if (!cached) {
      cached = get(packumentUrl(registry, name), PACKUMENT_ACCEPT, `'${name}' is not in this registry;`).then((r) => r.json() as Promise<IPackument>);
      packuments.set(name, cached);
    }
    return cached;
  };

  const verify = async (manifest: IManifest, bytes: Uint8Array) => {
    const { integrity, shasum } = manifest.dist;
    // SRI: space-separated `<algo>-<base64>`; any one supported match is enough (strongest first).
    const candidates = (integrity ?? "")
      .split(/\s+/)
      .map((entry) => /^(sha\d+)-(.+)$/.exec(entry))
      .filter((m): m is RegExpExecArray => m !== null && m[1] in SRI_ALGORITHMS)
      .sort((a, b) => Number(b[1].slice(3)) - Number(a[1].slice(3)));
    if (candidates.length) {
      const [, algorithm] = candidates[0];
      const actual = base64(new Uint8Array(await deps.subtle.digest(SRI_ALGORITHMS[algorithm], bytes as Uint8Array<ArrayBuffer>)));
      const expected = candidates.filter((c) => c[1] === algorithm).map((c) => c[2]);
      if (!expected.includes(actual)) {
        throw new NpmError("EINTEGRITY", `${manifest.name}@${manifest.version}: ${algorithm} integrity check failed (wanted ${expected[0]}, got ${actual})`);
      }
      return;
    }
    if (shasum) {
      const actual = hex(new Uint8Array(await deps.subtle.digest("SHA-1", bytes as Uint8Array<ArrayBuffer>)));
      if (actual !== shasum.toLowerCase()) throw new NpmError("EINTEGRITY", `${manifest.name}@${manifest.version}: shasum check failed (wanted ${shasum}, got ${actual})`);
    }
  };

  const tarball = async (manifest: IManifest): Promise<Uint8Array> => {
    const response = await get(manifest.dist.tarball, "*/*", `tarball for ${manifest.name}@${manifest.version}`);
    const gzipped = new Uint8Array(await response.arrayBuffer());
    await verify(manifest, gzipped);
    try {
      return await gunzip(gzipped);
    } catch (error) {
      throw new NpmError("EGUNZIP", `${manifest.name}@${manifest.version}: tarball is not valid gzip (${error instanceof Error ? error.message : String(error)})`);
    }
  };

  return { packument, tarball };
};

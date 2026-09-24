// An in-memory npm registry for tests: real packuments (the abbreviated shape the installer asks
// for), real gzipped tarballs (`package/`-prefixed, like `npm pack` makes) and real sha512
// integrity values - served through a fake `fetch` that records every URL it was asked for.

import nodeCrypto from "node:crypto";
import { gzipSync } from "node:zlib";
import type { IRegistryDeps } from "../programs/npm/registry";
import { tarArchive, tarEntry } from "./tarWriter";

export const FAKE_REGISTRY = "https://registry.test/";

export interface IFakeVersion {
  files?: Record<string, string>;
  dependencies?: Record<string, string>;
  optionalDependencies?: Record<string, string>;
  peerDependencies?: Record<string, string>;
  peerDependenciesMeta?: Record<string, { optional?: boolean }>;
  bin?: string | Record<string, string>;
  os?: string[];
  cpu?: string[];
  deprecated?: string;
  hasInstallScript?: boolean;
  /** Serve a tarball that doesn't match its advertised integrity. */
  corrupt?: boolean;
  /** Any other package.json fields (`type`, `exports`, `main`, ...). */
  packageJson?: Record<string, unknown>;
}

export interface IFakePackage {
  versions: Record<string, IFakeVersion>;
  "dist-tags"?: Record<string, string>;
}

const packumentPath = (name: string) => (name.startsWith("@") ? `@${encodeURIComponent(name.slice(1))}` : encodeURIComponent(name));

/** `baseUrl` is where the registry claims to live - tarball URLs in its packuments point there. */
export const createFakeRegistry = (packages: Record<string, IFakePackage>, baseUrl = FAKE_REGISTRY) => {
  const requests: string[] = [];
  const tarballs = new Map<string, Uint8Array>();
  const packuments = new Map<string, unknown>();

  for (const [name, pkg] of Object.entries(packages)) {
    const versions: Record<string, unknown> = {};
    for (const [version, spec] of Object.entries(pkg.versions)) {
      const { files = {}, corrupt, packageJson: extraFields, ...manifestFields } = spec;
      const packageJson = { name, version, ...manifestFields, ...extraFields };
      const entries = [
        ...Object.entries(files).map(([path, contents]) => tarEntry({ name: `package/${path}`, data: contents, mode: path.startsWith("bin/") ? 0o755 : 0o644 })),
        tarEntry({ name: "package/package.json", data: JSON.stringify(packageJson) }),
      ];
      const tgz = new Uint8Array(gzipSync(tarArchive(entries)));
      const url = `${baseUrl}${name}/-/${name.split("/").pop()}-${version}.tgz`;
      tarballs.set(url, corrupt ? tgz.map((b, i) => (i === tgz.length - 10 ? b ^ 0xff : b)) : tgz);
      const integrity = `sha512-${nodeCrypto.createHash("sha512").update(tgz).digest("base64")}`;
      versions[version] = { ...packageJson, dist: { tarball: url, integrity } };
    }
    const latest = Object.keys(pkg.versions).at(-1)!;
    packuments.set(`${baseUrl}${packumentPath(name)}`, { name, "dist-tags": { latest, ...pkg["dist-tags"] }, versions });
  }

  const fetch = (async (input: RequestInfo | URL) => {
    const url = String(input);
    requests.push(url);
    const packument = packuments.get(url);
    if (packument) return new Response(JSON.stringify(packument), { headers: { "content-type": "application/vnd.npm.install-v1+json" } });
    const tarball = tarballs.get(url);
    if (tarball) return new Response(tarball as Uint8Array<ArrayBuffer>);
    return new Response("not found", { status: 404, statusText: "Not Found" });
  }) as typeof globalThis.fetch;

  const deps: IRegistryDeps = { fetch, subtle: crypto.subtle, DecompressionStream };
  return { deps, requests };
};

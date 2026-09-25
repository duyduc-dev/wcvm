// `npm create <name>` / `npm init <name>`: real npm's own package-name mangling (npm-init(1)) to
// resolve a package like `create-vite`, fetches JUST that one package (no dependency tree - most
// create-* tools, including create-vite itself, bundle everything into one file and declare zero
// runtime dependencies of their own) and caches it under a scratch dir keyed by name+version (a
// repeat `npm create vite` doesn't re-download), then hands back the real path to its own `bin`
// entry for the caller to run through `node` - the same "npx <pkg>" idea real npm's own `npm
// exec`/libnpmexec implements, scoped down to just this one case.

import type { IFsClient } from "../../fs/fsClient";
import { extract, parseCommandLineSpec, pickVersion, readJson } from "./install";
import { NpmError, type IRegistryClient } from "./registry";

const join = (...parts: string[]): string => parts.join("/").replaceAll(/\/+/g, "/");

/** Deliberately outside any project directory: a fetched create-<x> (or init-<x>) package is a
 *  one-off tool, not a project dependency. Not under `/tmp` - this sandbox's VFS has no real
 *  multi-user/shared-tmp semantics to mimic (or protect against), so this is just an ordinary,
 *  wcvm-owned root path. */
const CACHE_ROOT = "/.wcvm/npm-exec-cache";

/** Real npm's own `npm create`/`npm init <name>` package-name mangling (`lib/commands/init.js`'s
 *  `execCreate`, checked against real npm 11): a bare scope becomes "<scope>/create"; anything
 *  else gets "create-" inserted right after an optional leading "<scope>/" - even if the name
 *  already starts with "create-" (real npm doesn't special-case that either, so neither do we). */
export const mangleCreateName = (name: string): string => (/^@[^/]+$/.test(name) ? `${name}/create` : name.replace(/^(@[^/]+\/)?/, "$1create-"));

export interface IResolvedBin {
  binPath: string;
  name: string;
  version: string;
}

/** Fetches (or reuses a cached copy of) the package named by `spec` - already mangled; callers
 *  decide whether `mangleCreateName` applies - and returns the real path to its own `bin` entry
 *  (the first one, if it declares more than one - matching how a plain `npx <pkg>` picks). */
export const resolvePackageBin = async (fs: IFsClient, registry: IRegistryClient, spec: string): Promise<IResolvedBin> => {
  const { name, spec: versionSpec } = parseCommandLineSpec(spec);
  const packument = await registry.packument(name);
  const manifest = pickVersion(packument, versionSpec);
  const dir = join(CACHE_ROOT, `${manifest.name.replaceAll("/", "+")}@${manifest.version}`);

  const existing = readJson(fs, join(dir, "package.json"));
  if (existing?.name !== manifest.name || existing?.version !== manifest.version) {
    if (fs.exists(dir)) fs.rm(dir, { recursive: true });
    extract(fs, dir, await registry.tarball(manifest));
  }

  const pkg = readJson(fs, join(dir, "package.json"));
  const bin = pkg?.bin;
  let binRel: string | undefined;
  if (typeof bin === "string") binRel = bin;
  else if (bin) binRel = Object.values(bin as Record<string, string>)[0];
  if (!binRel) throw new NpmError("ENOEXEC", `${manifest.name} has no executable to run (no "bin" in its package.json)`);
  return { binPath: join(dir, binRel), name: manifest.name, version: manifest.version };
};

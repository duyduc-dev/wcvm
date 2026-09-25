// A minimal npm installer: resolve a dependency tree from the registry, lay it out in node_modules
// the way Node's own resolution will find it, download/verify/extract each package, link bins, and
// save any newly named packages to package.json. Deliberately NOT real npm (see PLAN.md Phase 7's
// "Real npm: feasibility findings"): no lockfile, no install scripts, no workspaces/git/file specs.
//
// Layout (npm v3+-style hoisting, breadth-first): a dependency of package P is looked up the way
// Node would look it up from P's own directory - P's node_modules, then its parent's, and so on to
// the root. The nearest copy found that satisfies the range is reused; a nearest copy that DOESN'T
// satisfy it means P needs its own, nested under P; no copy anywhere means it's hoisted to the
// root. Breadth-first order makes that safe: anything that ever looked for the same name and found
// nothing would already have hoisted it, so a later hoist can't shadow an earlier resolution.

import type { IFsClient } from "../../fs/fsClient";
import { coversCaret, maxSatisfying, parseRange, parseVersion, satisfies } from "./semver";
import { NpmError, type IManifest, type IPackument, type IRegistryClient } from "./registry";
import { untar } from "./tar";

/** What a native package's `os`/`cpu` fields are checked against: the sandbox reports Linux, but
 *  nothing native can ever run in a browser, so no real CPU matches - optional native builds
 *  (`@esbuild/linux-x64`, `@rollup/rollup-linux-x64-gnu`, ...) are skipped rather than downloaded. */
const PLATFORM = { os: "linux", cpu: "wasm32" };

const TARBALL_CONCURRENCY = 8;

export interface IInstallOptions {
  fs: IFsClient;
  cwd: string;
  registry: IRegistryClient;
  /** Packages named on the command line (`npm install vite react@^18`): installed and saved. */
  add: string[];
  saveDev: boolean;
  warn(message: string): void;
}

export interface IInstallResult {
  /** Packages actually downloaded and extracted this run. */
  added: number;
  /** Packages in the resolved tree (including ones already installed). */
  total: number;
  /** Packages with install scripts, which were not run. */
  skippedScripts: string[];
}

interface INode {
  /** Its directory name under node_modules - an alias's own name, not necessarily the real one. */
  name: string;
  manifest: IManifest;
  parent: INode | undefined;
  children: Map<string, INode>;
  dir: string;
  optional: boolean;
}

interface IRequest {
  from: INode;
  name: string;
  spec: string;
  optional: boolean;
  peer: boolean;
}

const join = (...parts: string[]): string => parts.join("/").replaceAll(/\/+/g, "/");
const dirname = (path: string): string => path.slice(0, path.lastIndexOf("/")) || "/";

/** `name@spec` from a command line: `vite`, `vite@7`, `@scope/pkg@^1`, `alias@npm:real@1`. */
export const parseCommandLineSpec = (arg: string): { name: string; spec: string } => {
  const at = arg.indexOf("@", arg.startsWith("@") ? 1 : 0);
  return at === -1 ? { name: arg, spec: "" } : { name: arg.slice(0, at), spec: arg.slice(at + 1) };
};

const UNSUPPORTED_SPEC = /^(?:file:|link:|workspace:|git[+:]|github:|gitlab:|bitbucket:|gist:|https?:|\.{0,2}\/|~\/)|^[^@/\s]+\/[^/\s]+$/;

/** An `npm:real@range` alias names a different package than the directory it's installed as. */
const resolveAlias = (name: string, spec: string): { realName: string; spec: string } => {
  if (UNSUPPORTED_SPEC.test(spec)) throw new NpmError("EUNSUPPORTEDPROTOCOL", `Unsupported dependency spec for ${name}: "${spec}" (only registry versions, ranges, tags and npm: aliases are supported)`);
  if (!spec.startsWith("npm:")) return { realName: name, spec };
  const target = parseCommandLineSpec(spec.slice("npm:".length));
  return { realName: target.name, spec: target.spec };
};

/** The version npm itself would pick: a dist-tag by name; for a range, `latest` if it satisfies,
 *  else the highest satisfying version, preferring ones that aren't deprecated. */
export const pickVersion = (packument: IPackument, spec: string): IManifest => {
  const tags = packument["dist-tags"] ?? {};
  const wanted = spec.trim() || "*";
  if (Object.hasOwn(tags, wanted)) {
    const tagged = packument.versions[tags[wanted]];
    if (tagged) return tagged;
  }
  const range = parseRange(wanted);
  if (!range) throw new NpmError("ETARGET", `No matching version found for ${packument.name}@${spec}: not a version, range or dist-tag.`);
  const latest = tags.latest;
  if (latest && packument.versions[latest] && satisfies(parseVersion(latest)!, range)) return packument.versions[latest];
  const all = Object.keys(packument.versions);
  const best = maxSatisfying(all.filter((v) => !packument.versions[v].deprecated), range) ?? maxSatisfying(all, range);
  if (!best) throw new NpmError("ETARGET", `No matching version found for ${packument.name}@${spec}.`);
  return packument.versions[best];
};

/** Does an `os`/`cpu` list (`["linux"]`, `["!win32"]`) allow `value`? */
const platformAllows = (list: string[] | undefined, value: string): boolean => {
  if (!list?.length) return true;
  if (list.includes(`!${value}`)) return false;
  const positive = list.filter((entry) => !entry.startsWith("!"));
  return positive.length === 0 || positive.includes(value);
};

/** Does the copy already at `node` satisfy `spec` for package `realName`? */
const accepts = (node: INode, realName: string, spec: string, packument: IPackument | undefined): boolean => {
  if (node.manifest.name !== realName) return false;
  const wanted = spec.trim() || "*";
  const tagged = packument?.["dist-tags"]?.[wanted];
  if (tagged !== undefined) return node.manifest.version === tagged;
  const range = parseRange(wanted);
  const version = parseVersion(node.manifest.version);
  return range !== undefined && version !== undefined && satisfies(version, range);
};

export const readJson = (fs: IFsClient, path: string): Record<string, any> | undefined => {
  try {
    return JSON.parse(new TextDecoder().decode(fs.readFile(path)));
  } catch {
    return undefined;
  }
};

const mkdirp = (fs: IFsClient, path: string) => fs.mkdir(path, { recursive: true });

/** The dependencies npm installs for one package: dependencies + optionalDependencies (optional
 *  wins over a plain dependency of the same name) + non-optional peers, minus bundled ones. */
const requestsOf = (from: INode, manifest: Pick<IManifest, "dependencies" | "optionalDependencies" | "peerDependencies" | "peerDependenciesMeta" | "bundleDependencies" | "bundledDependencies">): IRequest[] => {
  const bundled = manifest.bundleDependencies ?? manifest.bundledDependencies;
  const isBundled = (name: string) => bundled === true || (Array.isArray(bundled) && bundled.includes(name));
  const requests = new Map<string, IRequest>();
  for (const [name, spec] of Object.entries(manifest.peerDependencies ?? {})) {
    if (!manifest.peerDependenciesMeta?.[name]?.optional) requests.set(name, { from, name, spec, optional: false, peer: true });
  }
  for (const [name, spec] of Object.entries(manifest.dependencies ?? {})) requests.set(name, { from, name, spec, optional: false, peer: false });
  for (const [name, spec] of Object.entries(manifest.optionalDependencies ?? {})) requests.set(name, { from, name, spec, optional: true, peer: false });
  return [...requests.values()].filter((r) => !isBundled(r.name));
};

const mapLimit = async <T>(items: T[], limit: number, fn: (item: T) => Promise<void>): Promise<void> => {
  let next = 0;
  const worker = async () => {
    while (next < items.length) await fn(items[next++]);
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
};

/** A tarball entry's path inside the package: npm strips the first segment (`package/`) and
 *  refuses anything that would land outside the package's own directory. */
const packagePath = (entryPath: string): string | undefined => {
  const parts = entryPath.split("/").slice(1).filter((part) => part !== "" && part !== ".");
  if (parts.length === 0 || parts.includes("..")) return undefined;
  return parts.join("/");
};

export const extract = (fs: IFsClient, dir: string, tar: Uint8Array) => {
  mkdirp(fs, dir);
  // package.json last: its presence (with the right version) is what marks a package as fully
  // installed for the next run, so an interrupted extraction is never mistaken for a complete one.
  let packageJson: Uint8Array | undefined;
  for (const entry of untar(tar)) {
    const rel = packagePath(entry.path);
    if (rel === undefined) continue;
    const target = join(dir, rel);
    if (entry.type === "directory") {
      mkdirp(fs, target);
      continue;
    }
    if (entry.type !== "file") continue; // links: npm doesn't extract them either
    if (rel === "package.json") {
      packageJson = entry.data;
      continue;
    }
    mkdirp(fs, dirname(target));
    fs.writeFile(target, entry.data);
    fs.chmod(target, entry.mode & 0o111 ? 0o755 : 0o644);
  }
  if (packageJson) fs.writeFile(join(dir, "package.json"), packageJson);
};

const linkBins = (fs: IFsClient, node: INode, warn: (message: string) => void) => {
  const pkg = readJson(fs, join(node.dir, "package.json"));
  if (!pkg?.bin || !node.parent) return;
  const bins: Record<string, string> = typeof pkg.bin === "string" ? { [node.name.split("/").pop()!]: pkg.bin } : pkg.bin;
  const binDir = join(node.parent.dir, "node_modules/.bin");
  mkdirp(fs, binDir);
  for (const [binName, binPath] of Object.entries(bins)) {
    const rel = packagePath(`package/${binPath}`);
    if (!rel || binName.includes("/")) continue;
    const link = join(binDir, binName);
    try {
      fs.lstat(link);
      fs.unlink(link);
    } catch {
      // nothing there yet
    }
    try {
      fs.symlink(`../${node.name}/${rel}`, link);
      fs.chmod(join(node.dir, rel), 0o755);
    } catch (error) {
      warn(`could not link bin ${binName} for ${node.manifest.name}: ${(error as Error).message}`);
    }
  }
};

/** Removes everything in `node`'s own node_modules that isn't in the resolved tree (npm calls
 *  these extraneous), so a leftover from an earlier install can never shadow the version a package
 *  actually needs now. `.bin` is rebuilt from scratch afterwards; other dot-entries (Vite's own
 *  `node_modules/.vite` cache, ...) are left alone. */
const prune = (fs: IFsClient, node: INode) => {
  const modules = join(node.dir, "node_modules");
  const list = (dir: string): string[] => {
    try {
      return fs.readdir(dir);
    } catch {
      return [];
    }
  };
  for (const entry of list(modules)) {
    const path = join(modules, entry);
    if (entry === ".bin") fs.rm(path, { recursive: true });
    else if (entry.startsWith(".")) continue;
    else if (entry.startsWith("@")) {
      for (const scoped of list(path)) if (!node.children.has(`${entry}/${scoped}`)) fs.rm(join(path, scoped), { recursive: true });
    } else if (!node.children.has(entry)) fs.rm(path, { recursive: true });
  }
};

/**
 * package.json `overrides`, npm's flat form only: `"name": "spec"` replaces every TRANSITIVE
 * dependency on `name` (the project's own direct dependencies keep what they say), and `"$name"`
 * means "whatever the project's own dependency on `name` says". The way to swap a native package
 * for its wasm build everywhere in the tree - `"esbuild": "npm:esbuild-wasm@^0.25.0"`,
 * `"rollup": "npm:@rollup/wasm-node@^4"` - which an alias at the root alone can't do: a dependency
 * on `esbuild` doesn't accept a copy whose real name is `esbuild-wasm`, so it would get the native
 * one nested instead (real npm behaves the same). Nested (`"vite": { "esbuild": ... }`) and
 * versioned-key (`"esbuild@0.25"`) forms are warned about and ignored.
 */
const readOverrides = (pkg: Record<string, any>, warn: (message: string) => void): Map<string, string> => {
  const overrides = new Map<string, string>();
  const own = { ...pkg.devDependencies, ...pkg.optionalDependencies, ...pkg.dependencies } as Record<string, string>;
  for (const [key, value] of Object.entries((pkg.overrides ?? {}) as Record<string, unknown>)) {
    if (typeof value !== "string" || key.indexOf("@", key.startsWith("@") ? 1 : 0) !== -1) {
      warn(`ignoring override "${key}": only the flat "name": "spec" form is supported`);
      continue;
    }
    const spec = value.startsWith("$") ? own[value.slice(1)] : value;
    if (spec === undefined) warn(`ignoring override "${key}": ${value} is not one of this project's own dependencies`);
    else overrides.set(key, spec);
  }
  return overrides;
};

/** Breadth-first resolution of the whole tree (see the header comment for the layout rules). */
const resolveTree = async (root: INode, rootRequests: IRequest[], registry: IRegistryClient, warn: (message: string) => void, overrides: Map<string, string>): Promise<INode[]> => {
  // Packuments are requested as soon as a name is seen, so the network works ahead of the
  // (sequential, hence deterministic) placement below; a failure is reported where it's awaited.
  const prefetch = (request: IRequest) => {
    try {
      registry.packument(resolveAlias(request.name, request.spec).realName).catch(() => {});
    } catch {
      // an unsupported spec - reported when it's actually processed
    }
  };
  rootRequests.forEach(prefetch);

  const overridden = (requests: IRequest[]) => requests.map((r) => (overrides.has(r.name) ? { ...r, spec: overrides.get(r.name)! } : r));
  const queue = [...rootRequests];
  const all: INode[] = [];
  while (queue.length) {
    const request = queue.shift()!;
    const { from, name, optional } = request;
    try {
      const alias = resolveAlias(name, request.spec);
      const packument = await registry.packument(alias.realName);
      let nearest: INode | undefined;
      for (let n: INode | undefined = from; n && !nearest; n = n.parent) nearest = n.children.get(name);
      if (nearest && accepts(nearest, alias.realName, alias.spec, packument)) continue; // deduped
      if (nearest && request.peer) {
        warn(`${from.manifest.name}@${from.manifest.version} wants peer ${name}@${request.spec}, but ${nearest.manifest.version} is installed - keeping it`);
        continue;
      }
      const manifest = pickVersion(packument, alias.spec);
      if (!platformAllows(manifest.os, PLATFORM.os) || !platformAllows(manifest.cpu, PLATFORM.cpu)) {
        if (optional) continue; // a native build for some real platform: nothing to run it on here
        warn(`${manifest.name}@${manifest.version} is built for os=${manifest.os ?? "any"} cpu=${manifest.cpu ?? "any"}; installing anyway`);
      }
      const host = nearest ? from : root;
      const node: INode = { name, manifest, parent: host, children: new Map(), dir: join(host.dir, "node_modules", name), optional };
      host.children.set(name, node);
      all.push(node);
      const next = overridden(requestsOf(node, manifest));
      next.forEach(prefetch);
      queue.push(...next);
    } catch (error) {
      if (!optional) throw error;
      warn(`skipping optional dependency ${name}@${request.spec}: ${(error as Error).message}`);
    }
  }
  return all;
};

/** Makes node_modules match the resolved tree; returns the packages actually (re)extracted and
 *  the optional ones whose download failed. */
const writeTree = async (fs: IFsClient, root: INode, all: INode[], registry: IRegistryClient, warn: (message: string) => void) => {
  // Replace anything stale, shallowest first - removing a package's directory also removes
  // whatever was nested inside it, which must then be (re)extracted too.
  const byDepth = [...all].sort((a, b) => a.dir.split("/").length - b.dir.split("/").length);
  const toExtract: INode[] = [];
  prune(fs, root);
  for (const node of byDepth) {
    const existing = readJson(fs, join(node.dir, "package.json"));
    if (existing?.name === node.manifest.name && existing?.version === node.manifest.version) {
      prune(fs, node); // kept as-is - but its own nested node_modules may hold leftovers
      continue;
    }
    if (fs.exists(node.dir)) fs.rm(node.dir, { recursive: true });
    toExtract.push(node);
  }

  const skipped = new Set<INode>();
  const tarballs = new Map<INode, Uint8Array>();
  await mapLimit(toExtract, TARBALL_CONCURRENCY, async (node) => {
    try {
      tarballs.set(node, await registry.tarball(node.manifest));
    } catch (error) {
      if (!node.optional) throw error;
      warn(`skipping optional dependency ${node.manifest.name}@${node.manifest.version}: ${(error as Error).message}`);
      skipped.add(node);
    }
  });
  // Written in depth order (not download order), for the same reason as the removals above.
  for (const node of toExtract) {
    const tar = tarballs.get(node);
    if (tar) extract(fs, node.dir, tar);
  }
  const installed = all.filter((node) => !skipped.has(node));
  for (const node of installed) linkBins(fs, node, warn);
  return { extracted: toExtract.filter((node) => !skipped.has(node)), installed };
};

const DEPENDENCY_FIELDS = ["dependencies", "devDependencies", "optionalDependencies"];

/** Saves command-line packages the way npm does: a bare name, a dist-tag or an exact version is
 *  saved as `^<the version installed>`, and so is a range that `^<version>` fits inside (`x@7`);
 *  any other range is saved as typed (`x@~1.1.0`); an alias keeps its `npm:`. */
const saveAdded = (pkg: Record<string, any>, root: INode, added: Array<{ name: string; spec: string }>, saveDev: boolean) => {
  const field = saveDev ? "devDependencies" : "dependencies";
  for (const { name, spec } of added) {
    const node = root.children.get(name);
    if (!node) continue;
    const alias = resolveAlias(name, spec);
    const typed = alias.spec.trim();
    const range = typed === "" || parseVersion(typed) ? undefined : parseRange(typed);
    const keepTyped = range !== undefined && !coversCaret(range, parseVersion(node.manifest.version)!);
    const saved = keepTyped ? typed : `^${node.manifest.version}`;
    for (const other of DEPENDENCY_FIELDS) delete pkg[other]?.[name];
    const entries = { ...pkg[field], [name]: alias.realName === name ? saved : `npm:${alias.realName}@${saved}` };
    pkg[field] = Object.fromEntries(Object.entries(entries).sort(([a], [b]) => (a < b ? -1 : 1)));
  }
  for (const other of DEPENDENCY_FIELDS) if (pkg[other] && Object.keys(pkg[other]).length === 0) delete pkg[other];
};

export const install = async ({ fs, cwd, registry, add, saveDev, warn }: IInstallOptions): Promise<IInstallResult> => {
  const packageJsonPath = join(cwd, "package.json");
  const rootPkg = readJson(fs, packageJsonPath);
  if (!rootPkg && add.length === 0) throw new NpmError("ENOENT", `Could not read package.json: no such file ${packageJsonPath}`);
  const pkg = rootPkg ?? {};

  const root: INode = { name: "", manifest: { name: pkg.name ?? "", version: pkg.version ?? "0.0.0", dist: { tarball: "" } }, parent: undefined, children: new Map(), dir: cwd, optional: false };
  const added = add.map(parseCommandLineSpec);
  const addedNames = new Set(added.map((a) => a.name));
  // The root's own dependencies - devDependencies too, since this IS the project - with anything
  // named on the command line replacing whatever package.json said for the same name.
  const rootRequests = [
    ...added.map(({ name, spec }): IRequest => ({ from: root, name, spec, optional: false, peer: false })),
    ...requestsOf(root, { ...pkg, dependencies: { ...pkg.devDependencies, ...pkg.dependencies } }).filter((r) => !addedNames.has(r.name)),
  ];

  const all = await resolveTree(root, rootRequests, registry, warn, readOverrides(pkg, warn));
  const { extracted, installed } = await writeTree(fs, root, all, registry, warn);
  if (added.length) {
    saveAdded(pkg, root, added, saveDev);
    fs.writeFile(packageJsonPath, `${JSON.stringify(pkg, null, 2)}\n`);
  }
  return {
    added: extracted.length,
    total: installed.length,
    skippedScripts: installed.filter((node) => node.manifest.hasInstallScript).map((node) => node.manifest.name),
  };
};

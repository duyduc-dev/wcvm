// Mirrors an in-memory Vfs to the Origin Private File System (OPFS), write-behind: a mutation
// answers its syscall immediately (the vfs is already updated synchronously), and the matching
// OPFS write happens afterward, in the background, never blocking the caller. Restoring the other
// direction (OPFS -> a fresh Vfs) happens once, before the FS Worker ever serves a syscall - see
// workers/fs/worker.ts.
//
// OPFS itself has no symlinks, so a symlink's own target can't be mirrored as a normal OPFS entry
// the way a file's content can - instead, every symlink's {path, target} is tracked separately, in
// one small JSON manifest file (SYMLINK_MANIFEST_NAME) at the OPFS root, outside the vfs's own
// mirrored tree, and replayed as real vfs.symlink() calls on restore. This was ORIGINALLY a
// documented simplification ("real npm installs create very few symlinks") - confirmed wrong by a
// real, reproduced bug: npm's own bin-linking (`node_modules/.bin/vite`, say) IS a symlink, and
// losing it on every reload broke `npm run dev` right after a reload with no other symptom (the
// package itself was still there - only its bin link was gone, so the shell reported a plain
// "command not found").
//
// Only the handful of real File System Access API methods this module actually uses are typed
// here (a subset of the real, global `FileSystemDirectoryHandle`/`FileSystemFileHandle`, already
// in TypeScript's default DOM lib) - a real handle satisfies this structurally, and a plain
// in-memory fake can too, for tests (OPFS itself doesn't exist under Vitest/Node).

import { Vfs, VfsError } from "./Vfs";

export interface IOpfsFileHandle {
  kind: "file";
  getFile(): Promise<{ arrayBuffer(): Promise<ArrayBuffer> }>;
  createWritable(): Promise<{ write(data: Uint8Array): Promise<void>; close(): Promise<void> }>;
}

/** One small file, directly under the OPFS root (never inside the vfs's own mirrored tree, so it
 *  never shows up as a stray entry in `wc.fs.readdir("/")`), holding every symlink's {path:
 *  target} - see this file's own header comment. */
const SYMLINK_MANIFEST_NAME = "__wcvm_symlinks__.json";

export interface IOpfsDirHandle {
  kind: "directory";
  getDirectoryHandle(name: string, options?: { create?: boolean }): Promise<IOpfsDirHandle>;
  getFileHandle(name: string, options?: { create?: boolean }): Promise<IOpfsFileHandle>;
  removeEntry(name: string, options?: { recursive?: boolean }): Promise<void>;
  entries(): AsyncIterableIterator<[string, IOpfsDirHandle | IOpfsFileHandle]>;
}

/** The real entry point (only callable from a Worker - OPFS's root is unavailable on the main
 *  thread in most browsers, fine here since only workers/fs/worker.ts ever calls this): a
 *  `root`-named subdirectory of OPFS, created if it doesn't exist yet. Namespaced so unrelated
 *  wcvm instances on the same origin (different demos, or just two tabs) don't share storage
 *  unless they deliberately choose the same root name.
 *
 *  The real `FileSystemDirectoryHandle` doesn't structurally satisfy `IOpfsDirHandle` as far as
 *  TypeScript's own DOM lib types are concerned - `entries()`'s real declared return type isn't
 *  narrowed to file/dir handles specifically, and `write()`'s real param type doesn't accept a
 *  Uint8Array whose backing buffer *could* (its default generic type param) be a
 *  SharedArrayBuffer - same generic-TypedArray friction as httpParser.ts's own `buffer` field and
 *  PreviewServiceWorker.ts's `result.body as BufferSource`. A real handle satisfies this
 *  module's actual (narrower, hand-picked) usage at runtime either way. */
export const getOpfsRoot = async (root: string): Promise<IOpfsDirHandle> => {
  const opfsRoot = await navigator.storage.getDirectory();
  return (await opfsRoot.getDirectoryHandle(root, { create: true })) as unknown as IOpfsDirHandle;
};

const isNotFound = (error: unknown): boolean => (error as { name?: string } | null)?.name === "NotFoundError";

const splitPath = (path: string): { dir: string; name: string } => {
  const slash = path.lastIndexOf("/");
  return { dir: path.slice(0, slash) || "/", name: path.slice(slash + 1) };
};

const segments = (path: string): string[] => path.split("/").filter((s) => s !== "");

/** Walks/creates every directory segment of `dirPath`, starting from `root` - used only where
 *  there's no mirror-lifetime cache to reuse (`restoreFromOpfs`, which never revisits the same
 *  directory twice anyway). `createOpfsMirror`'s own writes go through `createDirHandleCache`
 *  below instead - see its own doc comment for why. */
const ensureDir = async (root: IOpfsDirHandle, dirPath: string): Promise<IOpfsDirHandle> => {
  let dir = root;
  for (const segment of segments(dirPath)) dir = await dir.getDirectoryHandle(segment, { create: true });
  return dir;
};

/**
 * A small in-memory cache of OPFS directory handles, scoped to one `createOpfsMirror` instance's
 * lifetime - avoids re-walking (and redundantly `getDirectoryHandle`-round-tripping through) the
 * SAME shared ancestor directories for every sibling file a real install writes under them.
 * Confirmed this is the actual dominant cost of a slow `wc.fs.sync()`, not raw per-file I/O or the
 * lack of cross-path concurrency alone: mirroring 33 files 3 directories deep (sharing a few
 * parents, the realistic npm shape) took over 20x longer than mirroring the same 33 files flat at
 * the root, everything else identical.
 *
 * Caches the PROMISE, not just the eventually-resolved handle - a real npm install fires many
 * concurrent top-level `notify()` calls that all need the SAME shared ancestor directory at once
 * (a `mkdir` and several sibling files' own writes, each its own independent path/queue with no
 * ordering relationship to the others - see `createOpfsMirror`'s own per-path chains), so caching
 * only the settled value would still let every one of them race to resolve that ancestor
 * concurrently before any had cached it (confirmed directly: with a settled-value-only cache, one
 * shared directory was still resolved 3 separate times). Memoizing the in-flight promise itself
 * means the second concurrent caller reuses the first's own request instead of starting another.
 *
 * `invalidate(path)` must be called whenever `path` (or anything nested under it) is actually
 * removed from OPFS (see `createOpfsMirror`'s own delete branch) - otherwise a LATER `ensureDir`
 * call for the same directory name could hand back a handle to an entry OPFS no longer has. A
 * narrower case this doesn't fully close: a directory removed and then immediately recreated
 * (same exact path, different real npm scenario) could, in principle, have its own re-creation
 * finish using a not-yet-invalidated cached handle if the two operations are still mid-flight at
 * the same time - each targets a DIFFERENT path (the directory's own vs. a file nested under it),
 * so per-path serialization alone doesn't order them against each other. Not a realistic npm
 * install shape (nothing removes and immediately re-creates the identical directory within one
 * install), and the worst case is a caught-and-logged write failure, not silent corruption - so
 * left as a documented edge case rather than a fully general (and far more complex) fix.
 */
const createDirHandleCache = (root: IOpfsDirHandle) => {
  const cache = new Map<string, Promise<IOpfsDirHandle>>([["/", Promise.resolve(root)]]);

  const ensureDirCached = (dirPath: string): Promise<IOpfsDirHandle> => {
    const cached = cache.get(dirPath);
    if (cached) return cached;
    const { dir: parentPath, name } = splitPath(dirPath);
    const promise = ensureDirCached(parentPath).then((parent) => parent.getDirectoryHandle(name, { create: true }));
    cache.set(dirPath, promise);
    return promise;
  };

  const invalidate = (dirPath: string): void => {
    const prefix = dirPath === "/" ? "/" : `${dirPath}/`;
    for (const key of cache.keys()) {
      if (key === dirPath || key.startsWith(prefix)) cache.delete(key);
    }
  };

  return { ensureDir: ensureDirCached, invalidate };
};

/** Same walk, but never creates - a missing segment means "nothing to remove", not an error. */
const findDir = async (root: IOpfsDirHandle, dirPath: string): Promise<IOpfsDirHandle | undefined> => {
  let dir = root;
  for (const segment of segments(dirPath)) {
    try {
      dir = await dir.getDirectoryHandle(segment);
    } catch (error) {
      if (isNotFound(error)) return undefined;
      throw error;
    }
  }
  return dir;
};

/** {path: target} for every symlink ever recorded - an absent manifest (a fresh root, or one that
 *  never had a symlink written to it) is simply empty, not an error. So is a CORRUPTED one (e.g. a
 *  page reload interrupting `saveSymlinkManifest`'s own write mid-flight, leaving truncated/invalid
 *  JSON behind) - confirmed as a real, reproduced bug: an unhandled `JSON.parse` failure here used
 *  to propagate all the way up through `restoreFromOpfs` and the FS Worker's own `boot()`, which
 *  meant the FS Worker never sent "ready" - hanging the WHOLE kernel's boot forever (surfacing to
 *  the host as `ERR_BOOT_TIMEOUT` 10 seconds later, with nothing pointing at the real cause). This
 *  file is best-effort bookkeeping exactly like the rest of write-behind persistence already is
 *  elsewhere - losing it in a rare corruption case (worst case: a bin symlink needs a fresh
 *  `npm install` to reappear) must never be able to block booting at all. */
const loadSymlinkManifest = async (root: IOpfsDirHandle): Promise<Record<string, string>> => {
  try {
    const handle = await root.getFileHandle(SYMLINK_MANIFEST_NAME);
    const file = await handle.getFile();
    return JSON.parse(new TextDecoder().decode(await file.arrayBuffer()));
  } catch (error) {
    if (isNotFound(error)) return {};
    console.error("wcvm: symlink manifest is unreadable, ignoring it (recorded symlinks may be missing until the next write):", error);
    return {};
  }
};

const saveSymlinkManifest = async (root: IOpfsDirHandle, manifest: Record<string, string>): Promise<void> => {
  const handle = await root.getFileHandle(SYMLINK_MANIFEST_NAME, { create: true });
  const writable = await handle.createWritable();
  await writable.write(new TextEncoder().encode(JSON.stringify(manifest)));
  await writable.close();
};

/**
 * Replays one manifest entry as a real `vfs.symlink()` call. Returns "orphaned" for the one
 * specific failure that means the manifest entry itself is stale, not just not-yet-restored:
 * `Vfs.walk()` throws ENOENT (as opposed to `Vfs.symlink()`'s own EEXIST, thrown when the path
 * already has SOMETHING there) exactly when an intermediate path segment - the symlink's own
 * parent directory - doesn't exist. If that parent will never exist (its owning project is
 * genuinely gone, not just deferred), this entry is dead weight: every future boot would
 * re-attempt it and re-log the same failure forever, since nothing ever removes it on its own.
 * Confirmed as a real, reproduced case: `wc.fs.reset()` (Studio's "Clear All") deletes projects
 * via `fs.rm()`, whose own manifest cleanup (`createOpfsMirror`'s `removeSymlinksUnder`) runs on
 * the SAME write-behind queue as everything else - if a reload lands before that queue drains,
 * a project's real files can be gone while its manifest entries survive, orphaned. Any OTHER
 * failure is logged and left alone, exactly as before - it isn't proof of staleness, just an
 * ordinary restore hiccup (see this function's callers' own comments). */
const replaySymlink = (vfs: Vfs, linkPath: string, target: string): "ok" | "orphaned" => {
  try {
    vfs.symlink(target, linkPath);
    return "ok";
  } catch (error) {
    if (error instanceof VfsError && error.code === "ENOENT") return "orphaned";
    console.error(`wcvm: failed to restore symlink ${linkPath} -> ${target}:`, error);
    return "ok";
  }
};

/** Runs `replaySymlink` over every `[linkPath, target]` in `entries`, then - only if any turned
 *  out orphaned - removes exactly those keys from `manifest` and persists the result, so the
 *  same dead entries don't keep resurfacing on every future boot. `manifest` is mutated in
 *  place: safe even if a DIFFERENT still-pending root's own materialization is concurrently
 *  pruning other keys out of the same shared object (independent map keys, no conflict) - the
 *  resave itself isn't strictly ordered against a concurrent one, but that's harmless here, see
 *  this module's own `withSuppressedOnChange` for the one place ordering actually matters. */
const replaySymlinksAndPruneOrphans = async (
  vfs: Vfs,
  root: IOpfsDirHandle,
  manifest: Record<string, string>,
  entries: [string, string][],
): Promise<void> => {
  const orphaned: string[] = [];
  for (const [linkPath, target] of entries) {
    if (replaySymlink(vfs, linkPath, target) === "orphaned") orphaned.push(linkPath);
  }
  if (orphaned.length === 0) return;
  console.error(`wcvm: pruning ${orphaned.length} orphaned symlink manifest entr${orphaned.length === 1 ? "y" : "ies"} (their own project is gone, not just not-yet-restored):`, orphaned);
  for (const linkPath of orphaned) delete manifest[linkPath];
  await saveSymlinkManifest(root, manifest);
};

/** Runs `fn` over `items` with at most `limit` in flight at once - same shape as
 *  `programs/npm/install.ts`'s own `mapLimit` (kept local rather than shared: it's four lines,
 *  and the two call sites want different failure handling - this one's `fn` never rejects, it
 *  logs and swallows internally, same as every other per-entry restore error). */
const mapLimit = async <T>(items: T[], limit: number, fn: (item: T) => Promise<void>): Promise<void> => {
  let next = 0;
  const worker = async () => {
    while (next < items.length) await fn(items[next++]);
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
};

// A real npm-installed node_modules tree is many thousands of small files. Reading them back one
// at a time (one getFile()+arrayBuffer() round trip, awaited before starting the next) made
// restoring a handful of such projects on one boot take well over the host's own default 10s
// ERR_BOOT_TIMEOUT - confirmed directly: with ~10 persisted React/Vite projects each with a full
// install, boot() timed out outright, not just felt slow. Unlike createOpfsMirror's own dir-
// handle-cache fix (this file's own comment on it: redundant ANCESTOR re-resolution, not raw
// per-file I/O, was that path's dominant cost), restoreFromOpfs never re-resolves a directory - it
// already walks down via entries() and holds each handle once - so there's no analogous ancestor
// cost to fix here; the files themselves are the bulk of the work, and they don't depend on each
// other, so reading them concurrently is a straightforward, safe win.
const RESTORE_CONCURRENCY = 32;

/** Path segment names that are never persisted (`boot({ persist: { exclude } })`) - matched
 *  against EVERY segment, so `node_modules` covers one at any depth. They live in memory only: a
 *  reload restores the project without them. */
export type ExcludedNames = ReadonlySet<string>;
const NOTHING_EXCLUDED: ExcludedNames = new Set();

/** True when any segment of `path` is an excluded name. */
export const isExcludedPath = (path: string, exclude: ExcludedNames): boolean =>
  exclude.size > 0 && path.split("/").some((segment) => exclude.has(segment));

/** Drops manifest entries under an excluded name and persists the result: anything recorded
 *  before the name was excluded would otherwise be replayed as a dangling symlink. */
const dropExcludedSymlinks = async (
  root: IOpfsDirHandle,
  manifest: Record<string, string>,
  exclude: ExcludedNames,
): Promise<void> => {
  if (exclude.size === 0) return;
  let changed = false;
  for (const key of Object.keys(manifest)) {
    if (isExcludedPath(key, exclude)) {
      delete manifest[key];
      changed = true;
    }
  }
  if (changed) await saveSymlinkManifest(root, manifest);
};

/** Walks `root`'s structure into `vfs` (mkdir'ing every directory, so a file's parent always
 *  exists by the time anything needs it) and collects every file into `files` rather than reading
 *  its content yet - restoreFromOpfs reads all of those concurrently afterward, see its own doc
 *  comment for why. Directory walking itself stays sequential: it's cheap relative to file
 *  content (see RESTORE_CONCURRENCY's own comment), and staying sequential is what guarantees a
 *  directory's own mkdir has already happened before anything below it is even considered. */
const collectOpfsTree = async (
  vfs: Vfs,
  root: IOpfsDirHandle,
  path: string,
  files: { path: string; handle: IOpfsFileHandle }[],
  exclude: ExcludedNames,
): Promise<void> => {
  for await (const [name, handle] of root.entries()) {
    if (path === "/" && name === SYMLINK_MANIFEST_NAME) continue; // not part of the vfs's own tree
    if (exclude.has(name)) {
      // Persisted before the name was excluded: not restored, and removed so it stops costing quota.
      await root.removeEntry(name, { recursive: true }).catch(() => {});
      continue;
    }
    const childPath = path === "/" ? `/${name}` : `${path}/${name}`;
    try {
      if (handle.kind === "directory") {
        vfs.mkdir(childPath);
        await collectOpfsTree(vfs, handle, childPath, files, exclude);
      } else {
        files.push({ path: childPath, handle });
      }
    } catch (error) {
      console.error(`wcvm: failed to restore ${childPath} from OPFS, skipping it:`, error);
    }
  }
};

/** Recreates OPFS's tree inside `vfs` (called once, before the FS Worker serves anything), then
 *  replays every recorded symlink on top of it (directories/files must already exist for a
 *  symlink to usefully point at). Each entry is restored independently - a single corrupted or
 *  unreadable file/directory (e.g. a page reload interrupting its own OPFS write, the same root
 *  cause a corrupted symlink manifest already had - see `loadSymlinkManifest`'s own doc comment)
 *  is logged and skipped rather than failing the WHOLE restore: an uncaught throw here propagates
 *  straight out of the FS Worker's own `boot()` (see workers/fs/worker.ts), which never reaches
 *  its `postMessage({type: "ready"})` line - hanging the entire kernel's boot until the host's own
 *  unrelated `ERR_BOOT_TIMEOUT` fires 10 seconds later, for a problem localized to one bad file. */
export const restoreFromOpfs = async (
  vfs: Vfs,
  root: IOpfsDirHandle,
  path = "/",
  exclude: ExcludedNames = NOTHING_EXCLUDED,
): Promise<void> => {
  const files: { path: string; handle: IOpfsFileHandle }[] = [];
  await collectOpfsTree(vfs, root, path, files, exclude);

  await mapLimit(files, RESTORE_CONCURRENCY, async ({ path: filePath, handle }) => {
    try {
      const file = await handle.getFile();
      vfs.writeFile(filePath, new Uint8Array(await file.arrayBuffer()));
    } catch (error) {
      console.error(`wcvm: failed to restore ${filePath} from OPFS, skipping it:`, error);
    }
  });

  if (path !== "/") return; // symlinks are only ever replayed once, at the top-level call
  const manifest = await loadSymlinkManifest(root);
  await dropExcludedSymlinks(root, manifest, exclude);
  await replaySymlinksAndPruneOrphans(vfs, root, manifest, Object.entries(manifest));
};

/** True when `path` is `root` itself, or (recursively) beneath it. */
const isUnderOrEqual = (path: string, root: string): boolean =>
  path === root || path.startsWith(root === "/" ? "/" : `${root}/`);

/** OPFS lazy restore: `boot({persist})`'s opt-in `lazyDepth` (see IFsWorkerBoot) instead of
 *  eagerly reading every persisted project's full content on every boot (restoreFromOpfs above -
 *  still what runs when lazyDepth isn't set, so nothing changes for an existing consumer that
 *  never opts in). Only directory STRUCTURE down to `lazyDepth` path segments is restored eagerly
 *  (mkdir only - cheap, and Studio's own /home/user/projects/<name> convention has no files at
 *  those shallow levels anyway); each directory found AT that depth becomes its own independently
 *  deferred unit, fully restored only once something actually touches a path under it - see
 *  `ensureRestored`. */
export interface ILazyOpfsRestore {
  /** Resolves once every still-pending lazy root that any of `paths` touches - as an ancestor
   *  (the normal "reading into this project" case) or as a DESCENDANT (see below) - has been
   *  fully restored. A no-op for a path that was never lazy, or whose owning root is already done. */
  ensureRestored(paths: string[]): Promise<void>;
  /**
   * Drops any still-pending root that `paths` touches (ancestor, equal, or containing
   * descendant - same reach as `ensureRestored`) WITHOUT ever materializing it. Safe ONLY for a
   * recursive remove: `createOpfsMirror`'s own delete handling (`removeMirrored`) is purely
   * path-based OPFS `removeEntry`, independent of vfs state, so the real OPFS data under a
   * still-pending root gets correctly, fully removed by `vfs.rm()`'s own (empty-placeholder)
   * mirror event either way - materializing first was always pure waste for this one case, never
   * a safety requirement (unlike rename, which genuinely needs it - see `ensureRestored`'s own
   * comment).
   *
   * This matters more than the wasted-work framing alone suggests: `wc.fs.reset()` (Studio's
   * "Clear All") recursively removes a single shared ancestor (`/home`) that CONTAINS every
   * still-pending project at once - without this, that one call had to fully materialize the
   * ENTIRE persisted history (774MB / ~6s in the field, for one real user's accumulated projects)
   * before it could even start deleting. That's a wide window for a page reload to land mid-
   * flight and leave OPFS partially cleaned: project directories gone, but their own symlink
   * manifest entries never reached (a separate, serialized queue - `createOpfsMirror`'s own
   * `manifestChain` comment) - orphaned forever after, since nothing ever revisits a deleted
   * project to retry its cleanup. `replaySymlinksAndPruneOrphans` self-heals that half after the
   * fact; this is the other half - make the actual deletion fast and safe enough that the race
   * window barely exists in the first place. */
  discardPending(paths: string[]): void;
}

export const restoreFromOpfsLazy = async (
  vfs: Vfs,
  root: IOpfsDirHandle,
  lazyDepth: number,
  exclude: ExcludedNames = NOTHING_EXCLUDED,
): Promise<ILazyOpfsRestore> => {
  const pending = new Map<string, { handle: IOpfsDirHandle; promise?: Promise<void> }>();

  const walkShallow = async (dir: IOpfsDirHandle, path: string, depth: number): Promise<void> => {
    for await (const [name, handle] of dir.entries()) {
      if (path === "/" && name === SYMLINK_MANIFEST_NAME) continue;
      if (exclude.has(name)) {
        await dir.removeEntry(name, { recursive: true }).catch(() => {});
        continue;
      }
      const childPath = path === "/" ? `/${name}` : `${path}/${name}`;
      try {
        if (handle.kind === "directory") {
          vfs.mkdir(childPath);
          if (depth + 1 >= lazyDepth) pending.set(childPath, { handle });
          else await walkShallow(handle, childPath, depth + 1);
        } else {
          // A file at or above the lazy boundary itself - restored eagerly, same as
          // restoreFromOpfs always has: laziness only applies to a DIRECTORY'S deferred content.
          const file = await handle.getFile();
          vfs.writeFile(childPath, new Uint8Array(await file.arrayBuffer()));
        }
      } catch (error) {
        console.error(`wcvm: failed to restore ${childPath} from OPFS, skipping it:`, error);
      }
    }
  };
  await walkShallow(root, "/", 0);

  // Loaded once, up front - it's one small JSON file, not the bulk of restore's own cost (that's
  // real file content, see restoreFromOpfs's own comment). A symlink whose path isn't under any
  // still-pending root can be replayed immediately; the rest wait for their owning root.
  const manifest = await loadSymlinkManifest(root);
  await dropExcludedSymlinks(root, manifest, exclude);
  await replaySymlinksAndPruneOrphans(
    vfs,
    root,
    manifest,
    Object.entries(manifest).filter(([linkPath]) => ![...pending.keys()].some((r) => isUnderOrEqual(linkPath, r))),
  );

  // Unlike the top-level restore above (run BEFORE the mirror is ever wired up - see its own
  // comment), a lazy root is materialized on demand, well after FsServer has already pointed
  // vfs.onChange at the real mirror+watch dispatcher. Left alone, every mkdir/writeFile this does
  // would round-trip straight back out to OPFS as if each restored file were a brand new write -
  // wasted I/O for data already correctly there - and could fire spurious watch events for files
  // nothing actually created or changed this session, only just paged into memory. A plain
  // save-swap-restore of vfs.onChange isn't enough: two DIFFERENT lazy roots can legitimately
  // materialize concurrently (nothing serializes ensureRestored callers), and whichever one
  // finishes first would restore the real handler while the other is still mid-restore, letting
  // ITS remaining writes leak through. A depth counter makes this correct regardless of overlap -
  // only the outermost suppress/restore pair actually touches vfs.onChange.
  let suppressDepth = 0;
  let realOnChange: typeof vfs.onChange | undefined;
  const withSuppressedOnChange = async (fn: () => Promise<void>): Promise<void> => {
    if (suppressDepth === 0) {
      realOnChange = vfs.onChange;
      vfs.onChange = () => {};
    }
    suppressDepth++;
    try {
      await fn();
    } finally {
      suppressDepth--;
      if (suppressDepth === 0) vfs.onChange = realOnChange!;
    }
  };

  /** Fully restores one still-pending root: reuses restoreFromOpfs itself (a non-"/" `path` makes
   *  it skip ITS OWN symlink-manifest handling - see its own doc comment - so this is exactly the
   *  same concurrent directory+file restore boot() uses, just scoped to one subtree), then replays
   *  whichever symlinks belong under it from the manifest already loaded above. */
  const materialize = async (rootPath: string, handle: IOpfsDirHandle): Promise<void> => {
    await withSuppressedOnChange(async () => {
      await restoreFromOpfs(vfs, handle, rootPath, exclude);
      const own = Object.entries(manifest).filter(([linkPath]) => isUnderOrEqual(linkPath, rootPath));
      await replaySymlinksAndPruneOrphans(vfs, root, manifest, own);
    });
  };

  const ensureOne = async (rootPath: string): Promise<void> => {
    const entry = pending.get(rootPath);
    if (!entry) return; // already materialized (or never was a lazy root)
    entry.promise ??= materialize(rootPath, entry.handle).finally(() => pending.delete(rootPath));
    await entry.promise;
  };

  // Shared by ensureRestored and discardPending: which still-pending roots any of `paths`
  // touches, checked in BOTH directions - not just "is this path under some pending root", but
  // also "does this path CONTAIN one or more pending roots" (renaming or removing
  // /home/user/projects itself, say, sweeps every project under it at once). See ensureRestored's
  // own comment for why rename specifically needs the materialized data either way, and
  // discardPending's own comment for why a recursive remove specifically does NOT.
  const matchingRoots = (paths: string[]): string[] => {
    const roots = new Set<string>();
    for (const path of paths) {
      for (const rootPath of pending.keys()) {
        if (isUnderOrEqual(path, rootPath) || isUnderOrEqual(rootPath, path)) roots.add(rootPath);
      }
    }
    return [...roots];
  };

  return {
    ensureRestored: async (paths: string[]): Promise<void> => {
      await Promise.all(matchingRoots(paths).map((r) => ensureOne(r)));
    },
    discardPending: (paths: string[]): void => {
      for (const rootPath of matchingRoots(paths)) pending.delete(rootPath);
    },
  };
};

const mirrorFile = async (ensureDirCached: (dirPath: string) => Promise<IOpfsDirHandle>, path: string, data: Uint8Array): Promise<void> => {
  const { dir, name } = splitPath(path);
  const dirHandle = await ensureDirCached(dir);
  const fileHandle = await dirHandle.getFileHandle(name, { create: true });
  const writable = await fileHandle.createWritable();
  await writable.write(data);
  await writable.close();
};

const isLocked = (error: unknown): boolean => (error as { name?: string } | null)?.name === "NoModificationAllowedError";

// An entry OPFS refuses to remove while a writer holds it open: one of OUR OWN in-flight writes to
// a file under it (the mirror serializes writes per path, but removing a directory and writing a
// file inside it are different paths - a dev server rewriting `.next/dev/logs/*.log` while
// `rm -rf .next` runs), or another tab of the same origin writing the same file. The writer is
// short-lived, so waiting briefly and trying again nearly always works; only a lock that outlasts
// all of the waits below is reported.
const REMOVE_RETRY_DELAYS_MS = [25, 50, 100, 200, 400];

const removeMirrored = async (root: IOpfsDirHandle, path: string): Promise<void> => {
  const { dir, name } = splitPath(path);
  const dirHandle = await findDir(root, dir);
  if (!dirHandle) return;
  for (let attempt = 0; ; attempt++) {
    try {
      await dirHandle.removeEntry(name, { recursive: true });
      return;
    } catch (error) {
      if (isNotFound(error)) return;
      if (!isLocked(error) || attempt >= REMOVE_RETRY_DELAYS_MS.length) throw error;
      await new Promise((resolve) => setTimeout(resolve, REMOVE_RETRY_DELAYS_MS[attempt]));
    }
  }
};

/** Records one symlink (or updates its target) in the manifest - a plain read-modify-write, safe
 *  here because it's only ever called from within `createOpfsMirror`'s own serialized queue. */
const recordSymlink = async (root: IOpfsDirHandle, path: string, target: string): Promise<void> => {
  const manifest = await loadSymlinkManifest(root);
  if (manifest[path] === target) return;
  manifest[path] = target;
  await saveSymlinkManifest(root, manifest);
};

/** Drops `path` itself and anything nested under it (a whole directory subtree being removed or
 *  renamed away) from the manifest - the counterpart to `removeMirrored`'s own recursive OPFS
 *  removal, which has no notion of the manifest at all. */
const removeSymlinksUnder = async (root: IOpfsDirHandle, path: string): Promise<void> => {
  const manifest = await loadSymlinkManifest(root);
  const prefix = path === "/" ? "/" : `${path}/`;
  let changed = false;
  for (const key of Object.keys(manifest)) {
    if (key === path || key.startsWith(prefix)) {
      delete manifest[key];
      changed = true;
    }
  }
  if (changed) await saveSymlinkManifest(root, manifest);
};

/** Mirrors `path` - and, if `walkChildren`, its WHOLE subtree too. `walkChildren` is Vfs.ts's own
 *  `subtreeIsOnlyAnnouncement` (see its doc comment), true ONLY for a directory rename: its own
 *  onChange is the ONLY announcement the mirror will EVER get about anything that moved with it,
 *  so finding out what that is means walking it. Every OTHER directory-creating operation (mkdir,
 *  Vfs.cp()) instead fires its own SEPARATE event for every entry it creates - so for those,
 *  walking children here too would just re-mirror them AGAIN, redundantly, on top of each one's
 *  own event (severe for a big, deep tree: one deeply nested file can get mirrored once per
 *  ancestor directory, plus its own - see Vfs.ts's own doc comment for the measured cost). The
 *  directory itself still gets created either way (ensureDirCached) - only the recursive WALK
 *  into children is conditional. A symlink can't be mirrored as an OPFS entry (OPFS has none) -
 *  recorded in the manifest instead (through `queueManifestOp` - see `createOpfsMirror`, the only
 *  real caller of this; the shared manifest file needs its own serialization independent of
 *  per-path mirroring), restored separately (see `restoreFromOpfs`). */
const resyncSubtree = async (
  vfs: Vfs,
  root: IOpfsDirHandle,
  ensureDirCached: (dirPath: string) => Promise<IOpfsDirHandle>,
  path: string,
  queueManifestOp: (op: () => Promise<void>) => Promise<void>,
  walkChildren: boolean,
  exclude: ExcludedNames,
): Promise<void> => {
  const stat = vfs.lstat(path);
  if (stat.kind === "symlink") {
    await queueManifestOp(() => recordSymlink(root, path, vfs.readlink(path)));
    return;
  }
  if (stat.kind === "file") {
    await mirrorFile(ensureDirCached, path, vfs.readFile(path));
    return;
  }
  await ensureDirCached(path);
  if (!walkChildren) return;
  for (const [name, kind] of vfs.readdirKinds(path)) {
    if (exclude.has(name)) continue;
    const childPath = path === "/" ? `/${name}` : `${path}/${name}`;
    if (kind === "symlink") {
      await queueManifestOp(() => recordSymlink(root, childPath, vfs.readlink(childPath)));
      continue;
    }
    await resyncSubtree(vfs, root, ensureDirCached, childPath, queueManifestOp, walkChildren, exclude);
  }
};

/** A running write-behind mirror: `notify` queues one more path to sync (fire-and-forget, meant
 *  to be assigned straight to `Vfs.onChange`), `flush` resolves once every `notify()` call queued
 *  so far has actually landed in OPFS - the only way a caller (a real reload/close is about to
 *  happen, or a host wants to know a big write like an npm install is truly durable first) can
 *  know write-behind has caught up, since otherwise it's entirely invisible from the outside.
 *  `subtreeIsOnlyAnnouncement` is Vfs.ts's own flag of the same name - forwarded straight through
 *  to `resyncSubtree`, see its own doc comment. */
export interface IOpfsMirror {
  notify(path: string, subtreeIsOnlyAnnouncement: boolean): void;
  flush(): Promise<void>;
}

/**
 * Builds a write-behind mirror to `root` (see `IOpfsMirror`). Two different paths have no
 * ordering dependency on each other at all - only repeated changes to the EXACT SAME path do
 * (two quick writes to `/a.txt` could otherwise race and leave OPFS with an older result than the
 * vfs's own current one) - so each path gets its OWN small serial queue instead of one shared by
 * everything, letting a big write (a real npm install's many, mostly-unrelated files) mirror to
 * OPFS concurrently rather than strictly one file at a time. This is what made `wc.fs.sync()`
 * (which waits for the mirror to fully catch up) slow for a real install: every file, across every
 * unrelated package, used to share one global chain regardless of path. A path's own queue is
 * dropped once it drains, so `pathChains` only ever holds genuinely pending work, not history.
 *
 * The symlink manifest (`recordSymlink`/`removeSymlinksUnder`) is the one exception: it's a SINGLE
 * shared file every symlink-affecting path reads-modifies-writes, so unlike regular mirroring it
 * still needs one dedicated serial queue (`manifestChain`) regardless of how many different paths
 * trigger it concurrently now - two concurrent updates could otherwise each read the same stale
 * manifest and one's change would silently clobber the other's. Symlinks are rare relative to a
 * real install's ordinary files, so this narrow queue is not the bottleneck the old global one was.
 *
 * A failed write is logged and does not stop later ones (write-behind is inherently best-effort:
 * the vfs itself is already the source of truth for the running session either way) - and does not
 * fail `flush()` either, for the same reason.
 *
 * Per-path independence (above) is about ORDERING, not throughput - it doesn't bound how many
 * paths' own resync() calls can be doing REAL OPFS I/O at the same instant, and that turned out to
 * matter a lot more than the per-path queues alone: a genuinely large, synchronous burst of
 * onChange events - Vfs.ts's own `cp()` fires one per copied entry, all in one JS tick, with none
 * of a real npm install's natural per-file sync-bridge pacing - drove mirroring MUCH slower than
 * the same file count arriving gradually (confirmed directly: cloning a cached, ~683-file project
 * via cp() took over 10s to sync, against ~1.5s for the same file count from a real install) - and
 * at high enough burst size, OPFS itself can outright fail (confirmed directly: an unbounded burst
 * of ~2000 concurrent createWritable() calls threw "AbortError: Failed to create swap file" in
 * real Chromium, not just run slowly). `acquireWriteSlot` bounds how many resync() calls are
 * ACTUALLY doing OPFS I/O at once, GLOBALLY, regardless of how many different paths' own
 * independent chains all became ready at the same instant - ordering is unaffected (it gates
 * inside a chain link, not across them), only how many of them run concurrently.
 */
export const createOpfsMirror = (vfs: Vfs, root: IOpfsDirHandle, exclude: ExcludedNames = NOTHING_EXCLUDED): IOpfsMirror => {
  const pathChains = new Map<string, Promise<void>>();
  const dirCache = createDirHandleCache(root);
  let manifestChain: Promise<void> = Promise.resolve();

  const WRITE_CONCURRENCY = 16;
  let activeWrites = 0;
  const writeQueue: (() => void)[] = [];
  /** Resolves once a slot is free, with a release callback - `await`ed inside notify()'s own
   *  per-path chain link, so it gates concurrency without reordering anything within one path. */
  const acquireWriteSlot = (): Promise<() => void> =>
    new Promise((resolve) => {
      const grant = () => {
        activeWrites++;
        resolve(() => {
          activeWrites--;
          writeQueue.shift()?.();
        });
      };
      if (activeWrites < WRITE_CONCURRENCY) grant();
      else writeQueue.push(grant);
    });

  const queueManifestOp = (op: () => Promise<void>): Promise<void> => {
    manifestChain = manifestChain.finally(op);
    return manifestChain;
  };

  const resync = async (path: string, subtreeIsOnlyAnnouncement: boolean): Promise<void> => {
    if (!vfs.exists(path)) {
      await removeMirrored(root, path);
      dirCache.invalidate(path);
      await queueManifestOp(() => removeSymlinksUnder(root, path));
      return;
    }
    try {
      await resyncSubtree(vfs, root, dirCache.ensureDir, path, queueManifestOp, subtreeIsOnlyAnnouncement, exclude);
    } catch (error) {
      // A path can legitimately be gone again by the time this runs (e.g. a write immediately
      // followed by an rm) - the NEXT onChange for the same path already queued its own removal.
      if (error instanceof VfsError && error.code === "ENOENT") return;
      throw error;
    }
  };

  return {
    notify(path: string, subtreeIsOnlyAnnouncement: boolean): void {
      if (isExcludedPath(path, exclude)) return; // memory-only, never mirrored
      const previous = pathChains.get(path) ?? Promise.resolve();
      const next = previous.finally(async () => {
        const release = await acquireWriteSlot();
        try {
          await resync(path, subtreeIsOnlyAnnouncement);
        } catch (error) {
          console.error(`wcvm: OPFS persistence failed for ${path}:`, error);
        } finally {
          release();
        }
      });
      pathChains.set(path, next);
      // Drop this path's own entry once it settles, UNLESS something newer has already replaced
      // it in the map (another notify() for the same path queued behind this one).
      void next.finally(() => {
        if (pathChains.get(path) === next) pathChains.delete(path);
      });
    },
    // Captures the CURRENT tail of every path's own queue, plus the manifest's - a notify() that
    // arrives after this call starts a new link this particular flush() doesn't need to wait for,
    // which is the right behavior: it only promises "everything queued so far", not "forever".
    flush(): Promise<void> {
      return Promise.all([...pathChains.values(), manifestChain]).then(() => undefined);
    },
  };
};

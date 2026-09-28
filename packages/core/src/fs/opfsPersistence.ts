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

/** Recreates OPFS's tree inside `vfs` (called once, before the FS Worker serves anything), then
 *  replays every recorded symlink on top of it (directories/files must already exist for a
 *  symlink to usefully point at). Each entry is restored independently - a single corrupted or
 *  unreadable file/directory (e.g. a page reload interrupting its own OPFS write, the same root
 *  cause a corrupted symlink manifest already had - see `loadSymlinkManifest`'s own doc comment)
 *  is logged and skipped rather than failing the WHOLE restore: an uncaught throw here propagates
 *  straight out of the FS Worker's own `boot()` (see workers/fs/worker.ts), which never reaches
 *  its `postMessage({type: "ready"})` line - hanging the entire kernel's boot until the host's own
 *  unrelated `ERR_BOOT_TIMEOUT` fires 10 seconds later, for a problem localized to one bad file. */
export const restoreFromOpfs = async (vfs: Vfs, root: IOpfsDirHandle, path = "/"): Promise<void> => {
  for await (const [name, handle] of root.entries()) {
    if (path === "/" && name === SYMLINK_MANIFEST_NAME) continue; // not part of the vfs's own tree
    const childPath = path === "/" ? `/${name}` : `${path}/${name}`;
    try {
      if (handle.kind === "directory") {
        vfs.mkdir(childPath);
        await restoreFromOpfs(vfs, handle, childPath);
      } else {
        const file = await handle.getFile();
        vfs.writeFile(childPath, new Uint8Array(await file.arrayBuffer()));
      }
    } catch (error) {
      console.error(`wcvm: failed to restore ${childPath} from OPFS, skipping it:`, error);
    }
  }

  if (path !== "/") return; // symlinks are only ever replayed once, at the top-level call
  for (const [linkPath, target] of Object.entries(await loadSymlinkManifest(root))) {
    try {
      vfs.symlink(target, linkPath);
    } catch (error) {
      // The path could legitimately already be occupied by a real, correctly-restored file if a
      // symlink at that exact path was later replaced by one in some earlier session (not a real
      // npm scenario, but not worth failing the whole restore over) - log and move on.
      console.error(`wcvm: failed to restore symlink ${linkPath} -> ${target}:`, error);
    }
  }
};

const mirrorFile = async (ensureDirCached: (dirPath: string) => Promise<IOpfsDirHandle>, path: string, data: Uint8Array): Promise<void> => {
  const { dir, name } = splitPath(path);
  const dirHandle = await ensureDirCached(dir);
  const fileHandle = await dirHandle.getFileHandle(name, { create: true });
  const writable = await fileHandle.createWritable();
  await writable.write(data);
  await writable.close();
};

const removeMirrored = async (root: IOpfsDirHandle, path: string): Promise<void> => {
  const { dir, name } = splitPath(path);
  const dirHandle = await findDir(root, dir);
  if (!dirHandle) return;
  try {
    await dirHandle.removeEntry(name, { recursive: true });
  } catch (error) {
    if (!isNotFound(error)) throw error;
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

/** Mirrors `path` and, if it's a directory, its whole subtree - needed for a directory rename:
 *  the vfs fires one onChange for the moved directory's own new path, not one per descendant. A
 *  symlink can't be mirrored as an OPFS entry (OPFS has none) - recorded in the manifest instead
 *  (through `queueManifestOp` - see `createOpfsMirror`, which is the only real caller of this;
 *  the shared manifest file needs its own serialization independent of per-path mirroring),
 *  restored separately (see `restoreFromOpfs`). */
const resyncSubtree = async (
  vfs: Vfs,
  root: IOpfsDirHandle,
  ensureDirCached: (dirPath: string) => Promise<IOpfsDirHandle>,
  path: string,
  queueManifestOp: (op: () => Promise<void>) => Promise<void>,
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
  for (const [name, kind] of vfs.readdirKinds(path)) {
    const childPath = path === "/" ? `/${name}` : `${path}/${name}`;
    if (kind === "symlink") {
      await queueManifestOp(() => recordSymlink(root, childPath, vfs.readlink(childPath)));
      continue;
    }
    await resyncSubtree(vfs, root, ensureDirCached, childPath, queueManifestOp);
  }
};

/** A running write-behind mirror: `notify` queues one more path to sync (fire-and-forget, meant
 *  to be assigned straight to `Vfs.onChange`), `flush` resolves once every `notify()` call queued
 *  so far has actually landed in OPFS - the only way a caller (a real reload/close is about to
 *  happen, or a host wants to know a big write like an npm install is truly durable first) can
 *  know write-behind has caught up, since otherwise it's entirely invisible from the outside. */
export interface IOpfsMirror {
  notify(path: string): void;
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
 */
export const createOpfsMirror = (vfs: Vfs, root: IOpfsDirHandle): IOpfsMirror => {
  const pathChains = new Map<string, Promise<void>>();
  const dirCache = createDirHandleCache(root);
  let manifestChain: Promise<void> = Promise.resolve();

  const queueManifestOp = (op: () => Promise<void>): Promise<void> => {
    manifestChain = manifestChain.finally(op);
    return manifestChain;
  };

  const resync = async (path: string): Promise<void> => {
    if (!vfs.exists(path)) {
      await removeMirrored(root, path);
      dirCache.invalidate(path);
      await queueManifestOp(() => removeSymlinksUnder(root, path));
      return;
    }
    try {
      await resyncSubtree(vfs, root, dirCache.ensureDir, path, queueManifestOp);
    } catch (error) {
      // A path can legitimately be gone again by the time this runs (e.g. a write immediately
      // followed by an rm) - the NEXT onChange for the same path already queued its own removal.
      if (error instanceof VfsError && error.code === "ENOENT") return;
      throw error;
    }
  };

  return {
    notify(path: string): void {
      const previous = pathChains.get(path) ?? Promise.resolve();
      const next = previous.finally(() =>
        resync(path).catch((error) => {
          console.error(`wcvm: OPFS persistence failed for ${path}:`, error);
        }),
      );
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

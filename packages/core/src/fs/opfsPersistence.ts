// Mirrors an in-memory Vfs to the Origin Private File System (OPFS), write-behind: a mutation
// answers its syscall immediately (the vfs is already updated synchronously), and the matching
// OPFS write happens afterward, in the background, never blocking the caller. Restoring the other
// direction (OPFS -> a fresh Vfs) happens once, before the FS Worker ever serves a syscall - see
// workers/fs/worker.ts.
//
// OPFS has no symlinks, so a script's own symlinks are simply not persisted - a known, documented
// simplification (PLAN.md's "Known differences"): real npm installs, the main reason for this
// feature, create very few (some package managers use symlinks for node_modules/.bin, but the
// actual package contents - what actually needs to survive a reload - are plain files/dirs).
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

/** Walks/creates every directory segment of `dirPath`, starting from `root`. */
const ensureDir = async (root: IOpfsDirHandle, dirPath: string): Promise<IOpfsDirHandle> => {
  let dir = root;
  for (const segment of segments(dirPath)) dir = await dir.getDirectoryHandle(segment, { create: true });
  return dir;
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

/** Recreates OPFS's tree inside `vfs` (called once, before the FS Worker serves anything). */
export const restoreFromOpfs = async (vfs: Vfs, root: IOpfsDirHandle, path = "/"): Promise<void> => {
  for await (const [name, handle] of root.entries()) {
    const childPath = path === "/" ? `/${name}` : `${path}/${name}`;
    if (handle.kind === "directory") {
      vfs.mkdir(childPath);
      await restoreFromOpfs(vfs, handle, childPath);
    } else {
      const file = await handle.getFile();
      vfs.writeFile(childPath, new Uint8Array(await file.arrayBuffer()));
    }
  }
};

const mirrorFile = async (root: IOpfsDirHandle, path: string, data: Uint8Array): Promise<void> => {
  const { dir, name } = splitPath(path);
  const dirHandle = await ensureDir(root, dir);
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

/** Mirrors `path` and, if it's a directory, its whole subtree - needed for a directory rename:
 *  the vfs fires one onChange for the moved directory's own new path, not one per descendant. */
const resyncSubtree = async (vfs: Vfs, root: IOpfsDirHandle, path: string): Promise<void> => {
  const stat = vfs.lstat(path);
  if (stat.kind === "symlink") return;
  if (stat.kind === "file") {
    await mirrorFile(root, path, vfs.readFile(path));
    return;
  }
  await ensureDir(root, path);
  for (const [name, kind] of vfs.readdirKinds(path)) {
    if (kind === "symlink") continue;
    await resyncSubtree(vfs, root, path === "/" ? `/${name}` : `${path}/${name}`);
  }
};

/**
 * Builds a `Vfs.onChange` reporter that mirrors every mutation to `root`, write-behind. Changes
 * are applied to OPFS strictly in the order they happened (a serial queue), not in whatever order
 * their async work happens to resolve - otherwise two quick writes to the same path could leave
 * OPFS with an older result than the vfs's own current one. A failed write is logged and does not
 * stop later ones (write-behind is inherently best-effort: the vfs itself is already the source of
 * truth for the running session either way).
 */
export const createOpfsMirror = (vfs: Vfs, root: IOpfsDirHandle): ((path: string) => void) => {
  let chain: Promise<void> = Promise.resolve();

  const resync = async (path: string): Promise<void> => {
    if (!vfs.exists(path)) {
      await removeMirrored(root, path);
      return;
    }
    try {
      await resyncSubtree(vfs, root, path);
    } catch (error) {
      // A path can legitimately be gone again by the time this runs (e.g. a write immediately
      // followed by an rm) - the NEXT onChange for the same path already queued its own removal.
      if (error instanceof VfsError && error.code === "ENOENT") return;
      throw error;
    }
  };

  return (path: string): void => {
    chain = chain.finally(() =>
      resync(path).catch((error) => {
        console.error(`wcvm: OPFS persistence failed for ${path}:`, error);
      }),
    );
  };
};

// In-memory POSIX-style virtual filesystem: inodes, directories, symlinks and a
// file-descriptor layer. Pure and synchronous, with no worker or protocol
// dependencies, so it can be tested directly and swapped for a faster backend
// (e.g. Rust/Wasm) later without touching FsServer.
//
// Paths are absolute POSIX paths. Every failure throws VfsError carrying an
// errno-style `code` (ENOENT, EEXIST, ENOTDIR, EISDIR, ENOTEMPTY, EINVAL, ...).

export const O_RDONLY = 0;
export const O_WRONLY = 1;
export const O_RDWR = 2;
export const O_CREAT = 0o100;
export const O_EXCL = 0o200;
export const O_TRUNC = 0o1000;
export const O_APPEND = 0o2000;
const O_ACCMODE = 3;

export const S_IFREG = 0o100000;
export const S_IFDIR = 0o040000;
export const S_IFLNK = 0o120000;

const MAX_SYMLINK_DEPTH = 40;

export class VfsError extends Error {
  readonly code: string;
  readonly path: string | undefined;

  constructor(code: string, path?: string) {
    super(path === undefined ? code : `${code}: ${path}`);
    this.name = "VfsError";
    this.code = code;
    this.path = path;
  }
}

export type NodeKind = "file" | "dir" | "symlink";

interface IInodeBase {
  ino: number;
  mode: number;
  nlink: number;
  atimeMs: number;
  mtimeMs: number;
  ctimeMs: number;
  birthtimeMs: number;
}
interface IFileInode extends IInodeBase {
  kind: "file";
  data: Uint8Array;
  size: number;
}
interface IDirInode extends IInodeBase {
  kind: "dir";
  entries: Map<string, Inode>;
}
interface ISymlinkInode extends IInodeBase {
  kind: "symlink";
  target: string;
}
type Inode = IFileInode | IDirInode | ISymlinkInode;

export interface IStat {
  ino: number;
  kind: NodeKind;
  /** Type bits (S_IF*) OR'd with permission bits. */
  mode: number;
  size: number;
  nlink: number;
  atimeMs: number;
  mtimeMs: number;
  ctimeMs: number;
  birthtimeMs: number;
}

interface IFdEntry {
  node: Inode;
  position: number;
  flags: number;
  /** The resolved path this fd was opened with, for watch reporting. A rename elsewhere after
   *  open leaves this stale (POSIX fds aren't path-addressed) - a known, documented simplification. */
  path: string;
}

/** "rename": a name appeared, disappeared or moved (mkdir, unlink, rm, rename, symlink, link,
 *  a writeFile/open that creates a new file). "change": an existing file/dir's content or
 *  attributes changed (writeFile/write/ftruncate on existing content, chmod, utimes). Mirrors
 *  the two event kinds real fs.watch delivers (inotify's many event types, coalesced). */
export type VfsChangeKind = "rename" | "change";
export type VfsChangeReporter = (path: string, kind: VfsChangeKind) => void;

interface IResolved {
  parent: IDirInode | null;
  name: string;
  node: Inode | undefined;
  realPath: string;
}

const TYPE_BITS: Record<NodeKind, number> = {
  file: S_IFREG,
  dir: S_IFDIR,
  symlink: S_IFLNK,
};

const sizeOf = (node: Inode): number => {
  if (node.kind === "file") return node.size;
  if (node.kind === "symlink") return node.target.length;
  return node.entries.size;
};

const isWritable = (flags: number) => (flags & O_ACCMODE) !== O_RDONLY;
const isReadable = (flags: number) => (flags & O_ACCMODE) !== O_WRONLY;

export class Vfs {
  private nextIno = 1;
  private readonly root: IDirInode;
  private readonly fds = new Map<number, IFdEntry>();

  /** Fires after every mutation, real path plus what kind of change it was. A plain field
   *  (not a constructor param) so a caller holding an existing Vfs (tests, FsServer's default
   *  param) can still wire one in - see FsServer, the only real subscriber (fs.watch's registry
   *  and matching logic live there, to keep this class free of watcher/client bookkeeping). */
  onChange: VfsChangeReporter = () => {};

  constructor() {
    this.root = this.newDir(0o755);
  }

  // ---- node construction ---------------------------------------------------

  private stamp() {
    const now = Date.now();
    return { atimeMs: now, mtimeMs: now, ctimeMs: now, birthtimeMs: now };
  }

  private newDir(mode: number): IDirInode {
    return {
      kind: "dir",
      ino: this.nextIno++,
      mode,
      nlink: 1,
      entries: new Map(),
      ...this.stamp(),
    };
  }

  private newFile(mode: number): IFileInode {
    return {
      kind: "file",
      ino: this.nextIno++,
      mode,
      nlink: 1,
      data: new Uint8Array(0),
      size: 0,
      ...this.stamp(),
    };
  }

  private newSymlink(target: string): ISymlinkInode {
    return {
      kind: "symlink",
      ino: this.nextIno++,
      mode: 0o777,
      nlink: 1,
      target,
      ...this.stamp(),
    };
  }

  private touch(node: Inode) {
    const now = Date.now();
    node.mtimeMs = now;
    node.ctimeMs = now;
  }

  private link_(parent: IDirInode, name: string, node: Inode) {
    parent.entries.set(name, node);
    this.touch(parent);
  }

  private unlinkEntry(parent: IDirInode, name: string) {
    const node = parent.entries.get(name);
    parent.entries.delete(name);
    if (node) node.nlink--;
    this.touch(parent);
  }

  // ---- path resolution -----------------------------------------------------

  /**
   * Walks `path` component by component, following symlinks in the middle of a
   * path always and on the last component only when `followLast`. A missing
   * last component is not an error: it comes back with `node: undefined` and
   * its parent so callers can create it.
   */
  private walk(path: string, followLast: boolean): IResolved {
    if (!path.startsWith("/")) throw new VfsError("EINVAL", path);

    const parts = path.split("/");
    let stack: IDirInode[] = [this.root];
    let names: string[] = [""];
    let last: IResolved | null = null;
    let links = 0;

    const base = () => "/" + names.slice(1).join("/");
    const atDir = (): IResolved => ({
      parent: stack.length > 1 ? (stack.at(-2) ?? null) : null,
      name: names.at(-1) as string,
      node: stack.at(-1) as IDirInode,
      realPath: base(),
    });

    while (parts.length > 0) {
      const part = parts.shift() as string;
      if (part === "" || part === ".") continue;
      if (part === "..") {
        if (stack.length > 1) {
          stack.pop();
          names.pop();
        }
        last = null;
        continue;
      }

      const dir = stack.at(-1) as IDirInode;
      const remaining = parts.some((p) => p !== "" && p !== ".");
      const child = dir.entries.get(part);

      if (child === undefined) {
        if (remaining) throw new VfsError("ENOENT", path);
        return {
          parent: dir,
          name: part,
          node: undefined,
          realPath: base() === "/" ? `/${part}` : `${base()}/${part}`,
        };
      }

      if (child.kind === "symlink" && (remaining || followLast)) {
        if (++links > MAX_SYMLINK_DEPTH) throw new VfsError("ELOOP", path);
        if (child.target.startsWith("/")) {
          stack = [this.root];
          names = [""];
        }
        parts.unshift(...child.target.split("/"));
        last = null;
        continue;
      }

      if (child.kind === "dir") {
        stack.push(child);
        names.push(part);
        last = atDir();
      } else {
        if (remaining) throw new VfsError("ENOTDIR", path);
        last = {
          parent: dir,
          name: part,
          node: child,
          realPath: base() === "/" ? `/${part}` : `${base()}/${part}`,
        };
      }
    }

    return last ?? atDir();
  }

  private lookup(path: string, followLast = true): Inode {
    const { node } = this.walk(path, followLast);
    if (!node) throw new VfsError("ENOENT", path);
    return node;
  }

  private lookupDir(path: string): IDirInode {
    const node = this.lookup(path);
    if (node.kind !== "dir") throw new VfsError("ENOTDIR", path);
    return node;
  }

  private toStat(node: Inode): IStat {
    const typeBits = TYPE_BITS[node.kind];
    return {
      ino: node.ino,
      kind: node.kind,
      mode: typeBits | node.mode,
      size: sizeOf(node),
      nlink: node.nlink,
      atimeMs: node.atimeMs,
      mtimeMs: node.mtimeMs,
      ctimeMs: node.ctimeMs,
      birthtimeMs: node.birthtimeMs,
    };
  }

  // ---- path-based operations -----------------------------------------------

  stat(path: string): IStat {
    return this.toStat(this.lookup(path, true));
  }

  lstat(path: string): IStat {
    return this.toStat(this.lookup(path, false));
  }

  exists(path: string): boolean {
    try {
      return this.walk(path, true).node !== undefined;
    } catch (error) {
      if (error instanceof VfsError) return false;
      throw error;
    }
  }

  realpath(path: string): string {
    const resolved = this.walk(path, true);
    if (!resolved.node) throw new VfsError("ENOENT", path);
    return resolved.realPath;
  }

  mkdir(path: string, options: { recursive?: boolean; mode?: number } = {}) {
    const { recursive = false, mode = 0o755 } = options;

    if (!recursive) {
      const { parent, name, node } = this.walk(path, false);
      if (node || !parent) throw new VfsError("EEXIST", path);
      this.link_(parent, name, this.newDir(mode));
      this.onChange(path, "rename");
      return;
    }

    const segments = path.split("/").filter((s) => s !== "");
    let current = "";
    segments.forEach((segment, index) => {
      current += `/${segment}`;
      const { parent, name, node } = this.walk(current, true);
      if (node) {
        if (node.kind !== "dir") {
          const isLast = index === segments.length - 1;
          throw new VfsError(isLast ? "EEXIST" : "ENOTDIR", path);
        }
        return;
      }
      this.link_(parent as IDirInode, name, this.newDir(mode));
      this.onChange(current, "rename");
    });
  }

  readdir(path: string): string[] {
    return Array.from(this.lookupDir(path).entries.keys()).sort();
  }

  readFile(path: string): Uint8Array {
    const node = this.lookup(path);
    if (node.kind === "dir") throw new VfsError("EISDIR", path);
    if (node.kind !== "file") throw new VfsError("EINVAL", path);
    return node.data.slice(0, node.size);
  }

  writeFile(path: string, data: Uint8Array, options: { mode?: number } = {}) {
    const { parent, name, node } = this.walk(path, true);
    if (node) {
      if (node.kind === "dir") throw new VfsError("EISDIR", path);
      if (node.kind !== "file") throw new VfsError("EINVAL", path);
      this.setSize(node, 0);
      this.putBytes(node, 0, data);
      this.onChange(path, "change");
      return;
    }
    if (!parent) throw new VfsError("EISDIR", path);
    const file = this.newFile(options.mode ?? 0o644);
    this.putBytes(file, 0, data);
    this.link_(parent, name, file);
    this.onChange(path, "rename");
  }

  unlink(path: string) {
    const { parent, name, node } = this.walk(path, false);
    if (!node) throw new VfsError("ENOENT", path);
    if (node.kind === "dir") throw new VfsError("EISDIR", path);
    this.unlinkEntry(parent as IDirInode, name);
    this.onChange(path, "rename");
  }

  rmdir(path: string) {
    const { parent, name, node } = this.walk(path, false);
    if (!node) throw new VfsError("ENOENT", path);
    if (node.kind !== "dir") throw new VfsError("ENOTDIR", path);
    if (!parent) throw new VfsError("EBUSY", path);
    if (node.entries.size > 0) throw new VfsError("ENOTEMPTY", path);
    this.unlinkEntry(parent, name);
    this.onChange(path, "rename");
  }

  rm(path: string, options: { recursive?: boolean } = {}) {
    const { parent, name, node } = this.walk(path, false);
    if (!node) throw new VfsError("ENOENT", path);
    if (!parent) throw new VfsError("EBUSY", path);
    if (node.kind === "dir" && !options.recursive) {
      throw new VfsError("EISDIR", path);
    }
    this.unlinkEntry(parent, name);
    this.onChange(path, "rename");
  }

  rename(from: string, to: string) {
    const source = this.walk(from, false);
    if (!source.node) throw new VfsError("ENOENT", from);
    if (!source.parent) throw new VfsError("EBUSY", from);

    const target = this.walk(to, false);
    if (!target.parent) throw new VfsError("EBUSY", to);
    if (target.node === source.node) return;

    if (source.node.kind === "dir" && this.contains(source.node, target.parent)) {
      throw new VfsError("EINVAL", to);
    }

    if (target.node) {
      if (source.node.kind === "dir") {
        if (target.node.kind !== "dir") throw new VfsError("ENOTDIR", to);
        if (target.node.entries.size > 0) throw new VfsError("ENOTEMPTY", to);
      } else if (target.node.kind === "dir") {
        throw new VfsError("EISDIR", to);
      }
      this.unlinkEntry(target.parent, target.name);
    }

    source.parent.entries.delete(source.name);
    this.touch(source.parent);
    this.link_(target.parent, target.name, source.node);
    source.node.ctimeMs = Date.now();
    this.onChange(from, "rename");
    this.onChange(to, "rename");
  }

  /** True when `needle` is `dir` itself or lives anywhere beneath it. */
  private contains(dir: IDirInode, needle: IDirInode): boolean {
    if (dir === needle) return true;
    for (const child of dir.entries.values()) {
      if (child.kind === "dir" && this.contains(child, needle)) return true;
    }
    return false;
  }

  symlink(target: string, path: string) {
    const { parent, name, node } = this.walk(path, false);
    if (node || !parent) throw new VfsError("EEXIST", path);
    this.link_(parent, name, this.newSymlink(target));
    this.onChange(path, "rename");
  }

  readlink(path: string): string {
    const node = this.lookup(path, false);
    if (node.kind !== "symlink") throw new VfsError("EINVAL", path);
    return node.target;
  }

  chmod(path: string, mode: number) {
    const node = this.lookup(path, true);
    node.mode = mode & 0o7777;
    node.ctimeMs = Date.now();
    this.onChange(path, "change");
  }

  /** Hard link: `path` becomes another name for the same file. Directories cannot be linked. */
  link(existing: string, path: string) {
    const source = this.lookup(existing, false);
    if (source.kind === "dir") throw new VfsError("EPERM", existing);
    const { parent, name, node } = this.walk(path, false);
    if (node || !parent) throw new VfsError("EEXIST", path);
    source.nlink++;
    this.link_(parent, name, source);
    this.onChange(path, "rename");
  }

  /** Sets access and modification times (milliseconds since the epoch). */
  utimes(path: string, atimeMs: number, mtimeMs: number, followLink = true) {
    this.setTimes(this.lookup(path, followLink), atimeMs, mtimeMs);
    this.onChange(path, "change");
  }

  futimes(fd: number, atimeMs: number, mtimeMs: number) {
    const entry = this.entry(fd);
    this.setTimes(entry.node, atimeMs, mtimeMs);
    this.onChange(entry.path, "change");
  }

  private setTimes(node: Inode, atimeMs: number, mtimeMs: number) {
    node.atimeMs = atimeMs;
    node.mtimeMs = mtimeMs;
    node.ctimeMs = Date.now();
  }

  /** Like readdir, but each name comes with its kind, in one call. */
  readdirKinds(path: string): Array<[string, NodeKind]> {
    return Array.from(this.lookupDir(path).entries)
      .map(([name, node]): [string, NodeKind] => [name, node.kind])
      .sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
  }

  // ---- file bytes ----------------------------------------------------------

  /** Resizes a file; bytes exposed by growing are zero. */
  private setSize(file: IFileInode, size: number) {
    if (size > file.data.length) {
      const grown = new Uint8Array(Math.max(size, file.data.length * 2));
      grown.set(file.data.subarray(0, file.size));
      file.data = grown;
    } else if (size < file.size) {
      file.data.fill(0, size, file.size);
    }
    file.size = size;
    this.touch(file);
  }

  private putBytes(file: IFileInode, position: number, bytes: Uint8Array) {
    const end = position + bytes.length;
    if (end > file.size) this.setSize(file, end);
    file.data.set(bytes, position);
    this.touch(file);
  }

  // ---- file descriptors ----------------------------------------------------

  open(path: string, flags: number, mode = 0o666): number {
    const { parent, name, node, realPath } = this.walk(path, true);
    let target: Inode;

    if (node) {
      if (flags & O_CREAT && flags & O_EXCL) throw new VfsError("EEXIST", path);
      if (node.kind === "dir" && isWritable(flags)) {
        throw new VfsError("EISDIR", path);
      }
      target = node;
      // No onChange here: a truncate-then-write (writeFileSync's default flag, "w") would
      // otherwise report two "change"s for one logical write. A truncate with nothing written
      // after (fs.truncateSync) goes through open('r+') + ftruncate(), which already reports one.
      if (flags & O_TRUNC && isWritable(flags) && node.kind === "file") this.setSize(node, 0);
    } else {
      if (!(flags & O_CREAT)) throw new VfsError("ENOENT", path);
      if (!parent) throw new VfsError("EISDIR", path);
      const file = this.newFile(mode & 0o7777);
      this.link_(parent, name, file);
      target = file;
      this.onChange(realPath, "rename");
    }

    let fd = 3;
    while (this.fds.has(fd)) fd++;
    this.fds.set(fd, { node: target, position: 0, flags, path: realPath });
    return fd;
  }

  private entry(fd: number): IFdEntry {
    const entry = this.fds.get(fd);
    if (!entry) throw new VfsError("EBADF");
    return entry;
  }

  close(fd: number) {
    this.entry(fd);
    this.fds.delete(fd);
  }

  /** `position < 0` reads at (and advances) the descriptor's cursor. */
  read(fd: number, length: number, position: number): Uint8Array {
    const entry = this.entry(fd);
    if (!isReadable(entry.flags)) throw new VfsError("EBADF");
    if (entry.node.kind === "dir") throw new VfsError("EISDIR");
    if (entry.node.kind !== "file") throw new VfsError("EINVAL");

    const file = entry.node;
    const start = position < 0 ? entry.position : position;
    const end = Math.min(start + length, file.size);
    const out = start >= end ? new Uint8Array(0) : file.data.slice(start, end);
    if (position < 0) entry.position = start + out.length;
    return out;
  }

  /** `position < 0` writes at (and advances) the cursor; O_APPEND always appends. */
  write(fd: number, bytes: Uint8Array, position: number): number {
    const entry = this.entry(fd);
    if (!isWritable(entry.flags)) throw new VfsError("EBADF");
    if (entry.node.kind !== "file") throw new VfsError("EINVAL");

    const file = entry.node;
    const cursor = position < 0 ? entry.position : position;
    const start = entry.flags & O_APPEND ? file.size : cursor;
    this.putBytes(file, start, bytes);
    if (position < 0 || entry.flags & O_APPEND) {
      entry.position = start + bytes.length;
    }
    this.onChange(entry.path, "change");
    return bytes.length;
  }

  fstat(fd: number): IStat {
    return this.toStat(this.entry(fd).node);
  }

  ftruncate(fd: number, length: number) {
    const entry = this.entry(fd);
    if (!isWritable(entry.flags)) throw new VfsError("EBADF");
    if (entry.node.kind !== "file") throw new VfsError("EINVAL");
    this.setSize(entry.node, length);
    this.onChange(entry.path, "change");
  }
}

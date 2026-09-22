// Services file system syscalls against one Vfs, directly over each client's
// SharedArrayBuffer. Environment-agnostic: the File System Worker feeds it
// doorbells, tests can call service() directly.
//
// Clients (the kernel, each process) register their SAB once. A doorbell then
// says "client N has a request pending"; service() decodes it, runs it against
// the Vfs, writes the answer back into that SAB and wakes the parked caller.

import {
  type ISyscallViews,
  SyscallError,
  FLAG_NO_FOLLOW,
  FLAG_RECURSIVE,
  OP_CHMOD,
  OP_CLOSE,
  OP_EXISTS,
  OP_FD_READ,
  OP_FD_WRITE,
  OP_FSTAT,
  OP_FTRUNCATE,
  OP_FUTIMES,
  OP_LINK,
  OP_LSTAT,
  OP_MKDIR,
  OP_OPEN,
  OP_READDIR,
  OP_READDIR_KINDS,
  OP_READLINK,
  OP_READ_FILE,
  OP_REALPATH,
  OP_RENAME,
  OP_RM,
  OP_RMDIR,
  OP_STAT,
  OP_SYMLINK,
  OP_UNLINK,
  OP_UTIMES,
  OP_WATCH_START,
  OP_WATCH_STOP,
  OP_WRITE_FILE,
  bytesToF64,
  bytesToU32,
  decodeBytes,
  encodeString,
  hasPendingRequest,
  isFsOpcode,
  makeViews,
  readRequest,
  respondErr,
  respondOk,
  u32ToBytes,
} from "../protocols/syscall";
import { Vfs, type VfsChangeKind } from "./Vfs";

const EMPTY = new Uint8Array(0);
const json = (value: unknown) => encodeString(JSON.stringify(value));

/** A missing request field is a malformed frame, not an empty value. */
const at = (fields: Uint8Array[], index: number): Uint8Array => {
  const field = fields[index];
  if (field === undefined) throw new SyscallError("EPROTO");
  return field;
};

type Handler = (fields: Uint8Array[], flags: number, clientId: number) => Uint8Array;

/** clientId owning a watch, the eventType a change was reported as, and filename relative to the watched path. */
export type WatchEventReporter = (clientId: number, watchId: number, eventType: VfsChangeKind, filename: string) => void;

interface IWatch {
  clientId: number;
  /** Watched path, real/resolved (as returned by the vfs - matches onChange's own paths). */
  path: string;
  recursive: boolean;
}

const basename = (path: string): string => path.slice(path.lastIndexOf("/") + 1);

/** True when `path` is `watchPath` itself, or (recursively, or as a direct child otherwise) beneath it. A
 *  watch on a FILE only ever matches exactly - nothing can be "beneath" a file's own path in this scheme. */
const watchMatches = (watch: IWatch, path: string): boolean => {
  if (path === watch.path) return true;
  const prefix = watch.path === "/" ? "/" : `${watch.path}/`;
  if (!path.startsWith(prefix)) return false;
  return watch.recursive || !path.slice(prefix.length).includes("/");
};

/** filename delivered to the callback: the watched file's own basename, or the path relative to a watched directory. */
const watchRelativeName = (watch: IWatch, path: string): string => {
  if (path === watch.path) return basename(path);
  const prefix = watch.path === "/" ? "/" : `${watch.path}/`;
  return path.slice(prefix.length);
};

class FsServer {
  private readonly clients = new Map<number, ISyscallViews>();
  /** fds each client opened, so a client that dies without closing them cannot leak them. */
  private readonly openFds = new Map<number, Set<number>>();
  private readonly handlers: Map<number, Handler>;
  private readonly watches = new Map<number, IWatch>();
  private nextWatchId = 1;
  private readonly onWatchEvent: WatchEventReporter;

  readonly vfs: Vfs;

  /** `onWatchEvent` is how a real transport (the File System Worker) delivers a change to
   *  whichever client is watching - see workers/fs/worker.ts. Defaults to a no-op so FsServer
   *  stays directly testable (service() driven) without one. */
  constructor(vfs: Vfs = new Vfs(), onWatchEvent: WatchEventReporter = () => {}) {
    this.vfs = vfs;
    this.onWatchEvent = onWatchEvent;
    vfs.onChange = (path, kind) => {
      for (const [watchId, watch] of this.watches) {
        if (watchMatches(watch, path)) this.onWatchEvent(watch.clientId, watchId, kind, watchRelativeName(watch, path));
      }
    };
    const path = (fields: Uint8Array[], i = 0) => decodeBytes(at(fields, i));

    this.handlers = new Map<number, Handler>([
      [OP_READ_FILE, (f) => vfs.readFile(path(f))],
      [
        OP_WRITE_FILE,
        (f) => {
          vfs.writeFile(path(f), at(f, 1));
          return EMPTY;
        },
      ],
      [OP_EXISTS, (f) => Uint8Array.of(vfs.exists(path(f)) ? 1 : 0)],
      [OP_READDIR, (f) => json(vfs.readdir(path(f)))],
      [
        OP_MKDIR,
        (f, flags) => {
          vfs.mkdir(path(f), { recursive: (flags & FLAG_RECURSIVE) !== 0 });
          return EMPTY;
        },
      ],
      [OP_STAT, (f) => json(vfs.stat(path(f)))],
      [OP_LSTAT, (f) => json(vfs.lstat(path(f)))],
      [
        OP_UNLINK,
        (f) => {
          vfs.unlink(path(f));
          return EMPTY;
        },
      ],
      [
        OP_RMDIR,
        (f) => {
          vfs.rmdir(path(f));
          return EMPTY;
        },
      ],
      [
        OP_RM,
        (f, flags) => {
          vfs.rm(path(f), { recursive: (flags & FLAG_RECURSIVE) !== 0 });
          return EMPTY;
        },
      ],
      [
        OP_RENAME,
        (f) => {
          vfs.rename(path(f, 0), path(f, 1));
          return EMPTY;
        },
      ],
      [
        OP_SYMLINK,
        (f) => {
          vfs.symlink(path(f, 0), path(f, 1));
          return EMPTY;
        },
      ],
      [OP_READLINK, (f) => encodeString(vfs.readlink(path(f)))],
      [OP_REALPATH, (f) => encodeString(vfs.realpath(path(f)))],
      [
        OP_CHMOD,
        (f) => {
          vfs.chmod(path(f), bytesToU32(at(f, 1)));
          return EMPTY;
        },
      ],
      [
        OP_OPEN,
        (f, _flags, client) => {
          const fd = vfs.open(path(f), bytesToU32(at(f, 1)), bytesToU32(at(f, 2)));
          let set = this.openFds.get(client);
          if (!set) this.openFds.set(client, (set = new Set()));
          set.add(fd);
          return u32ToBytes(fd);
        },
      ],
      [
        OP_CLOSE,
        (f, _flags, client) => {
          const fd = bytesToU32(at(f, 0));
          vfs.close(fd);
          this.openFds.get(client)?.delete(fd);
          return EMPTY;
        },
      ],
      [
        OP_LINK,
        (f) => {
          vfs.link(path(f, 0), path(f, 1));
          return EMPTY;
        },
      ],
      [
        OP_UTIMES,
        (f, flags) => {
          vfs.utimes(
            path(f),
            bytesToF64(at(f, 1)),
            bytesToF64(at(f, 2)),
            (flags & FLAG_NO_FOLLOW) === 0,
          );
          return EMPTY;
        },
      ],
      [
        OP_FUTIMES,
        (f) => {
          vfs.futimes(bytesToU32(at(f, 0)), bytesToF64(at(f, 1)), bytesToF64(at(f, 2)));
          return EMPTY;
        },
      ],
      [OP_READDIR_KINDS, (f) => json(vfs.readdirKinds(path(f)))],
      [
        OP_FD_READ,
        (f) => vfs.read(bytesToU32(at(f, 0)), bytesToU32(at(f, 1)), bytesToF64(at(f, 2))),
      ],
      [
        OP_FD_WRITE,
        (f) =>
          u32ToBytes(vfs.write(bytesToU32(at(f, 0)), at(f, 2), bytesToF64(at(f, 1)))),
      ],
      [OP_FSTAT, (f) => json(vfs.fstat(bytesToU32(at(f, 0))))],
      [
        OP_FTRUNCATE,
        (f) => {
          vfs.ftruncate(bytesToU32(at(f, 0)), bytesToF64(at(f, 1)));
          return EMPTY;
        },
      ],
      [
        OP_WATCH_START,
        (f, flags, client) => {
          // Resolved, not the path as given: onChange() always reports the vfs's own resolved
          // paths (see walk()'s realPath), so matching against anything else - a symlink to the
          // watched directory, say - would silently never fire. Throws ENOENT if missing,
          // matching real fs.watch's default throwIfNoEntry.
          const target = vfs.realpath(path(f));
          const watchId = this.nextWatchId++;
          this.watches.set(watchId, { clientId: client, path: target, recursive: (flags & FLAG_RECURSIVE) !== 0 });
          return u32ToBytes(watchId);
        },
      ],
      [
        OP_WATCH_STOP,
        (f) => {
          this.watches.delete(bytesToU32(at(f, 0)));
          return EMPTY;
        },
      ],
    ]);
  }

  registerClient(clientId: number, sab: SharedArrayBuffer): void {
    this.clients.set(clientId, makeViews(sab));
  }

  unregisterClient(clientId: number): void {
    this.clients.delete(clientId);
    for (const [watchId, watch] of this.watches) {
      if (watch.clientId === clientId) this.watches.delete(watchId);
    }
    for (const fd of this.openFds.get(clientId) ?? []) {
      try {
        this.vfs.close(fd);
      } catch {
        // already closed
      }
    }
    this.openFds.delete(clientId);
  }

  /** Answers `clientId`'s pending request, if it still has one. */
  service(clientId: number): void {
    const views = this.clients.get(clientId);
    if (!views || !hasPendingRequest(views)) return;

    try {
      const { opcode, flags, fields } = readRequest(views);
      const handler = isFsOpcode(opcode) ? this.handlers.get(opcode) : undefined;
      if (!handler) {
        respondErr(views, "ENOSYS");
        return;
      }
      respondOk(views, handler(fields, flags, clientId));
    } catch (error) {
      const code = (error as { code?: unknown }).code;
      respondErr(views, typeof code === "string" ? code : "EIO");
    }
  }
}

export { FsServer };

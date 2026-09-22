// internalBinding('fs'): the native half of Node's lib/fs.js, over the sync fs
// client. Node calls every operation in one of three ways, chosen by the last
// argument, and the result must be delivered accordingly:
//
//   req === undefined         synchronous: return the value, or throw a uv exception
//   req instanceof FSReqCallback   return undefined; later call req.oncomplete(err)
//                                  or req.oncomplete(null, value)
//   req === kUsePromises      return a promise
//
// The work itself always runs immediately (the fs syscall is a blocking call
// into the fs worker either way); only its completion is deferred, on the event
// loop, holding the process alive until it is delivered.

import type { IFsClient, IFsStat } from "../../fs/fsClient";
import type { EventLoop } from "../eventLoop";
import { FS_CONSTANTS } from "./constants";
import { hasErrno, uvCode, uvException } from "./uvErrors";

export interface IFsBindingContext {
  fs: IFsClient;
  /** The process's working directory: relative paths resolve against it, as in Node. */
  cwd(): string;
  loop: EventLoop;
  requireBuiltin(id: string): any;
  /** Writes to the process's stdout (fd 1) / stderr (fd 2). */
  writeStdio(fd: 1 | 2, chunk: Uint8Array): void;
}

const kUsePromises = Symbol("fs_use_promises_symbol");
const STAT_FIELDS = 18;

// StatWatcher's poll timer is a native handle, invisible to Node's own JS timers module (real
// libuv's uv_fs_poll is its own handle type, unrelated to uv_timer) - captured at module-import
// time so it can't be intercepted by Node's own same-named globals once installed onto a real
// worker's `self` (see eventLoop.ts's nativeSetTimeout for the same gotcha).
const nativeSetTimeout = globalThis.setTimeout.bind(globalThis);
const nativeClearTimeout = globalThis.clearTimeout.bind(globalThis);
const scheduleNative = (fn: () => void, ms: number): (() => void) => {
  const id = nativeSetTimeout(fn, ms);
  return () => nativeClearTimeout(id);
};

/** Concatenates two same-shape stat arrays (new block, then old), matching getStatsFromBinding's expected layout. */
const combineStats = (curr: Float64Array | BigInt64Array, prev: Float64Array | BigInt64Array, bigint: boolean): Float64Array | BigInt64Array => {
  if (bigint) {
    const out = new BigInt64Array(STAT_FIELDS * 2);
    out.set(curr as BigInt64Array, 0);
    out.set(prev as BigInt64Array, STAT_FIELDS);
    return out;
  }
  const out = new Float64Array(STAT_FIELDS * 2);
  out.set(curr as Float64Array, 0);
  out.set(prev as Float64Array, STAT_FIELDS);
  return out;
};
const UMASK = 0o022;

const { O_DIRECTORY, S_IFIFO, S_IFDIR, S_IFLNK, S_IFREG, W_OK, X_OK, R_OK } = FS_CONSTANTS;

class FSReqCallback {
  oncomplete: ((...args: unknown[]) => void) | undefined;
  context: unknown;
  readonly bigint: boolean;
  constructor(bigint = false) {
    this.bigint = bigint;
  }
}

const KIND_TO_DIRENT: Record<IFsStat["kind"], number> = {
  file: FS_CONSTANTS.UV_DIRENT_FILE,
  dir: FS_CONSTANTS.UV_DIRENT_DIR,
  symlink: FS_CONSTANTS.UV_DIRENT_LINK,
};

const splitMs = (ms: number): [number, number] => {
  const sec = Math.floor(ms / 1000);
  return [sec, Math.round((ms - sec * 1000) * 1e6)];
};

/** Lays a stat out as node_file.h's FsStatsOffset: dev, mode, nlink, uid, gid, rdev, blksize, ino, size, blocks, then atime/mtime/ctime/birthtime as (sec, nsec). */
const statArray = (stat: IFsStat, bigint: boolean): Float64Array | BigInt64Array => {
  const [as, an] = splitMs(stat.atimeMs);
  const [ms, mn] = splitMs(stat.mtimeMs);
  const [cs, cn] = splitMs(stat.ctimeMs);
  const [bs, bn] = splitMs(stat.birthtimeMs);
  const values = [
    1, stat.mode, stat.nlink, 1000, 1000, 0, 4096, stat.ino, stat.size,
    Math.ceil(stat.size / 512), as, an, ms, mn, cs, cn, bs, bn,
  ];
  return bigint
    ? BigInt64Array.from(values.map((v) => BigInt(Math.trunc(v))))
    : Float64Array.from(values);
};

const stdioStat = (): IFsStat => ({
  ino: 0, kind: "file", mode: S_IFIFO | 0o600, size: 0, nlink: 1,
  atimeMs: 0, mtimeMs: 0, ctimeMs: 0, birthtimeMs: 0,
});

/**
 * The fs client wants absolute paths; Node's fs takes relative ones and resolves
 * them against process.cwd(). Wrapping the client keeps that in one place, and the
 * binding keeps passing the caller's original strings to its error messages.
 */
const resolvingClient = (fs: IFsClient, cwd: () => string): IFsClient => {
  const abs = (p: string) => {
    if (p.startsWith("/")) return p;
    const base = cwd();
    return base === "/" ? `/${p}` : `${base}/${p}`;
  };
  return {
    ...fs,
    readFile: (p) => fs.readFile(abs(p)),
    writeFile: (p, d) => fs.writeFile(abs(p), d),
    exists: (p) => fs.exists(abs(p)),
    readdir: (p) => fs.readdir(abs(p)),
    readdirKinds: (p) => fs.readdirKinds(abs(p)),
    mkdir: (p, o) => fs.mkdir(abs(p), o),
    stat: (p) => fs.stat(abs(p)),
    lstat: (p) => fs.lstat(abs(p)),
    unlink: (p) => fs.unlink(abs(p)),
    rmdir: (p) => fs.rmdir(abs(p)),
    rm: (p, o) => fs.rm(abs(p), o),
    rename: (a, b) => fs.rename(abs(a), abs(b)),
    // A symlink's target is stored as given (relative targets are relative to the link).
    symlink: (target, p) => fs.symlink(target, abs(p)),
    readlink: (p) => fs.readlink(abs(p)),
    realpath: (p) => fs.realpath(abs(p)),
    chmod: (p, m) => fs.chmod(abs(p), m),
    link: (a, b) => fs.link(abs(a), abs(b)),
    utimes: (p, a, m, o) => fs.utimes(abs(p), a, m, o),
    open: (p, f, m) => fs.open(abs(p), f, m),
    watchStart: (p, recursive) => fs.watchStart(abs(p), recursive),
  };
};

const createFsBinding = (ctx: IFsBindingContext) => {
  const { loop, writeStdio } = ctx;
  const fs = resolvingClient(ctx.fs, ctx.cwd);
  const decoder = new TextDecoder();
  const Buffer = () => ctx.requireBuiltin("buffer").Buffer;

  // ---- delivery ------------------------------------------------------------------

  /** A syscall error becomes Node's uv exception; anything else is a bug and passes through. */
  const toUv = (error: unknown, syscall: string, path?: string, dest?: string) =>
    hasErrno(error) ? uvException(error.code, syscall, path, dest) : error;

  const later = (deliver: () => void) => {
    const release = loop.ref();
    loop.post(() => {
      try {
        deliver();
      } finally {
        release();
      }
    });
  };

  const dispatch = (req: unknown, syscall: string, path: string | undefined, dest: string | undefined, op: () => unknown) => {
    if (req === undefined) {
      try {
        return op();
      } catch (error) {
        throw toUv(error, syscall, path, dest);
      }
    }

    let value: unknown;
    let failure: unknown;
    let failed = false;
    try {
      value = op();
    } catch (error) {
      failed = true;
      failure = toUv(error, syscall, path, dest);
    }

    if (req === kUsePromises) {
      return new Promise((resolve, reject) => later(() => (failed ? reject(failure) : resolve(value))));
    }
    const callback = req as FSReqCallback;
    later(() => {
      if (failed) callback.oncomplete?.call(callback, failure);
      else if (value === undefined) callback.oncomplete?.call(callback, null);
      else callback.oncomplete?.call(callback, null, value);
    });
    return undefined;
  };

  // ---- helpers -------------------------------------------------------------------

  const isStdio = (fd: number) => fd >= 0 && fd <= 2;
  const pos = (p: unknown): number => (typeof p === "bigint" ? Number(p) : typeof p === "number" ? p : -1);

  const readWhole = (fd: number): Uint8Array => {
    const chunks: Uint8Array[] = [];
    let total = 0;
    for (;;) {
      const chunk = fs.read(fd, 512 * 1024, -1);
      if (chunk.length === 0) break;
      chunks.push(chunk);
      total += chunk.length;
    }
    const out = new Uint8Array(total);
    let offset = 0;
    for (const chunk of chunks) {
      out.set(chunk, offset);
      offset += chunk.length;
    }
    return out;
  };

  const writeAll = (fd: number, bytes: Uint8Array, position: number): number => {
    if (fd === 1 || fd === 2) {
      writeStdio(fd, Uint8Array.prototype.slice.call(bytes));
      return bytes.length;
    }
    let written = 0;
    while (written < bytes.length) {
      const n = fs.write(fd, bytes.subarray(written, written + 512 * 1024), position < 0 ? -1 : position + written);
      if (n === 0) break;
      written += n;
    }
    return written;
  };

  const encodeName = (name: string, encoding: unknown) =>
    encoding === "buffer" ? Buffer().from(name) : name;

  const checkAccess = (stat: IFsStat, mode: number) => {
    const owner = (stat.mode >> 6) & 7;
    if (((mode & (R_OK | W_OK | X_OK)) & ~owner) !== 0) {
      throw Object.assign(new Error("EACCES"), { code: "EACCES" });
    }
  };

  const eachStat = (path: string, follow: boolean) => (follow ? fs.stat(path) : fs.lstat(path));

  const firstMissingAncestor = (path: string): string | undefined => {
    const parts = path.split("/").filter(Boolean);
    let current = "";
    for (const part of parts) {
      current += `/${part}`;
      try {
        fs.stat(current);
      } catch {
        return current;
      }
    }
    return undefined;
  };

  const randomSuffix = () => {
    const alphabet = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";
    let out = "";
    for (let i = 0; i < 6; i++) out += alphabet[Math.floor(Math.random() * alphabet.length)];
    return out;
  };

  // ---- file handles (fs/promises) -------------------------------------------------

  class FileHandle {
    fd: number;
    constructor(fd: number) {
      this.fd = fd;
    }
    getAsyncId() {
      return 0;
    }
    close() {
      const fd = this.fd;
      this.fd = -1;
      return dispatch(kUsePromises, "close", undefined, undefined, () => {
        if (!isStdio(fd)) fs.close(fd);
      });
    }
    releaseFD() {
      const fd = this.fd;
      this.fd = -1;
      return fd;
    }
  }

  // ---- directory streams (fs.opendir) ---------------------------------------------

  const opendir = (path: string, encoding: unknown, req: unknown) =>
    dispatch(req, "opendir", path, undefined, () => {
      const entries = fs.readdirKinds(path);
      let index = 0;
      return {
        read: (_enc: unknown, bufferSize: number, readReq: unknown) =>
          dispatch(readReq, "scandir", path, undefined, () => {
            if (index >= entries.length) return null;
            const out: unknown[] = [];
            for (const [name, kind] of entries.slice(index, index + Math.max(1, bufferSize))) {
              out.push(encodeName(name, encoding), KIND_TO_DIRENT[kind]);
            }
            index += Math.max(1, bufferSize);
            return out;
          }),
        close: (closeReq: unknown) => dispatch(closeReq, "closedir", path, undefined, () => undefined),
      };
    });

  // ---- the binding ----------------------------------------------------------------

  const stat = (follow: boolean) => (path: string, bigint: boolean, req: unknown, throwIfNoEntry?: boolean) => {
    if (req === undefined && throwIfNoEntry === false) {
      try {
        return statArray(eachStat(path, follow), bigint);
      } catch (error) {
        if (hasErrno(error) && (error.code === "ENOENT" || error.code === "ENOTDIR")) return undefined;
        throw toUv(error, follow ? "stat" : "lstat", path);
      }
    }
    return dispatch(req, follow ? "stat" : "lstat", path, undefined, () => statArray(eachStat(path, follow), bigint));
  };

  return acceptingBufferPaths({
    kUsePromises,
    kFsStatsFieldsNumber: STAT_FIELDS,
    statValues: new Float64Array(STAT_FIELDS * 2),
    bigintStatValues: new BigInt64Array(STAT_FIELDS * 2),
    statFsValues: new Float64Array(7),
    bigintStatFsValues: new BigInt64Array(7),
    FSReqCallback,
    FileHandle,
    // fs.watchFile: pure polling, no fs worker / kernel plumbing at all - unlike FSEvent below,
    // a StatWatcher is entirely local to this process, repeatedly calling the same fs.stat() a
    // script could call itself. onchange fires (status, [...curr, ...prev]) whenever something
    // actually differs from the previous poll, INCLUDING the very first poll after start()
    // establishes a baseline it does not itself report - real libuv's uv_fs_poll behaves the
    // same way (the first successful stat only seeds ctx->statbuf, no callback yet).
    StatWatcher: class StatWatcher {
      readonly bigint: boolean;
      cancel: (() => void) | null = null;
      release: (() => void) | null = null;
      refed = true;
      prev: Float64Array | BigInt64Array | null = null;
      prevStatus = -1;
      onchange: ((status: number, stats: Float64Array | BigInt64Array) => void) | undefined;

      constructor(bigint?: boolean) {
        this.bigint = !!bigint;
      }

      start(path: string, interval: number): number {
        if (this.cancel) return 0;
        const ms = Math.max(1, interval);
        const tick = () => {
          let status: number;
          let curr: Float64Array | BigInt64Array;
          try {
            curr = statArray(fs.stat(path), this.bigint);
            status = 0;
          } catch {
            curr = this.bigint ? new BigInt64Array(STAT_FIELDS) : new Float64Array(STAT_FIELDS);
            status = -1;
          }
          const prev = this.prev;
          const prevStatus = this.prevStatus;
          this.prev = curr;
          this.prevStatus = status;
          this.cancel = scheduleNative(tick, ms);
          if (prev === null) return; // first poll: baseline only, matches real uv_fs_poll
          let changed = status !== prevStatus;
          for (let i = 0; !changed && i < curr.length; i++) changed = curr[i] !== prev[i];
          if (!changed) return;
          const combined = combineStats(curr, prev, this.bigint);
          loop.post(() => this.onchange?.(status, combined));
        };
        this.cancel = scheduleNative(tick, ms);
        if (this.refed) this.release = loop.ref();
        return 0;
      }
      close() {
        this.cancel?.();
        this.cancel = null;
        this.release?.();
        this.release = null;
        this.prev = null;
      }
      ref() {
        this.refed = true;
        if (this.cancel && !this.release) this.release = loop.ref();
      }
      unref() {
        this.refed = false;
        this.release?.();
        this.release = null;
      }
      getAsyncId() {
        return 0;
      }
    },

    access: (path: string, mode: number, req: unknown) =>
      dispatch(req, "access", path, undefined, () => {
        checkAccess(fs.stat(path), mode);
      }),
    existsSync: (path: string) => {
      try {
        fs.stat(path);
        return true;
      } catch {
        return false;
      }
    },
    internalModuleStat: (path: string) => {
      try {
        return fs.stat(path).kind === "dir" ? 1 : 0;
      } catch {
        return uvCode("ENOENT");
      }
    },

    open: (path: string, flags: number, mode: number, req: unknown) =>
      dispatch(req, "open", path, undefined, () => fs.open(path, flags & ~O_DIRECTORY, mode & ~UMASK)),
    openFileHandle: (path: string, flags: number, mode: number, req: unknown) =>
      dispatch(req, "open", path, undefined, () => new FileHandle(fs.open(path, flags & ~O_DIRECTORY, mode & ~UMASK))),
    close: (fd: number, req: unknown) =>
      dispatch(req, "close", undefined, undefined, () => {
        if (!isStdio(fd)) fs.close(fd);
      }),

    read: (fd: number, buffer: Uint8Array, offset: number, length: number, position: unknown, req: unknown) =>
      dispatch(req, "read", undefined, undefined, () => {
        if (fd === 0 || length === 0) return 0;
        if (isStdio(fd)) throw Object.assign(new Error("EBADF"), { code: "EBADF" });
        const chunk = fs.read(fd, length, pos(position));
        buffer.set(chunk, offset);
        return chunk.length;
      }),
    readBuffers: (fd: number, buffers: Uint8Array[], position: unknown, req: unknown) =>
      dispatch(req, "read", undefined, undefined, () => {
        let total = 0;
        let at = pos(position);
        for (const buffer of buffers) {
          const chunk = fs.read(fd, buffer.length, at);
          buffer.set(chunk);
          total += chunk.length;
          if (at >= 0) at += chunk.length;
          if (chunk.length < buffer.length) break;
        }
        return total;
      }),
    writeBuffer: (fd: number, buffer: Uint8Array, offset: number, length: number, position: unknown, req: unknown) =>
      dispatch(req, "write", undefined, undefined, () =>
        writeAll(fd, buffer.subarray(offset, offset + length), pos(position))),
    writeBuffers: (fd: number, buffers: Uint8Array[], position: unknown, req: unknown) =>
      dispatch(req, "write", undefined, undefined, () => {
        let total = 0;
        let at = pos(position);
        for (const buffer of buffers) {
          const n = writeAll(fd, buffer, at);
          total += n;
          if (at >= 0) at += n;
        }
        return total;
      }),
    writeString: (fd: number, string: string, position: unknown, encoding: string, req: unknown) =>
      dispatch(req, "write", undefined, undefined, () =>
        writeAll(fd, Buffer().from(string, encoding || "utf8"), pos(position))),

    readFileUtf8: (target: string | number, flags: number) => {
      const path = typeof target === "string" ? target : undefined;
      try {
        if (typeof target === "number") return isStdio(target) ? "" : decoder.decode(readWhole(target));
        if (flags === FS_CONSTANTS.O_RDONLY) return decoder.decode(fs.readFile(target));
        const fd = fs.open(target, flags, 0o666);
        try {
          return decoder.decode(readWhole(fd));
        } finally {
          fs.close(fd);
        }
      } catch (error) {
        throw toUv(error, "open", path);
      }
    },
    writeFileUtf8: (target: string | number, data: string, flags: number, mode: number) => {
      const bytes = new TextEncoder().encode(data);
      try {
        if (typeof target === "number") {
          writeAll(target, bytes, -1);
          return;
        }
        const fd = fs.open(target, flags, mode & ~UMASK);
        try {
          writeAll(fd, bytes, -1);
        } finally {
          fs.close(fd);
        }
      } catch (error) {
        throw toUv(error, "open", typeof target === "string" ? target : undefined);
      }
    },

    stat: stat(true),
    lstat: stat(false),
    fstat: (fd: number, bigint: boolean, req: unknown, shouldNotThrow?: boolean) => {
      try {
        return dispatch(req, "fstat", undefined, undefined, () =>
          statArray(isStdio(fd) ? stdioStat() : fs.fstat(fd), bigint));
      } catch (error) {
        // node_file.cc: "should not throw" only spares a missing entry; a bad
        // descriptor (EBADF) still throws.
        if (shouldNotThrow && (error as { code?: string }).code === "ENOENT") return undefined;
        throw error;
      }
    },
    statfs: (_path: string, bigint: boolean, req: unknown) =>
      dispatch(req, "statfs", undefined, undefined, () => {
        const values = [0xef53, 4096, 1 << 20, 1 << 19, 1 << 19, 1 << 16, 1 << 15];
        return bigint ? BigInt64Array.from(values.map(BigInt)) : Float64Array.from(values);
      }),

    readdir: (path: string, encoding: unknown, withFileTypes: boolean, req: unknown) =>
      dispatch(req, "scandir", path, undefined, () => {
        if (!withFileTypes) return fs.readdir(path).map((name) => encodeName(name, encoding));
        const entries = fs.readdirKinds(path);
        return [entries.map(([name]) => encodeName(name, encoding)), entries.map(([, kind]) => KIND_TO_DIRENT[kind])];
      }),
    mkdir: (path: string, _mode: number, recursive: boolean, req: unknown) =>
      dispatch(req, "mkdir", path, undefined, () => {
        if (!recursive) return void fs.mkdir(path);
        const first = firstMissingAncestor(path);
        fs.mkdir(path, { recursive: true });
        return first;
      }),
    mkdtemp: (prefix: string, encoding: unknown, req: unknown) =>
      dispatch(req, "mkdtemp", `${prefix}XXXXXX`, undefined, () => {
        for (let attempt = 0; ; attempt++) {
          const path = prefix + randomSuffix();
          try {
            fs.mkdir(path);
            return encodeName(path, encoding);
          } catch (error) {
            if (!(hasErrno(error) && error.code === "EEXIST") || attempt > 100) throw error;
          }
        }
      }),
    rmdir: (path: string, req: unknown) => dispatch(req, "rmdir", path, undefined, () => void fs.rmdir(path)),
    rmSync: (path: string, _maxRetries: number, recursive: boolean) => {
      try {
        fs.rm(path, { recursive });
      } catch (error) {
        // Removing what is already gone is not an error here; rmSync's callers
        // that want ENOENT check with lstat first.
        if (hasErrno(error) && error.code === "ENOENT") return;
        throw toUv(error, "rm", path);
      }
    },
    unlink: (path: string, req: unknown) => dispatch(req, "unlink", path, undefined, () => void fs.unlink(path)),
    rename: (from: string, to: string, req: unknown) =>
      dispatch(req, "rename", from, to, () => void fs.rename(from, to)),
    copyFile: (src: string, dest: string, mode: number, req: unknown) =>
      dispatch(req, "copyfile", src, dest, () => {
        if (mode & FS_CONSTANTS.COPYFILE_EXCL && fs.exists(dest)) {
          throw Object.assign(new Error("EEXIST"), { code: "EEXIST" });
        }
        const info = fs.stat(src);
        if (info.kind === "dir") throw Object.assign(new Error("EISDIR"), { code: "EISDIR" });
        fs.writeFile(dest, fs.readFile(src));
        fs.chmod(dest, info.mode & 0o7777);
      }),
    symlink: (target: string, path: string, _flags: number, req: unknown) =>
      dispatch(req, "symlink", target, path, () => void fs.symlink(target, path)),
    link: (existing: string, path: string, req: unknown) =>
      dispatch(req, "link", existing, path, () => void fs.link(existing, path)),
    readlink: (path: string, encoding: unknown, req: unknown) =>
      dispatch(req, "readlink", path, undefined, () => encodeName(fs.readlink(path), encoding)),
    realpath: (path: string, encoding: unknown, req: unknown) =>
      dispatch(req, "realpath", path, undefined, () => encodeName(fs.realpath(path), encoding)),

    ftruncate: (fd: number, length: number, req: unknown) =>
      dispatch(req, "ftruncate", undefined, undefined, () => void fs.ftruncate(fd, length)),
    fsync: (fd: number, req: unknown) => dispatch(req, "fsync", undefined, undefined, () => void fs.fstat(fd)),
    fdatasync: (fd: number, req: unknown) => dispatch(req, "fdatasync", undefined, undefined, () => void fs.fstat(fd)),

    chmod: (path: string, mode: number, req: unknown) =>
      dispatch(req, "chmod", path, undefined, () => void fs.chmod(path, mode)),
    fchmod: (fd: number, _mode: number, req: unknown) =>
      // Permission bits are kept per path here; validate the descriptor and accept.
      dispatch(req, "fchmod", undefined, undefined, () => void fs.fstat(fd)),
    // There are no owners in this filesystem: ownership calls succeed if the target exists.
    chown: (path: string, _uid: number, _gid: number, req: unknown) =>
      dispatch(req, "chown", path, undefined, () => void fs.stat(path)),
    lchown: (path: string, _uid: number, _gid: number, req: unknown) =>
      dispatch(req, "lchown", path, undefined, () => void fs.lstat(path)),
    fchown: (fd: number, _uid: number, _gid: number, req: unknown) =>
      dispatch(req, "fchown", undefined, undefined, () => void fs.fstat(fd)),
    utimes: (path: string, atime: number, mtime: number, req: unknown) =>
      dispatch(req, "utime", path, undefined, () => void fs.utimes(path, atime * 1000, mtime * 1000)),
    lutimes: (path: string, atime: number, mtime: number, req: unknown) =>
      dispatch(req, "lutime", path, undefined, () => void fs.utimes(path, atime * 1000, mtime * 1000, { noFollow: true })),
    futimes: (fd: number, atime: number, mtime: number, req: unknown) =>
      dispatch(req, "futime", undefined, undefined, () => void fs.futimes(fd, atime * 1000, mtime * 1000)),

    opendir,
    // Shim support (internal/blob): whole-file read without the fs.js indirection.
    __readForBlob: (path: string) => fs.readFile(path),
  });
};

// Which argument positions of each function are paths. Node's C++ accepts a string
// OR a Buffer there (rimraf, for one, passes Buffers); convert once at the boundary
// so every operation and error message below only ever sees strings.
const PATH_ARGS: Record<string, number[]> = {
  access: [0], existsSync: [0], internalModuleStat: [0], open: [0], openFileHandle: [0],
  readFileUtf8: [0], writeFileUtf8: [0], stat: [0], lstat: [0], statfs: [0],
  readdir: [0], mkdir: [0], mkdtemp: [0], rmdir: [0], rmSync: [0], unlink: [0],
  rename: [0, 1], copyFile: [0, 1], symlink: [0, 1], link: [0, 1], readlink: [0],
  realpath: [0], chmod: [0], chown: [0], lchown: [0], utimes: [0], lutimes: [0], opendir: [0],
};

const acceptingBufferPaths = <T extends Record<string, unknown>>(binding: T): T => {
  const decoder = new TextDecoder();
  const wrapped: Record<string, unknown> = { ...binding };
  for (const [name, positions] of Object.entries(PATH_ARGS)) {
    const original = binding[name];
    if (typeof original !== "function") continue;
    wrapped[name] = (...args: unknown[]) => {
      for (const at of positions) {
        const value = args[at];
        if (value instanceof Uint8Array) args[at] = decoder.decode(value);
      }
      return original(...args);
    };
  }
  return wrapped as T;
};

const createFsDirBinding = (fsBinding: ReturnType<typeof createFsBinding>) => ({
  opendir: fsBinding.opendir,
  opendirSync: (path: string) => fsBinding.opendir(path, undefined, undefined),
});

export interface IFsWatchHost {
  /** Registers the one handler for incoming watch events pushed from the kernel (a `fs.watch`
   *  change reported for one of this process's own watches - see workers/process/worker.ts). */
  onEvent(handler: (event: { watchId: number; eventType: "rename" | "change"; filename: string }) => void): void;
}

export interface IFsEventWrapContext {
  fs?: IFsClient;
  loop: EventLoop;
  requireBuiltin(id: string): any;
  /** Without it, fs.watch() throws ENOSYS - same optional-host-capability pattern as
   *  childProcess for pipe_wrap/process_wrap: real usage always wires one, some tests don't need to. */
  fsWatch?: IFsWatchHost;
}

/**
 * fs.watch: real push events (unlike fs.watchFile's local polling above), so this needs the fs
 * worker's own watch registry (FsServer, reached over the fs client's watchStart/watchStop) and
 * a way to receive its pushed change events (ctx.fsWatch, routed kernel -> this process worker
 * -> here - see kernel/index.ts's fsWorker.onmessage and kernel/processes.ts's notifyWatch).
 * One subscription per realm dispatches by watchId to whichever FSEvent instance owns it.
 */
const createFsEventWrapBinding = (ctx: IFsEventWrapContext) => {
  const instances = new Map<number, FSEvent>();
  let subscribed = false;

  class FSEvent {
    initialized = false;
    onchange: ((status: number, eventType: string, filename: string | Uint8Array) => void) | undefined;
    watchId: number | undefined;
    encoding = "utf8";
    release: (() => void) | null = null;

    start(path: string, persistent: boolean, recursive: boolean, encoding: string): number {
      if (!ctx.fs || !ctx.fsWatch) return uvCode("ENOSYS");
      if (!subscribed) {
        subscribed = true;
        ctx.fsWatch.onEvent(({ watchId, eventType, filename }) => instances.get(watchId)?.deliver(eventType, filename));
      }
      let watchId: number;
      try {
        watchId = ctx.fs.watchStart(path, recursive);
      } catch (error) {
        return hasErrno(error) ? uvCode(error.code) : uvCode("EIO");
      }
      this.watchId = watchId;
      this.encoding = encoding;
      this.initialized = true;
      instances.set(watchId, this);
      if (persistent) this.release = ctx.loop.ref();
      return 0;
    }

    deliver(eventType: "rename" | "change", filename: string) {
      const name = this.encoding === "buffer" ? ctx.requireBuiltin("buffer").Buffer.from(filename) : filename;
      ctx.loop.post(() => this.onchange?.(0, eventType, name));
    }

    close() {
      if (!this.initialized) return;
      this.initialized = false;
      if (this.watchId !== undefined) {
        instances.delete(this.watchId);
        ctx.fs?.watchStop(this.watchId);
      }
      this.release?.();
      this.release = null;
      // Drops onchange too, not just the registry entry: a burst of changes from one
      // writeFileSync can already have several deliveries in flight (each its own loop.post()),
      // and closing mid-burst - as a "stop after the Nth change" callback naturally would -
      // should not still call back for ones that hadn't run yet.
      this.onchange = undefined;
    }
    ref() {
      if (this.initialized && !this.release) this.release = ctx.loop.ref();
    }
    unref() {
      this.release?.();
      this.release = null;
    }
    getAsyncId() {
      return 0;
    }
  }

  return { FSEvent };
};

export { createFsBinding, createFsDirBinding, createFsEventWrapBinding, kUsePromises, S_IFDIR, S_IFLNK, S_IFREG };

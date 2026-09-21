// Synchronous fs client, used from inside a worker: turns each call into a
// blocking syscall. Imports only the (dependency-free, erasable-syntax)
// protocol module so it can also run under Node worker_threads in tests.
//
// Payloads larger than the 1 MiB syscall window are split transparently:
// reads and writes of big files go through the fd layer in FD_CHUNK pieces.

import type { ISyscallClient } from "../protocols/syscall";
import {
  DATA_BYTES,
  ERR_MSG_SIZE,
  FD_CHUNK,
  FLAG_NONE,
  FLAG_RECURSIVE,
  OP_CHMOD,
  OP_CLOSE,
  OP_EXISTS,
  OP_FD_READ,
  OP_FD_WRITE,
  OP_FSTAT,
  OP_FTRUNCATE,
  OP_LSTAT,
  OP_MKDIR,
  OP_OPEN,
  OP_READDIR,
  OP_READLINK,
  OP_READ_FILE,
  OP_REALPATH,
  OP_RENAME,
  OP_RM,
  OP_RMDIR,
  OP_STAT,
  OP_SYMLINK,
  OP_UNLINK,
  OP_WRITE_FILE,
  SyscallError,
  bytesToU32,
  decodeBytes,
  encodeRequest,
  encodeString,
  f64ToBytes,
  u32ToBytes,
} from "../protocols/syscall";

// Mirrors of the Vfs open flags. Duplicated (not imported) so this module stays
// free of Vfs and can be loaded standalone.
const O_WRONLY = 1;
const O_CREAT = 0o100;
const O_TRUNC = 0o1000;

export interface IFsStat {
  ino: number;
  kind: "file" | "dir" | "symlink";
  mode: number;
  size: number;
  nlink: number;
  mtimeMs: number;
  ctimeMs: number;
}

export interface IFsClient {
  readFile(path: string): Uint8Array;
  writeFile(path: string, data: Uint8Array | string): void;
  exists(path: string): boolean;
  readdir(path: string): string[];
  mkdir(path: string, options?: { recursive?: boolean }): void;
  stat(path: string): IFsStat;
  lstat(path: string): IFsStat;
  unlink(path: string): void;
  rmdir(path: string): void;
  rm(path: string, options?: { recursive?: boolean }): void;
  rename(from: string, to: string): void;
  symlink(target: string, path: string): void;
  readlink(path: string): string;
  realpath(path: string): string;
  chmod(path: string, mode: number): void;
  open(path: string, flags: number, mode?: number): number;
  close(fd: number): void;
  read(fd: number, length: number, position?: number): Uint8Array;
  write(fd: number, data: Uint8Array, position?: number): number;
  fstat(fd: number): IFsStat;
  ftruncate(fd: number, length: number): void;
}

const b = encodeString;
const parse = (bytes: Uint8Array) => JSON.parse(decodeBytes(bytes));

export const createFsClient = ({ call }: ISyscallClient): IFsClient => {
  const open = (path: string, flags: number, mode = 0o666): number =>
    bytesToU32(
      call(OP_OPEN, encodeRequest([b(path), u32ToBytes(flags), u32ToBytes(mode)])),
    );
  const close = (fd: number): void => {
    call(OP_CLOSE, encodeRequest([u32ToBytes(fd)]));
  };
  const fstat = (fd: number): IFsStat =>
    parse(call(OP_FSTAT, encodeRequest([u32ToBytes(fd)])));
  const read = (fd: number, length: number, position = -1): Uint8Array =>
    call(
      OP_FD_READ,
      encodeRequest([u32ToBytes(fd), u32ToBytes(length), f64ToBytes(position)]),
    );
  const write = (fd: number, data: Uint8Array, position = -1): number =>
    bytesToU32(
      call(
        OP_FD_WRITE,
        encodeRequest([u32ToBytes(fd), f64ToBytes(position), data]),
      ),
    );

  const readFileChunked = (path: string): Uint8Array => {
    const fd = open(path, 0);
    try {
      const size = fstat(fd).size;
      const out = new Uint8Array(size);
      let offset = 0;
      while (offset < size) {
        const chunk = read(fd, Math.min(FD_CHUNK, size - offset), offset);
        if (chunk.length === 0) break;
        out.set(chunk, offset);
        offset += chunk.length;
      }
      return offset === size ? out : out.slice(0, offset);
    } finally {
      close(fd);
    }
  };

  const writeFileChunked = (path: string, data: Uint8Array): void => {
    const fd = open(path, O_WRONLY | O_CREAT | O_TRUNC, 0o644);
    try {
      for (let offset = 0; offset < data.length; offset += FD_CHUNK) {
        write(fd, data.subarray(offset, offset + FD_CHUNK), offset);
      }
    } finally {
      close(fd);
    }
  };

  return {
    readFile: (path) => {
      try {
        return call(OP_READ_FILE, encodeRequest([b(path)]));
      } catch (error) {
        if (error instanceof SyscallError && error.code === ERR_MSG_SIZE) {
          return readFileChunked(path);
        }
        throw error;
      }
    },
    writeFile: (path, data) => {
      const bytes = typeof data === "string" ? b(data) : data;
      const pathBytes = b(path);
      // 8-byte header + two length-prefixed fields.
      const frameSize = 8 + 4 + pathBytes.length + 4 + bytes.length;
      if (frameSize <= DATA_BYTES) {
        call(OP_WRITE_FILE, encodeRequest([pathBytes, bytes]));
      } else {
        writeFileChunked(path, bytes);
      }
    },
    exists: (path) => call(OP_EXISTS, encodeRequest([b(path)]))[0] === 1,
    readdir: (path) => parse(call(OP_READDIR, encodeRequest([b(path)]))),
    mkdir: (path, options) => {
      call(
        OP_MKDIR,
        encodeRequest([b(path)], options?.recursive ? FLAG_RECURSIVE : FLAG_NONE),
      );
    },
    stat: (path) => parse(call(OP_STAT, encodeRequest([b(path)]))),
    lstat: (path) => parse(call(OP_LSTAT, encodeRequest([b(path)]))),
    unlink: (path) => {
      call(OP_UNLINK, encodeRequest([b(path)]));
    },
    rmdir: (path) => {
      call(OP_RMDIR, encodeRequest([b(path)]));
    },
    rm: (path, options) => {
      call(
        OP_RM,
        encodeRequest([b(path)], options?.recursive ? FLAG_RECURSIVE : FLAG_NONE),
      );
    },
    rename: (from, to) => {
      call(OP_RENAME, encodeRequest([b(from), b(to)]));
    },
    symlink: (target, path) => {
      call(OP_SYMLINK, encodeRequest([b(target), b(path)]));
    },
    readlink: (path) => decodeBytes(call(OP_READLINK, encodeRequest([b(path)]))),
    realpath: (path) => decodeBytes(call(OP_REALPATH, encodeRequest([b(path)]))),
    chmod: (path, mode) => {
      call(OP_CHMOD, encodeRequest([b(path), u32ToBytes(mode)]));
    },
    open,
    close,
    read,
    write,
    fstat,
    ftruncate: (fd, length) => {
      call(OP_FTRUNCATE, encodeRequest([u32ToBytes(fd), f64ToBytes(length)]));
    },
  };
};

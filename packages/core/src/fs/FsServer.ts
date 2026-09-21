// Services file system syscalls against one Vfs, directly over each client's
// SharedArrayBuffer. Environment-agnostic: the File System Worker feeds it
// doorbells, tests can call service() directly.
//
// Clients (the kernel, each process) register their SAB once. A doorbell then
// says "client N has a request pending"; service() decodes it, runs it against
// the Vfs, writes the answer back into that SAB and wakes the parked caller.

import {
  ISyscallViews,
  SyscallError,
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
import { Vfs } from "./Vfs";

const EMPTY = new Uint8Array(0);
const json = (value: unknown) => encodeString(JSON.stringify(value));

/** A missing request field is a malformed frame, not an empty value. */
const at = (fields: Uint8Array[], index: number): Uint8Array => {
  const field = fields[index];
  if (field === undefined) throw new SyscallError("EPROTO");
  return field;
};

type Handler = (fields: Uint8Array[], flags: number) => Uint8Array;

class FsServer {
  private readonly clients = new Map<number, ISyscallViews>();
  private readonly handlers: Map<number, Handler>;

  constructor(readonly vfs: Vfs = new Vfs()) {
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
        (f) => u32ToBytes(vfs.open(path(f), bytesToU32(at(f, 1)), bytesToU32(at(f, 2)))),
      ],
      [
        OP_CLOSE,
        (f) => {
          vfs.close(bytesToU32(at(f, 0)));
          return EMPTY;
        },
      ],
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
    ]);
  }

  registerClient(clientId: number, sab: SharedArrayBuffer): void {
    this.clients.set(clientId, makeViews(sab));
  }

  unregisterClient(clientId: number): void {
    this.clients.delete(clientId);
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
      respondOk(views, handler(fields, flags));
    } catch (error) {
      const code = (error as { code?: unknown }).code;
      respondErr(views, typeof code === "string" ? code : "EIO");
    }
  }
}

export { FsServer };

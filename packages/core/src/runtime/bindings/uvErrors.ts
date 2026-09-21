// libuv's error table (Linux errno values) and the exception shape Node's C++
// layer throws for a failed syscall: message "CODE: description, syscall 'path'",
// with errno (negative), code, syscall, path and dest as own properties, in that
// order (util.inspect shows them in insertion order).

// [name, positive linux errno, libuv message]
export const UV_ERRORS: ReadonlyArray<readonly [string, number, string]> = [
  ["E2BIG", 7, "argument list too long"],
  ["EACCES", 13, "permission denied"],
  ["EADDRINUSE", 98, "address already in use"],
  ["EADDRNOTAVAIL", 99, "address not available"],
  ["EAFNOSUPPORT", 97, "address family not supported"],
  ["EAGAIN", 11, "resource temporarily unavailable"],
  ["EALREADY", 114, "connection already in progress"],
  ["EBADF", 9, "bad file descriptor"],
  ["EBUSY", 16, "resource busy or locked"],
  ["ECANCELED", 125, "operation canceled"],
  ["ECONNABORTED", 103, "software caused connection abort"],
  ["ECONNREFUSED", 111, "connection refused"],
  ["ECONNRESET", 104, "connection reset by peer"],
  ["EDESTADDRREQ", 89, "destination address required"],
  ["EEXIST", 17, "file already exists"],
  ["EFAULT", 14, "bad address in system call argument"],
  ["EFBIG", 27, "file too large"],
  ["EHOSTUNREACH", 113, "host is unreachable"],
  ["EINTR", 4, "interrupted system call"],
  ["EINVAL", 22, "invalid argument"],
  ["EIO", 5, "i/o error"],
  ["EISCONN", 106, "socket is already connected"],
  ["EISDIR", 21, "illegal operation on a directory"],
  ["ELOOP", 40, "too many symbolic links encountered"],
  ["EMFILE", 24, "too many open files"],
  ["EMLINK", 31, "too many links"],
  ["EMSGSIZE", 90, "message too long"],
  ["ENAMETOOLONG", 36, "name too long"],
  ["ENETDOWN", 100, "network is down"],
  ["ENETUNREACH", 101, "network is unreachable"],
  ["ENFILE", 23, "file table overflow"],
  ["ENOBUFS", 105, "no buffer space available"],
  ["ENODEV", 19, "no such device"],
  ["ENOENT", 2, "no such file or directory"],
  ["ENOMEM", 12, "not enough memory"],
  ["ENOPROTOOPT", 92, "protocol not available"],
  ["ENOSPC", 28, "no space left on device"],
  ["ENOSYS", 38, "function not implemented"],
  ["ENOTCONN", 107, "socket is not connected"],
  ["ENOTDIR", 20, "not a directory"],
  ["ENOTEMPTY", 39, "directory not empty"],
  ["ENOTSOCK", 88, "socket operation on non-socket"],
  ["ENOTSUP", 95, "operation not supported on socket"],
  ["ENOTTY", 25, "inappropriate ioctl for device"],
  ["ENXIO", 6, "no such device or address"],
  ["EOVERFLOW", 75, "value too large for defined data type"],
  ["EPERM", 1, "operation not permitted"],
  ["EPIPE", 32, "broken pipe"],
  ["EPROTO", 71, "protocol error"],
  ["EPROTONOSUPPORT", 93, "protocol not supported"],
  ["EPROTOTYPE", 91, "protocol wrong type for socket"],
  ["ERANGE", 34, "result too large"],
  ["EROFS", 30, "read-only file system"],
  ["ESHUTDOWN", 108, "cannot send after transport endpoint shutdown"],
  ["ESPIPE", 29, "invalid seek"],
  ["ESRCH", 3, "no such process"],
  ["ETIMEDOUT", 110, "connection timed out"],
  ["ETXTBSY", 26, "text file is busy"],
  ["EXDEV", 18, "cross-device link not permitted"],
  ["EILSEQ", 84, "illegal byte sequence"],
  ["UNKNOWN", 4094, "unknown error"],
  ["EOF", 4095, "end of file"],
];

const BY_NAME = new Map(UV_ERRORS.map(([name, errno, message]) => [name, { errno, message }]));

/** Negative libuv code for an errno name, e.g. ENOENT -> -2. */
export const uvCode = (name: string): number => -(BY_NAME.get(name)?.errno ?? 4094);

export const uvErrorMap = () =>
  new Map<number, [string, string]>(UV_ERRORS.map(([name, errno, message]) => [-errno, [name, message]]));

/** True for an error that carries an errno name we know (VfsError, SyscallError, ...). */
export const hasErrno = (error: unknown): error is { code: string } =>
  typeof (error as { code?: unknown } | null)?.code === "string" &&
  BY_NAME.has((error as { code: string }).code);

export const uvException = (
  code: string,
  syscall: string,
  path?: string,
  dest?: string,
): Error & { errno: number; code: string; syscall: string; path?: string; dest?: string } => {
  const known = BY_NAME.get(code) ?? BY_NAME.get("UNKNOWN")!;
  let message = `${code}: ${known.message}, ${syscall}`;
  if (path !== undefined) message += ` '${path}'`;
  if (dest !== undefined) message += ` -> '${dest}'`;

  const error = new Error(message) as Error & Record<string, unknown>;
  error.errno = -known.errno;
  error.code = code;
  error.syscall = syscall;
  if (path !== undefined) error.path = path;
  if (dest !== undefined) error.dest = dest;
  return error as unknown as ReturnType<typeof uvException>;
};

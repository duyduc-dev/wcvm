// internalBinding('stream_wrap' | 'pipe_wrap' | 'process_wrap'): the native
// side child_process.js needs for `spawn()` with pipe stdio. No real libuv;
// a "child" is another process worker, supervised by the kernel, whose
// stdout/stderr/exit the kernel routes back to this worker instead of the
// host (see kernel/processes.ts's `parentPid`). See internal/stream_base_commons.js
// and internal/child_process.js for the exact contract these classes fulfil.

import {
  OP_SPAWN_SYNC,
  SPAWN_SYNC_NO_STATUS,
  bytesToU32,
  decodeBytes,
  decodeRequest,
  encodeRequest,
  encodeString,
  u32ToBytes,
  type ISyscallClient,
} from "../../protocols/syscall";
import { K_ARRAY_BUFFER_OFFSET, K_BYTES_WRITTEN, K_LAST_WRITE_WAS_ASYNC, K_READ_BYTES_OR_ERROR, streamBaseStateFor } from "./streamBaseState";
import { uvCode, uvException } from "./uvErrors";

/** Fulfilled by the process worker (see workers/process/worker.ts). */
export type ChildProcessEvent =
  | { type: "data"; childPid: number; stream: "stdout" | "stderr" | "ipc"; chunk: Uint8Array }
  | { type: "exit"; childPid: number; exitCode: number; signal?: "SIGTERM" | "SIGKILL" }
  /** The child called `process.disconnect()` (or exited without one - see ChildRouter.dispatch's exit case too). */
  | { type: "ipcDisconnect"; childPid: number };

export interface IChildProcessHost {
  /** `ipc: true` gives the spawned child a `fork()` IPC channel (see kernel/processes.ts's `ipc` flag). */
  spawn(childPid: number, command: string, args: string[], cwd: string | undefined, env: Record<string, string> | undefined, ipc?: boolean): void;
  kill(childPid: number, signal?: string): void;
  writeStdin(childPid: number, chunk: Uint8Array): void;
  endStdin(childPid: number): void;
  /** Writes to / ends a `fork()`ed child's IPC channel - a separate channel from stdin, so the kernel can route it distinctly. */
  writeIpc(childPid: number, chunk: Uint8Array): void;
  endIpc(childPid: number): void;
  /** Registers the one handler for every child's data/exit events. */
  onEvent(handler: (event: ChildProcessEvent) => void): void;
}

export interface IChildProcessContext {
  loop: { post(fn: () => void): void; ref(): () => void };
  process?: { pid?: number; cwd?: () => string };
  childProcess?: IChildProcessHost;
}

const UV_EOF = -4095;
const SIGTERM = 15;
const SIGKILL = 9;
// Internal map key for a spawned child's ipc pipe in ChildRouter.pipes - not a claim about a
// real fd; the ipc slot's actual position in a custom `stdio` array can vary (real Node's
// default puts it at index 3, but a script can reorder stdio), so it's tracked separately from
// the fd-indexed stdio pipes rather than trusting whatever index it happened to land at.
const IPC_FD = 3;
// pipe_wrap's PipeConstants.IPC (see createPipeWrapBinding's `constants` below) - the `type`
// tag on a Pipe instance used as an IPC channel; real Node checks it in a couple of places
// (e.g. `pipe.ipc`-style branches), though nothing here currently reads it back.
const PIPE_TYPE_IPC = 2;
// Comfortably unique across a session's realistic process counts, and never
// overlaps host-assigned top-level pids (a plain small incrementing counter).
const CHILD_PID_MULTIPLIER = 1_000_000;

class WriteWrap {}
class ShutdownWrap {}

type QueuedRead = { chunk: Uint8Array } | { eof: true };

const bytesFromString = (str: string, kind: "utf8" | "latin1" | "ucs2"): Uint8Array => {
  if (kind === "utf8") return new TextEncoder().encode(str);
  if (kind === "ucs2") {
    const bytes = new Uint8Array(str.length * 2);
    const view = new DataView(bytes.buffer);
    for (let i = 0; i < str.length; i++) view.setUint16(i * 2, str.charCodeAt(i), true);
    return bytes;
  }
  const bytes = new Uint8Array(str.length);
  for (let i = 0; i < str.length; i++) bytes[i] = str.charCodeAt(i) & 0xff;
  return bytes;
};

const WRITEV_ENCODING_KIND: Record<string, "utf8" | "latin1" | "ucs2"> = {
  utf8: "utf8", "utf-8": "utf8",
  latin1: "latin1", binary: "latin1", ascii: "latin1",
  ucs2: "ucs2", "ucs-2": "ucs2", utf16le: "ucs2", "utf-16le": "ucs2",
};

class Pipe {
  type: number;
  onread: ((arrayBuffer: ArrayBuffer) => void) | null = null;
  reading = false;
  bytesRead = 0;
  bytesWritten = 0;
  /** stdin (fd 0, we write to the child) vs stdout/stderr (we read); set by Process.spawn.
   *  The ipc pipe is "out" too (writes route through the host) but, unlike stdin, is also
   *  pushed to for incoming data - see `kind` below and ChildRouter.dispatch's "ipc" case. */
  direction: "in" | "out" | null = null;
  /** The child this pipe belongs to; set by Process.spawn alongside `direction`. */
  childPid: number | null = null;
  /** Which host methods an "out" pipe's writes/shutdown route through - stdin's or a fork()
   *  IPC channel's (a separate channel so the kernel can route it distinctly from stdin). */
  kind: "stdio" | "ipc" = "stdio";
  // Not `private`: an exported factory subclasses this, and TS can't emit a
  // declaration type for an exported class with private inherited members.
  queue: QueuedRead[] = [];
  closed = false;
  readonly state: Int32Array;
  readonly host: IChildProcessHost;

  constructor(type: number, state: Int32Array, host: IChildProcessHost) {
    this.type = type;
    this.state = state;
    this.host = host;
  }

  readStart(): number {
    this.reading = true;
    this.drain();
    return 0;
  }

  readStop(): number {
    this.reading = false;
    return 0;
  }

  writeBuffer(_req: WriteWrap, data: Uint8Array): number {
    return this.deliverWrite(data);
  }
  writeUtf8String(_req: WriteWrap, data: string): number {
    return this.deliverWrite(bytesFromString(data, "utf8"));
  }
  writeLatin1String(_req: WriteWrap, data: string): number {
    return this.deliverWrite(bytesFromString(data, "latin1"));
  }
  writeAsciiString(_req: WriteWrap, data: string): number {
    return this.deliverWrite(bytesFromString(data, "latin1"));
  }
  writeUcs2String(_req: WriteWrap, data: string): number {
    return this.deliverWrite(bytesFromString(data, "ucs2"));
  }

  writev(_req: WriteWrap, chunks: unknown[], allBuffers: boolean): number {
    const parts: Uint8Array[] = [];
    if (allBuffers) {
      for (const chunk of chunks) parts.push(chunk as Uint8Array);
    } else {
      for (let i = 0; i < chunks.length; i += 2) {
        const chunk = chunks[i];
        if (typeof chunk === "string") {
          const encoding = chunks[i + 1] as string | undefined;
          parts.push(bytesFromString(chunk, (encoding ? WRITEV_ENCODING_KIND[encoding] : undefined) ?? "utf8"));
        } else {
          parts.push(chunk as Uint8Array);
        }
      }
    }
    const combined = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
    let offset = 0;
    for (const part of parts) {
      combined.set(part, offset);
      offset += part.length;
    }
    return this.deliverWrite(combined);
  }

  /** Every write completes synchronously: either delivered now, or rejected now.
   *  Not `private`, for the same declaration-emit reason as the fields above. */
  deliverWrite(bytes: Uint8Array): number {
    if (this.direction !== "out" || this.childPid === null) return uvCode("ENOSYS");
    if (this.kind === "ipc") this.host.writeIpc(this.childPid, bytes);
    else this.host.writeStdin(this.childPid, bytes);
    this.bytesWritten += bytes.length;
    this.state[K_BYTES_WRITTEN] = bytes.length;
    this.state[K_LAST_WRITE_WAS_ASYNC] = 0;
    return 0;
  }

  shutdown(): number {
    if (this.direction === "out" && this.childPid !== null) {
      if (this.kind === "ipc") this.host.endIpc(this.childPid);
      else this.host.endStdin(this.childPid);
    }
    return 1; // finished synchronously; net.js calls the callback itself.
  }

  close(callback?: () => void): void {
    // A real OS pipe closing its local end signals EOF to the other end automatically; ours
    // doesn't exist, so tell the kernel explicitly. Needed for fork()'s child.disconnect(),
    // whose real vendored implementation (internal/child_process.js's `_disconnect`) calls
    // channel.close() directly, not shutdown() - guarded by `!this.closed` so this only ever
    // fires once. Stdio pipes don't need the equivalent: they're always torn down via
    // shutdown()/the child's own exit instead, never a bare close() mid-life.
    if (!this.closed && this.kind === "ipc" && this.direction === "out" && this.childPid !== null) {
      this.host.endIpc(this.childPid);
    }
    this.closed = true;
    this.queue.length = 0;
    if (callback) queueMicrotask(callback);
  }

  /** No-ops by default (matches Process's own ref/unref) - overridden per-instance where a
   *  real keep-alive is needed (the ipc pipe: see createForkIpcPipe below - setupChannel's
   *  Control class calls channel.ref()/unref() to keep a process alive only while it has a
   *  'message'/'disconnect' listener). */
  ref(): void {}
  unref(): void {}

  /** Internal: fed by the router, never called by vendored code. */
  push(chunk: Uint8Array | null): void {
    if (this.closed) return;
    this.queue.push(chunk === null ? { eof: true } : { chunk });
    this.drain();
  }

  drain(): void {
    if (!this.reading) return;
    while (this.queue.length > 0) {
      const item = this.queue.shift()!;
      if ("eof" in item) {
        this.deliver(UV_EOF, undefined, 0);
      } else {
        this.bytesRead += item.chunk.byteLength;
        this.deliver(item.chunk.byteLength, item.chunk.buffer, item.chunk.byteOffset);
      }
    }
  }

  /** `buffer` is `undefined` for EOF - real Node consumers key off `nread`'s sign
   *  (`internal/stream_base_commons.js`'s `onStreamRead`), but `setupChannel`'s own `onread`
   *  (fork() IPC) checks the buffer's truthiness directly, so EOF must not be a truthy empty
   *  ArrayBuffer here. */
  deliver(nread: number, buffer: ArrayBufferLike | undefined, offset: number): void {
    this.state[K_READ_BYTES_OR_ERROR] = nread;
    this.state[K_ARRAY_BUFFER_OFFSET] = offset;
    this.onread?.(buffer as ArrayBuffer);
  }
}

interface ISpawnOptions {
  file: string;
  args?: string[];
  cwd?: string;
  envPairs?: string[];
  /** `getValidStdio` (internal/child_process.js) sets `.ipc: true` on the slot it created for
   *  `fork()`'s IPC channel - everything else about it (type, handle) looks like a plain pipe. */
  stdio: Array<{ type: string; handle?: Pipe; ipc?: boolean }>;
}

const envFromPairs = (pairs: string[] | undefined): Record<string, string> => {
  const env: Record<string, string> = {};
  for (const pair of pairs ?? []) {
    const i = pair.indexOf("=");
    if (i > 0) env[pair.slice(0, i)] = pair.slice(i + 1);
  }
  return env;
};

class Process {
  onexit: ((exitCode: number, signalCode: string | null) => void) | null = null;
  pid = 0;
  // Not `private`, for the same declaration-emit reason as Pipe's fields above.
  readonly router: ChildRouter;

  constructor(router: ChildRouter) {
    this.router = router;
  }

  spawn(options: ISpawnOptions): number {
    const childPid = this.router.mintChildPid();
    this.pid = childPid;
    this.router.registerProcess(childPid, this);

    let ipc = false;
    options.stdio.forEach((slot, fd) => {
      if (slot?.handle instanceof Pipe) {
        if (slot.ipc) {
          ipc = true;
          slot.handle.kind = "ipc";
          slot.handle.direction = "out";
          slot.handle.childPid = childPid;
          this.router.registerPipe(childPid, IPC_FD, slot.handle);
        } else {
          slot.handle.direction = fd === 0 ? "out" : "in";
          slot.handle.childPid = childPid;
          this.router.registerPipe(childPid, fd, slot.handle);
        }
      }
    });

    // No `cwd` option means the parent's own current directory - real libuv passes a NULL cwd,
    // and the child simply inherits the OS process's. Here nothing is inherited implicitly, so it
    // has to be said (a child used to start at "/" instead, so `spawn("node", ["x.js"])` failed).
    const cwd = options.cwd ?? this.router.parentCwd();
    this.router.host.spawn(childPid, options.file, (options.args ?? []).slice(1), cwd, envFromPairs(options.envPairs), ipc);
    return 0;
  }

  kill(signal: number): number {
    const name = signal === SIGKILL ? "SIGKILL" : signal === SIGTERM ? "SIGTERM" : undefined;
    if (!name) return uvCode("ENOSYS");
    this.router.host.kill(this.pid, name);
    return 0;
  }

  close(): void {}
  /** A live child keeps its parent alive (uv_process_t is ref'd) - until `child.unref()`, which
   *  esbuild's JS API does to its own long-lived service process so an idle one never holds a
   *  script open. */
  ref(): void {
    this.router.setProcessRef(this.pid, true);
  }
  unref(): void {
    this.router.setProcessRef(this.pid, false);
  }
}

/** Shared per running script: pid minting, and the one subscription to child events. */
class ChildRouter {
  readonly host: IChildProcessHost;
  readonly state: Int32Array;
  private readonly ownPid: number;
  readonly parentCwd: () => string | undefined;
  private readonly loop: IChildProcessContext["loop"];
  private counter = 0;
  private readonly processes = new Map<number, { proc: Process; release: (() => void) | null }>();
  private readonly pipes = new Map<string, Pipe>();

  constructor(ctx: IChildProcessContext) {
    if (!ctx.childProcess) throw uvException("ENOSYS", "spawn");
    this.host = ctx.childProcess;
    this.ownPid = ctx.process?.pid ?? 0;
    this.parentCwd = () => ctx.process?.cwd?.();
    this.loop = ctx.loop;
    // Shared with tcp_wrap (runtime/bindings/net.ts): stream_wrap's streamBaseState is ONE array
    // per realm regardless of handle type - a separate one here would silently disconnect this
    // router's reads/writes from what net.js/child_process.js actually observe.
    this.state = streamBaseStateFor(ctx);

    this.host.onEvent((event) => this.loop.post(() => this.dispatch(event)));
  }

  mintChildPid(): number {
    return this.ownPid * CHILD_PID_MULTIPLIER + ++this.counter;
  }

  registerProcess(pid: number, proc: Process): void {
    this.processes.set(pid, { proc, release: this.loop.ref() });
  }

  /** Process.ref()/unref(): whether this still-running child keeps the loop alive. */
  setProcessRef(pid: number, refed: boolean): void {
    const entry = this.processes.get(pid);
    if (!entry) return; // not spawned yet, or already exited
    if (refed) entry.release ??= this.loop.ref();
    else {
      entry.release?.();
      entry.release = null;
    }
  }

  registerPipe(pid: number, fd: number, pipe: Pipe): void {
    this.pipes.set(`${pid}:${fd}`, pipe);
  }

  private dispatch(event: ChildProcessEvent): void {
    if (event.type === "data") {
      const fd = event.stream === "stdout" ? 1 : event.stream === "stderr" ? 2 : IPC_FD;
      this.pipes.get(`${event.childPid}:${fd}`)?.push(event.chunk);
      return;
    }
    if (event.type === "ipcDisconnect") {
      this.pipes.get(`${event.childPid}:${IPC_FD}`)?.push(null);
      return;
    }
    this.pipes.get(`${event.childPid}:1`)?.push(null);
    this.pipes.get(`${event.childPid}:2`)?.push(null);
    this.pipes.get(`${event.childPid}:${IPC_FD}`)?.push(null);
    for (const fd of [0, 1, 2, IPC_FD]) this.pipes.delete(`${event.childPid}:${fd}`);

    const entry = this.processes.get(event.childPid);
    this.processes.delete(event.childPid);
    entry?.release?.();
    if (event.signal) entry?.proc.onexit?.(0, event.signal);
    else entry?.proc.onexit?.(event.exitCode, null);
  }
}

const routers = new WeakMap<IChildProcessContext, ChildRouter>();
const routerFor = (ctx: IChildProcessContext): ChildRouter => {
  let router = routers.get(ctx);
  if (!router) {
    router = new ChildRouter(ctx);
    routers.set(ctx, router);
  }
  return router;
};

export const createStreamWrapBinding = (ctx: IChildProcessContext) => {
  const router = routerFor(ctx);
  return {
    streamBaseState: router.state,
    kReadBytesOrError: K_READ_BYTES_OR_ERROR,
    kArrayBufferOffset: K_ARRAY_BUFFER_OFFSET,
    kBytesWritten: K_BYTES_WRITTEN,
    kLastWriteWasAsync: K_LAST_WRITE_WAS_ASYNC,
    WriteWrap,
    ShutdownWrap,
  };
};

export const createPipeWrapBinding = (ctx: IChildProcessContext) => {
  const router = routerFor(ctx);
  return {
    Pipe: class extends Pipe {
      constructor(type: number) {
        super(type, router.state, router.host);
      }
    },
    PipeConnectWrap: class PipeConnectWrap {},
    constants: { SOCKET: 0, SERVER: 1, IPC: PIPE_TYPE_IPC },
  };
};

export const createProcessWrapBinding = (ctx: IChildProcessContext) => {
  const router = routerFor(ctx);
  return {
    Process: class extends Process {
      constructor() {
        super(router);
      }
    },
  };
};

export interface IForkIpcHost {
  /** Sends one already-framed outgoing ipc message (built by setupChannel) to this process's own parent. */
  send(chunk: Uint8Array): void;
  /** This end of the channel is done (`process.disconnect()`). */
  end(): void;
  /** Registers the one handler for incoming ipc chunks from the parent; `null` = the parent disconnected or exited. */
  onData(handler: (chunk: Uint8Array | null) => void): void;
}

/**
 * A forked child's own channel to its parent (the other end of the ipc `Pipe` `Process.spawn()`
 * sets up above, but from this process's own side, where there's no "childPid" - there's only
 * one such channel, to whichever process the kernel knows spawned this one). Shares this realm's
 * `stream_wrap` state via the SAME `ctx` reference already passed to `createInternalBinding`:
 * `setupChannel`'s `channel.onread` reads `streamBaseState[kReadBytesOrError]`, the identical
 * Int32Array `internalBinding('stream_wrap')` already handed to vendored JS - a different `ctx`
 * object here would build a second, disconnected router/state and reads would never surface.
 */
export const createForkIpcPipe = (ctx: IChildProcessContext, ipc: IForkIpcHost): Pipe => {
  const router = routerFor(ctx);
  const adapter: IChildProcessHost = {
    spawn: () => {},
    kill: () => {},
    writeStdin: () => {},
    endStdin: () => {},
    writeIpc: (_childPid, chunk) => ipc.send(chunk),
    endIpc: () => ipc.end(),
    onEvent: () => {},
  };
  const pipe = new Pipe(PIPE_TYPE_IPC, router.state, adapter);
  pipe.kind = "ipc";
  pipe.direction = "out";
  pipe.childPid = 0; // unused by `adapter` (only one channel per process), but deliverWrite/shutdown require non-null
  // setupChannel's Control class calls channel.ref()/unref() to keep this process alive only
  // while it has a 'message'/'disconnect' listener (real vendored ref-counting logic) - tie
  // that to the actual event loop, the same way runtime.ts already does for process.stdin.
  let release: (() => void) | null = null;
  pipe.ref = () => {
    release ??= ctx.loop.ref();
  };
  pipe.unref = () => {
    release?.();
    release = null;
  };
  ipc.onData((chunk) => pipe.push(chunk));
  return pipe;
};

// internalBinding('spawn_sync'): genuinely synchronous, unlike spawn()'s pipe_wrap/process_wrap
// above - it blocks this whole worker (Atomics.wait on a second, per-process SAB serviced by
// the kernel itself, kernel/spawnSyncServer.ts) until the child has fully exited, with its
// complete stdout/stderr already known. See internal/child_process.js's spawnSync(): it expects
// exactly `{ pid, output: [stdin, stdout, stderr], status, signal }` back.
interface ISpawnSyncOptions {
  file: string;
  args?: string[];
  cwd?: string | URL;
  envPairs?: string[];
  timeout?: number;
  /** Only stdio[0]'s `.input` (spawnSync's `input` option) is honoured; stdout/stderr are
   *  always captured regardless of a custom `stdio` array - a documented simplification. */
  stdio: Array<{ type: string; input?: Uint8Array }>;
}

export const createSpawnSyncBinding = (ctx: { spawnSync?: ISyscallClient; requireBuiltin: (id: string) => any; process?: { cwd?: () => string } }) => ({
  spawn: (options: ISpawnSyncOptions) => {
    if (!ctx.spawnSync) throw uvException("ENOSYS", "spawnSync");

    const request = encodeRequest([
      encodeString(options.file),
      encodeString(JSON.stringify((options.args ?? []).slice(1))),
      // No `cwd`: the parent's own, as for async spawn() above.
      encodeString(typeof options.cwd === "string" ? options.cwd : (ctx.process?.cwd?.() ?? "")),
      encodeString(JSON.stringify(envFromPairs(options.envPairs))),
      options.stdio[0]?.input ?? new Uint8Array(0),
      u32ToBytes(options.timeout ?? 0),
    ]);

    const payload = ctx.spawnSync.call(OP_SPAWN_SYNC, request);
    const { fields } = decodeRequest(payload);
    const [pidBytes, statusBytes, signalBytes, stdoutBytes, stderrBytes] = fields;
    const status = bytesToU32(statusBytes);
    const signal = decodeBytes(signalBytes);
    const { Buffer } = ctx.requireBuiltin("buffer");

    return {
      pid: bytesToU32(pidBytes),
      output: [null, Buffer.from(stdoutBytes), Buffer.from(stderrBytes)],
      status: status === SPAWN_SYNC_NO_STATUS ? null : status,
      signal: signal || null,
    };
  },
});

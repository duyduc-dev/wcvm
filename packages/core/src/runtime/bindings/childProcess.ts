// internalBinding('stream_wrap' | 'pipe_wrap' | 'process_wrap'): the native
// side child_process.js needs for `spawn()` with pipe stdio. No real libuv;
// a "child" is another process worker, supervised by the kernel, whose
// stdout/stderr/exit the kernel routes back to this worker instead of the
// host (see kernel/processes.ts's `parentPid`). See internal/stream_base_commons.js
// and internal/child_process.js for the exact contract these classes fulfil.

import { uvCode, uvException } from "./uvErrors";

/** Fulfilled by the process worker (see workers/process/worker.ts). */
export type ChildProcessEvent =
  | { type: "data"; childPid: number; stream: "stdout" | "stderr"; chunk: Uint8Array }
  | { type: "exit"; childPid: number; exitCode: number; signal?: "SIGTERM" | "SIGKILL" };

export interface IChildProcessHost {
  spawn(childPid: number, command: string, args: string[], cwd: string | undefined, env: Record<string, string> | undefined): void;
  kill(childPid: number, signal?: string): void;
  /** Registers the one handler for every child's data/exit events. */
  onEvent(handler: (event: ChildProcessEvent) => void): void;
}

export interface IChildProcessContext {
  loop: { post(fn: () => void): void; ref(): () => void };
  process?: { pid?: number };
  childProcess?: IChildProcessHost;
}

// streamBaseState indices are ours (nothing outside this file/net.js's shared
// glue reads them by hardcoded number); values must round-trip negative uv
// codes, so this is Int32, not Uint32.
const K_READ_BYTES_OR_ERROR = 0;
const K_ARRAY_BUFFER_OFFSET = 1;
const K_BYTES_WRITTEN = 2;
const K_LAST_WRITE_WAS_ASYNC = 3;

const UV_EOF = -4095;
const SIGTERM = 15;
const SIGKILL = 9;
// Comfortably unique across a session's realistic process counts, and never
// overlaps host-assigned top-level pids (a plain small incrementing counter).
const CHILD_PID_MULTIPLIER = 1_000_000;

class WriteWrap {}
class ShutdownWrap {}

type QueuedRead = { chunk: Uint8Array } | { eof: true };

class Pipe {
  type: number;
  onread: ((arrayBuffer: ArrayBuffer) => void) | null = null;
  reading = false;
  bytesRead = 0;
  bytesWritten = 0;
  /** stdin (fd 0, we'd write to the child) vs stdout/stderr (we read); set by Process.spawn. */
  direction: "in" | "out" | null = null;
  // Not `private`: an exported factory subclasses this, and TS can't emit a
  // declaration type for an exported class with private inherited members.
  queue: QueuedRead[] = [];
  closed = false;
  readonly state: Int32Array;

  constructor(type: number, state: Int32Array) {
    this.type = type;
    this.state = state;
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

  // Writing to a child's stdin has no delivery path yet (needs the general
  // stdin mechanism PLAN.md already lists as not-done); fail loudly rather
  // than silently dropping bytes.
  writeBuffer = (): number => uvCode("ENOSYS");
  writeUtf8String = this.writeBuffer;
  writeLatin1String = this.writeBuffer;
  writeAsciiString = this.writeBuffer;
  writeUcs2String = this.writeBuffer;
  writev = (): number => uvCode("ENOSYS");

  shutdown(): number {
    return 1; // finished synchronously; net.js calls the callback itself.
  }

  close(callback?: () => void): void {
    this.closed = true;
    this.queue.length = 0;
    if (callback) queueMicrotask(callback);
  }

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
        this.deliver(UV_EOF, new ArrayBuffer(0), 0);
      } else {
        this.bytesRead += item.chunk.byteLength;
        this.deliver(item.chunk.byteLength, item.chunk.buffer, item.chunk.byteOffset);
      }
    }
  }

  deliver(nread: number, buffer: ArrayBufferLike, offset: number): void {
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
  stdio: Array<{ type: string; handle?: Pipe }>;
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

    options.stdio.forEach((slot, fd) => {
      if (slot?.handle instanceof Pipe) {
        slot.handle.direction = fd === 0 ? "out" : "in";
        this.router.registerPipe(childPid, fd, slot.handle);
      }
    });

    this.router.host.spawn(childPid, options.file, (options.args ?? []).slice(1), options.cwd, envFromPairs(options.envPairs));
    return 0;
  }

  kill(signal: number): number {
    const name = signal === SIGKILL ? "SIGKILL" : signal === SIGTERM ? "SIGTERM" : undefined;
    if (!name) return uvCode("ENOSYS");
    this.router.host.kill(this.pid, name);
    return 0;
  }

  close(): void {}
  ref(): void {}
  unref(): void {}
}

/** Shared per running script: pid minting, and the one subscription to child events. */
class ChildRouter {
  readonly host: IChildProcessHost;
  readonly state: Int32Array;
  private readonly ownPid: number;
  private readonly loop: IChildProcessContext["loop"];
  private counter = 0;
  private readonly processes = new Map<number, { proc: Process; release: () => void }>();
  private readonly pipes = new Map<string, Pipe>();

  constructor(ctx: IChildProcessContext) {
    if (!ctx.childProcess) throw uvException("ENOSYS", "spawn");
    this.host = ctx.childProcess;
    this.ownPid = ctx.process?.pid ?? 0;
    this.loop = ctx.loop;
    this.state = new Int32Array(4);

    this.host.onEvent((event) => this.loop.post(() => this.dispatch(event)));
  }

  mintChildPid(): number {
    return this.ownPid * CHILD_PID_MULTIPLIER + ++this.counter;
  }

  registerProcess(pid: number, proc: Process): void {
    this.processes.set(pid, { proc, release: this.loop.ref() });
  }

  registerPipe(pid: number, fd: number, pipe: Pipe): void {
    this.pipes.set(`${pid}:${fd}`, pipe);
  }

  private dispatch(event: ChildProcessEvent): void {
    if (event.type === "data") {
      this.pipes.get(`${event.childPid}:${event.stream === "stdout" ? 1 : 2}`)?.push(event.chunk);
      return;
    }
    this.pipes.get(`${event.childPid}:1`)?.push(null);
    this.pipes.get(`${event.childPid}:2`)?.push(null);
    for (const fd of [0, 1, 2]) this.pipes.delete(`${event.childPid}:${fd}`);

    const entry = this.processes.get(event.childPid);
    this.processes.delete(event.childPid);
    entry?.release();
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
        super(type, router.state);
      }
    },
    PipeConnectWrap: class PipeConnectWrap {},
    constants: { SOCKET: 0, SERVER: 1, IPC: 2 },
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

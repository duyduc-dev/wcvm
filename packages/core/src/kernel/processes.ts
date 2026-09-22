import type { KernelMessage } from "../bridges/models";
import type { ChildEvent, IProcessInit, ProcessEvent } from "../workers/process/messages";

/** The subset of `Worker` the kernel needs, so tests can substitute one. */
export interface IProcessWorkerLike {
  postMessage(message: IProcessInit | ChildEvent, transfer?: Transferable[]): void;
  terminate(): void;
  onmessage: ((event: MessageEvent<ProcessEvent>) => void) | null;
  onerror: ((event: ErrorEvent) => void) | null;
}

export interface IProcessTableParams {
  createProcessWorker: (pid: number) => IProcessWorkerLike;
  /** Registers a new syscall client with the fs worker. */
  attachFsClient: (clientId: number) => { sab: SharedArrayBuffer; port: MessagePort };
  detachFsClient: (clientId: number) => void;
  /** Registers a new syscall client for execSync/spawnSync, serviced by the kernel itself. */
  attachSyncClient: (clientId: number) => { sab: SharedArrayBuffer; port: MessagePort };
  detachSyncClient: (clientId: number) => void;
  /** Sends an event to the host (`process:stdout`, `process:exit`, ...). */
  emit: (message: KernelMessage) => void;
}

export interface ISpawnSpec {
  processId: number;
  command: string;
  args: string[];
  cwd?: string;
  env?: Record<string, string>;
  /** Set for a child_process spawned from inside another process; see spawn()'s routing. */
  parentPid?: number;
  /**
   * Set for a synchronous child (execSync/spawnSync - see kernel/spawnSyncServer.ts): its
   * stdout/stderr are buffered instead of forwarded live, and delivered here, all at once,
   * once it exits - the caller is blocked on a SAB, not running a message loop that could
   * receive `child:*` events like a real parent worker.
   */
  onExit?: (result: { code: number; signal?: Signal; stdout: Uint8Array; stderr: Uint8Array }) => void;
  /** Killed with SIGTERM if still running after this many ms (execSync/spawnSync's `timeout`). */
  timeoutMs?: number;
}

export type Signal = "SIGTERM" | "SIGKILL";

export interface IProcessTable {
  spawn(spec: ISpawnSpec): void;
  kill(pid: number, signal?: string): void;
  /** Silently does nothing for an unknown or already-exited pid, like kill(). */
  writeStdin(pid: number, chunk: Uint8Array): void;
  endStdin(pid: number): void;
  has(pid: number): boolean;
  readonly size: number;
}

const SIGNAL_EXIT: Record<Signal, number> = { SIGTERM: 143, SIGKILL: 137 };

const baseEnv = (cwd: string): Record<string, string> => ({
  PATH: "/bin",
  HOME: "/home/user",
  PWD: cwd,
});

interface ISyncEntry {
  onExit: NonNullable<ISpawnSpec["onExit"]>;
  stdout: Uint8Array[];
  stderr: Uint8Array[];
  timer?: ReturnType<typeof setTimeout>;
}

const concatBytes = (parts: Uint8Array[]): Uint8Array => {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
};

const createProcessTable = ({
  createProcessWorker,
  attachFsClient,
  detachFsClient,
  attachSyncClient,
  detachSyncClient,
  emit,
}: IProcessTableParams): IProcessTable => {
  const workers = new Map<number, { worker: IProcessWorkerLike; parentPid?: number; sync?: ISyncEntry }>();

  /** A child_process's parent, if it's both a child and still alive; undefined routes to the host. */
  const parentOf = (pid: number): IProcessWorkerLike | undefined => {
    const parentPid = workers.get(pid)?.parentPid;
    return parentPid === undefined ? undefined : workers.get(parentPid)?.worker;
  };

  const childrenOf = (pid: number): number[] => {
    const children: number[] = [];
    for (const [childPid, entry] of workers) if (entry.parentPid === pid) children.push(childPid);
    return children;
  };

  /**
   * Idempotent: the first exit wins; later events from a dead worker are dropped.
   * Tears down `pid`'s whole subtree: an orphaned `child_process` has no live
   * parent left to report to or be managed by, so leaking it would strand a
   * Process Worker (and any of *its* children) in the tab forever. `detached`
   * is accepted by the vendored `child_process` options but not honoured, so
   * this has no opt-out yet. `cascade` marks a subtree member being cleaned up
   * because its ancestor is gone, not because it exited itself: no one is left
   * to notify, so its own exit event is suppressed (real process trees don't
   * notify a grandparent when a grandchild dies either).
   */
  const finalize = (
    pid: number,
    code: number,
    extra: { signal?: Signal; errorMessage?: string } = {},
    cascade = false,
  ) => {
    const entry = workers.get(pid);
    if (!entry) return;
    const parent = cascade ? undefined : parentOf(pid);
    const children = childrenOf(pid);
    workers.delete(pid);
    if (entry.sync?.timer !== undefined) clearTimeout(entry.sync.timer);
    // Stop the worker before detaching, so it cannot issue a request that the
    // fs worker would then service for a client that no longer exists.
    entry.worker.onmessage = null;
    entry.worker.onerror = null;
    entry.worker.terminate();
    detachFsClient(pid);
    detachSyncClient(pid);
    if (entry.sync) {
      entry.sync.onExit({ code, signal: extra.signal, stdout: concatBytes(entry.sync.stdout), stderr: concatBytes(entry.sync.stderr) });
    } else if (!cascade) {
      if (parent) parent.postMessage({ type: "child:exit", childPid: pid, exitCode: code, ...extra });
      else emit({ type: "process:exit", processId: pid, exitCode: code, ...extra });
    }
    for (const childPid of children) finalize(childPid, SIGNAL_EXIT.SIGKILL, { signal: "SIGKILL" }, true);
  };

  const forwardOutput = (pid: number, stream: "stdout" | "stderr", chunk: Uint8Array) => {
    const entry = workers.get(pid);
    if (entry?.sync) {
      entry.sync[stream].push(chunk);
      return;
    }
    const parent = parentOf(pid);
    if (parent) parent.postMessage({ type: `child:${stream}`, childPid: pid, chunk });
    else emit({ type: `process:${stream}`, processId: pid, chunk });
  };

  const writeStdin = (pid: number, chunk: Uint8Array) => {
    workers.get(pid)?.worker.postMessage({ type: "stdin", chunk });
  };

  const endStdin = (pid: number) => {
    workers.get(pid)?.worker.postMessage({ type: "stdinEnd" });
  };

  const spawn = (spec: ISpawnSpec) => {
    const { processId: pid, parentPid, onExit } = spec;
    // A sync spawn's caller is blocked on a SAB, not running a message loop - reporting a
    // failure via emit()/a parent postMessage would leave it parked forever.
    const reportFailure = (errorMessage: string) => {
      if (onExit) onExit({ code: 1, stdout: new Uint8Array(0), stderr: new Uint8Array(0) });
      else emit({ type: "process:exit", processId: pid, exitCode: 1, errorMessage });
    };

    if (workers.has(pid)) {
      reportFailure(`Process ${pid} already exists`);
      return;
    }

    const cwd = spec.cwd || "/";
    let worker: IProcessWorkerLike;
    let client: { sab: SharedArrayBuffer; port: MessagePort };
    let syncClient: { sab: SharedArrayBuffer; port: MessagePort };
    try {
      worker = createProcessWorker(pid);
      client = attachFsClient(pid);
      syncClient = attachSyncClient(pid);
    } catch (cause) {
      reportFailure(`Failed to start process: ${(cause as Error).message}`);
      return;
    }
    const sync: ISyncEntry | undefined = onExit ? { onExit, stdout: [], stderr: [] } : undefined;
    if (sync && spec.timeoutMs) sync.timer = setTimeout(() => kill(pid, "SIGTERM"), spec.timeoutMs);
    workers.set(pid, { worker, parentPid, sync });

    worker.onmessage = (event) => {
      const data = event.data;
      switch (data.type) {
        case "exit":
          finalize(pid, data.code);
          break;
        case "stdout":
        case "stderr":
          forwardOutput(pid, data.type, data.chunk);
          break;
        case "child:spawn":
          spawn({ processId: data.childPid, command: data.command, args: data.args, cwd: data.cwd, env: data.env, parentPid: pid });
          break;
        case "child:kill":
          kill(data.childPid, data.signal);
          break;
        case "child:stdin":
          writeStdin(data.childPid, data.chunk);
          break;
        case "child:stdinEnd":
          endStdin(data.childPid);
          break;
      }
    };
    worker.onerror = (event) => {
      finalize(pid, 1, {
        errorMessage: `Process worker error: ${event.message || "unknown error"}`,
      });
    };

    worker.postMessage(
      {
        type: "init",
        pid,
        command: spec.command,
        args: spec.args,
        cwd,
        env: { ...baseEnv(cwd), ...spec.env },
        sab: client.sab,
        fsPort: client.port,
        syncSab: syncClient.sab,
        syncPort: syncClient.port,
      },
      [client.port, syncClient.port],
    );
  };

  const kill = (pid: number, signal: string = "SIGTERM") => {
    const name: Signal = signal === "SIGKILL" ? "SIGKILL" : "SIGTERM";
    finalize(pid, SIGNAL_EXIT[name], { signal: name });
  };

  return {
    spawn,
    kill,
    writeStdin,
    endStdin,
    has: (pid) => workers.has(pid),
    get size() {
      return workers.size;
    },
  };
};

export { createProcessTable };

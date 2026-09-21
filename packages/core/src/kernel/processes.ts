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

const createProcessTable = ({
  createProcessWorker,
  attachFsClient,
  detachFsClient,
  emit,
}: IProcessTableParams): IProcessTable => {
  const workers = new Map<number, { worker: IProcessWorkerLike; parentPid?: number }>();

  /** A child_process's parent, if it's both a child and still alive; undefined routes to the host. */
  const parentOf = (pid: number): IProcessWorkerLike | undefined => {
    const parentPid = workers.get(pid)?.parentPid;
    return parentPid === undefined ? undefined : workers.get(parentPid)?.worker;
  };

  /** Idempotent: the first exit wins; later events from a dead worker are dropped. */
  const finalize = (
    pid: number,
    code: number,
    extra: { signal?: Signal; errorMessage?: string } = {},
  ) => {
    const entry = workers.get(pid);
    if (!entry) return;
    const parent = parentOf(pid);
    workers.delete(pid);
    // Stop the worker before detaching, so it cannot issue a request that the
    // fs worker would then service for a client that no longer exists.
    entry.worker.onmessage = null;
    entry.worker.onerror = null;
    entry.worker.terminate();
    detachFsClient(pid);
    if (parent) parent.postMessage({ type: "child:exit", childPid: pid, exitCode: code, ...extra });
    else emit({ type: "process:exit", processId: pid, exitCode: code, ...extra });
  };

  const forwardOutput = (pid: number, stream: "stdout" | "stderr", chunk: Uint8Array) => {
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
    const { processId: pid, parentPid } = spec;
    if (workers.has(pid)) {
      emit({
        type: "process:exit",
        processId: pid,
        exitCode: 1,
        errorMessage: `Process ${pid} already exists`,
      });
      return;
    }

    const cwd = spec.cwd || "/";
    let worker: IProcessWorkerLike;
    let client: { sab: SharedArrayBuffer; port: MessagePort };
    try {
      worker = createProcessWorker(pid);
      client = attachFsClient(pid);
    } catch (cause) {
      emit({
        type: "process:exit",
        processId: pid,
        exitCode: 1,
        errorMessage: `Failed to start process: ${(cause as Error).message}`,
      });
      return;
    }
    workers.set(pid, { worker, parentPid });

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
      },
      [client.port],
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

import type { KernelMessage } from "../bridges/models";
import type { IProcessInit, ProcessEvent } from "../workers/process/messages";

/** The subset of `Worker` the kernel needs, so tests can substitute one. */
export interface IProcessWorkerLike {
  postMessage(message: IProcessInit, transfer: Transferable[]): void;
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
}

export type Signal = "SIGTERM" | "SIGKILL";

export interface IProcessTable {
  spawn(spec: ISpawnSpec): void;
  kill(pid: number, signal?: string): void;
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
  const workers = new Map<number, IProcessWorkerLike>();

  /** Idempotent: the first exit wins; later events from a dead worker are dropped. */
  const finalize = (
    pid: number,
    code: number,
    extra: { signal?: Signal; errorMessage?: string } = {},
  ) => {
    const worker = workers.get(pid);
    if (!worker) return;
    workers.delete(pid);
    // Stop the worker before detaching, so it cannot issue a request that the
    // fs worker would then service for a client that no longer exists.
    worker.onmessage = null;
    worker.onerror = null;
    worker.terminate();
    detachFsClient(pid);
    emit({ type: "process:exit", processId: pid, exitCode: code, ...extra });
  };

  const spawn = (spec: ISpawnSpec) => {
    const { processId: pid } = spec;
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
    workers.set(pid, worker);

    worker.onmessage = (event) => {
      const data = event.data;
      if (data.type === "exit") finalize(pid, data.code);
      else emit({ type: `process:${data.type}`, processId: pid, chunk: data.chunk });
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
    has: (pid) => workers.has(pid),
    get size() {
      return workers.size;
    },
  };
};

export { createProcessTable };

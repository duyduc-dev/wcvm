import type { KernelMessage } from "../bridges/models";
import type { ChildEvent, IProcessInit, IWorkerThreadInit, ProcessEvent } from "../workers/process/messages";
import type { NetKernelEvent, UdpKernelEvent } from "./netServer";

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
  /** Registers a new syscall client for net.Server.listen(), serviced by the kernel itself. */
  attachNetClient: (clientId: number) => { sab: SharedArrayBuffer; port: MessagePort };
  detachNetClient: (clientId: number) => void;
  /** The async half of the virtual network (kernel/netServer.ts): connect/data/close relay. */
  netRelay: {
    unlisten(pid: number, port: number): void;
    connect(fromPid: number, ticket: number, port: number): void;
    data(fromPid: number, connId: number, chunk: Uint8Array): void;
    shutdown(fromPid: number, connId: number): void;
    close(fromPid: number, connId: number): void;
    releasePid(pid: number): void;
  };
  /** The async half of UDP (kernel/netServer.ts): unbind/send relay. */
  udpRelay: {
    unbind(pid: number, port: number): void;
    send(fromPid: number, fromPort: number, toPort: number, chunk: Uint8Array): void;
    releasePid(pid: number): void;
  };
  /** Mints the real, kernel-coordinated pid for a new worker_threads.Worker's own Process Worker
   *  (threadId is minted synchronously by the CALLER instead - see IProcessInit.threadIdCounterSab's
   *  own comment for why pid and threadId can't both work the same way). */
  mintWorkerThreadPid: () => number;
  /** The shared, globally-coordinated threadId counter every spawned process gets a reference to
   *  (see its own comment in kernel/index.ts) - just forwarded into every IProcessInit here. */
  threadIdCounterSab: SharedArrayBuffer;
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
  /** Set for a `fork()`ed child: it gets a second, bidirectional ipc channel (see spawn()'s
   *  `IProcessInit.ipc` and workers/process/worker.ts's own `ipc` host object). */
  ipc?: boolean;
  /** Set when this spawn IS a worker_threads.Worker, not a top-level/child_process spawn - see
   *  workers/process/messages.ts's IWorkerThreadInit. `command`/`args` above are ignored for one
   *  of these (the process worker runs runWorkerThread() instead of resolving a builtin command). */
  workerThread?: IWorkerThreadInit;
}

export type Signal = "SIGTERM" | "SIGKILL";

export interface IProcessTable {
  spawn(spec: ISpawnSpec): void;
  kill(pid: number, signal?: string): void;
  /** Silently does nothing for an unknown or already-exited pid, like kill(). */
  writeStdin(pid: number, chunk: Uint8Array): void;
  endStdin(pid: number): void;
  /** Write to / end a fork()ed process's incoming ipc channel; same no-op-if-unknown semantics. */
  writeIpc(pid: number, chunk: Uint8Array): void;
  endIpc(pid: number): void;
  /** Delivers an fs.watch/watchFile change the fs worker reported for one of `pid`'s own
   *  watches; a no-op if `pid` isn't running any more (see kernel/index.ts's fsWorker.onmessage). */
  notifyWatch(pid: number, watchId: number, eventType: "rename" | "change", filename: string): void;
  /** Delivers a net event (connect result, incoming connection, data, close) to `pid`'s own
   *  process worker; a no-op if `pid` isn't running any more - kernel/netServer.ts's `notify`. */
  notifyNet(pid: number, event: NetKernelEvent): void;
  /** Delivers an incoming UDP datagram to `pid`'s own process worker; same no-op-if-unknown
   *  semantics - kernel/netServer.ts's `notifyUdp`. */
  notifyUdp(pid: number, event: UdpKernelEvent): void;
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
  attachNetClient,
  detachNetClient,
  netRelay,
  udpRelay,
  mintWorkerThreadPid,
  threadIdCounterSab,
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
    detachNetClient(pid);
    netRelay.releasePid(pid);
    udpRelay.releasePid(pid);
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

  const writeIpc = (pid: number, chunk: Uint8Array) => {
    workers.get(pid)?.worker.postMessage({ type: "ipc", chunk });
  };

  const endIpc = (pid: number) => {
    workers.get(pid)?.worker.postMessage({ type: "ipcEnd" });
  };

  const notifyWatch = (pid: number, watchId: number, eventType: "rename" | "change", filename: string) => {
    workers.get(pid)?.worker.postMessage({ type: "watchEvent", watchId, eventType, filename });
  };

  const notifyNet = (pid: number, event: NetKernelEvent) => {
    workers.get(pid)?.worker.postMessage(event);
  };

  const notifyUdp = (pid: number, event: UdpKernelEvent) => {
    workers.get(pid)?.worker.postMessage(event);
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
    let netClient: { sab: SharedArrayBuffer; port: MessagePort };
    try {
      worker = createProcessWorker(pid);
      client = attachFsClient(pid);
      syncClient = attachSyncClient(pid);
      netClient = attachNetClient(pid);
    } catch (cause) {
      spec.workerThread?.port.close(); // never handed off - would otherwise leak an open port
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
          spawn({ processId: data.childPid, command: data.command, args: data.args, cwd: data.cwd, env: data.env, parentPid: pid, ipc: data.ipc });
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
        case "child:ipc":
          writeIpc(data.childPid, data.chunk);
          break;
        case "child:ipcEnd":
          endIpc(data.childPid);
          break;
        case "ipcOut":
          parentOf(pid)?.postMessage({ type: "child:ipcOut", childPid: pid, chunk: data.chunk });
          break;
        case "ipcOutEnd":
          parentOf(pid)?.postMessage({ type: "child:ipcOutEnd", childPid: pid });
          break;
        case "net:unlisten":
          netRelay.unlisten(pid, data.port);
          break;
        case "net:connect":
          netRelay.connect(pid, data.ticket, data.port);
          break;
        case "net:data":
          netRelay.data(pid, data.connId, data.chunk);
          break;
        case "net:shutdown":
          netRelay.shutdown(pid, data.connId);
          break;
        case "net:close":
          netRelay.close(pid, data.connId);
          break;
        case "udp:unbind":
          udpRelay.unbind(pid, data.port);
          break;
        case "udp:send":
          udpRelay.send(pid, data.fromPort, data.toPort, data.chunk);
          break;
        case "workerThread:spawn": {
          // threadId comes from the CALLER (minted synchronously there, via the shared
          // threadIdCounterSab every process already holds) - only pid is kernel-minted here.
          const childPid = mintWorkerThreadPid();
          const { threadId } = data;
          spawn({
            processId: childPid,
            command: "",
            args: [],
            cwd: data.cwd,
            env: data.env,
            parentPid: pid,
            workerThread: {
              threadId,
              threadName: data.threadName,
              isInternal: data.isInternal,
              resourceLimits: data.resourceLimits,
              port: data.port,
            },
          });
          worker.postMessage({ type: "workerThread:started", ticket: data.ticket, childPid, threadId });
          break;
        }
      }
    };
    worker.onerror = (event) => {
      finalize(pid, 1, {
        errorMessage: `Process worker error: ${event.message || "unknown error"}`,
      });
    };

    const transfer = [client.port, syncClient.port, netClient.port];
    if (spec.workerThread) transfer.push(spec.workerThread.port);
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
        netSab: netClient.sab,
        netPort: netClient.port,
        ipc: spec.ipc ?? false,
        workerThread: spec.workerThread,
        threadIdCounterSab,
      },
      transfer,
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
    writeIpc,
    endIpc,
    notifyWatch,
    notifyNet,
    notifyUdp,
    has: (pid) => workers.has(pid),
    get size() {
      return workers.size;
    },
  };
};

export { createProcessTable };

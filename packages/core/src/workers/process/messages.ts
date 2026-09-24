/** Kernel -> process worker, sent once right after the worker is created. */
export interface IProcessInit {
  type: "init";
  pid: number;
  command: string;
  args: string[];
  cwd: string;
  env: Record<string, string>;
  /** This process's syscall buffer; also registered with the fs worker. */
  sab: SharedArrayBuffer;
  /** Doorbell to the fs worker: post anything to say "my SAB has a request". */
  fsPort: MessagePort;
  /** A second syscall buffer for execSync/spawnSync, serviced by the kernel itself. */
  syncSab: SharedArrayBuffer;
  /** Doorbell straight to the kernel worker for `syncSab`. */
  syncPort: MessagePort;
  /** A third syscall buffer for net.Server.listen(), serviced by the kernel itself - see kernel/netServer.ts. */
  netSab: SharedArrayBuffer;
  /** Doorbell straight to the kernel worker for `netSab`. */
  netPort: MessagePort;
  /** Whether this process was spawned via `fork()` and should get an IPC channel (`process.send`/`.on('message')`). */
  ipc: boolean;
  /** Set only when this process IS a worker_threads.Worker, not a top-level/child_process spawn -
   *  see runtime/bindings/worker.ts. */
  workerThread?: IWorkerThreadInit;
  /** The shared, globally-coordinated threadId counter EVERY process gets (not just worker
   *  threads themselves) - any process might itself call `new Worker(...)`, and threadId must be
   *  mintable synchronously, without a kernel round trip (see kernel/index.ts's own comment on
   *  this field for why). A SharedArrayBuffer needs no transfer-list entry: structured-cloning one
   *  hands the receiving realm a reference to the SAME underlying memory, not a copy - the same
   *  way every other per-process SAB here already travels. */
  threadIdCounterSab: SharedArrayBuffer;
}

/**
 * What a worker_threads.Worker's own new Process Worker needs to exist at all. Deliberately NOT
 * here: filename/doEval/workerData/url. Real vendored internal/worker.js already sends the real
 * LOAD_SCRIPT message - carrying exactly those - over `port` below BEFORE it ever calls
 * startThread() (see bindings/worker.ts's own comment on why); a real MessagePort buffers a
 * message sent before the other side is listening, so by the time this new process's own
 * runWorkerThread() actually reads `port`, LOAD_SCRIPT is already there waiting. `port` itself is
 * handed over at spawn time via IProcessInit, not as a later postMessage, since this sandbox's
 * kernel already has to broker a real MessageChannel transfer to get the child process worker
 * created at all.
 */
export interface IWorkerThreadInit {
  /** worker_threads' own small, monotonic numbering - NOT the same as `pid` above (a real OS pid
   *  and a worker_threads threadId are different namespaces in real Node too). */
  threadId: number;
  threadName: string;
  isInternal: boolean;
  /** Real Node's own resourceLimits Float64Array layout (kMaxYoungGenerationSizeMb, ...) - accepted
   *  and reported back via `resourceLimits`, never enforced (see runtime/bindings/worker.ts). */
  resourceLimits: number[];
  /** This thread's OWN real, native MessagePort - the other half of the same MessageChannel the
   *  parent-side WorkerHandle kept as its own `.messagePort` (runtime/bindings/worker.ts). Every
   *  other message (the public postMessage/parentPort channel, workerData, stdio) rides on TOP of
   *  this one real channel via already-vendored internal/worker.js/internal/worker/io.js code -
   *  structured clone and port transfer are real platform primitives, so none of that needs a
   *  wire protocol of its own here.
   */
  port: MessagePort;
}

/**
 * Kernel -> process worker: this process's own stdin (from the host's
 * `IProcess.stdin`, or from a parent's `child.stdin` - the worker receiving it
 * doesn't distinguish the two), plus events for a child_process it spawned.
 */
export type ChildEvent =
  | { type: "stdin"; chunk: Uint8Array }
  | { type: "stdinEnd" }
  /** This process's own incoming fork() IPC channel (only sent if `IProcessInit.ipc` was true). */
  | { type: "ipc"; chunk: Uint8Array }
  | { type: "ipcEnd" }
  | { type: "child:stdout" | "child:stderr"; childPid: number; chunk: Uint8Array }
  /** A child_process's own outgoing ipc message, or its disconnect - see bindings/childProcess.ts's ChildRouter. */
  | { type: "child:ipcOut"; childPid: number; chunk: Uint8Array }
  | { type: "child:ipcOutEnd"; childPid: number }
  | { type: "child:exit"; childPid: number; exitCode: number; signal?: "SIGTERM" | "SIGKILL"; errorMessage?: string }
  /** A change reported for one of this process's own fs.watch/watchFile watches - see kernel/processes.ts's notifyWatch. */
  | { type: "watchEvent"; watchId: number; eventType: "rename" | "change"; filename: string }
  /** The virtual network (kernel/netServer.ts): reply to this process's own net:connect (`ticket`
   *  is what it sent), a new inbound connection on a port it's listening on, a byte chunk from
   *  the peer on either side of an established connection, or that connection closing. */
  | { type: "net:connectResult"; ticket: number; ok: true; connId: number }
  | { type: "net:connectResult"; ticket: number; ok: false; code: string }
  | { type: "net:incoming"; connId: number; port: number }
  | { type: "net:data"; connId: number; chunk: Uint8Array }
  /** The peer shut down its write side (half-close): EOF for our read side, but the connection
   *  stays registered - we may still write, and (if the peer is only half-closed too) receive. */
  | { type: "net:eof"; connId: number }
  /** The peer fully closed: EOF for our read side, and the connection is gone for good. */
  | { type: "net:close"; connId: number }
  /** A UDP datagram arrived on one of this process's own bound ports (kernel/netServer.ts's
   *  udpSend) - connectionless, so there's no equivalent of net:incoming/net:close: every message
   *  just arrives, addressed by port, exactly like a real one. */
  | { type: "udp:message"; port: number; fromPort: number; chunk: Uint8Array }
  /** Reply to this process's own workerThread:spawn (`ticket` is what it sent): the kernel has
   *  minted the real pid and actually spawned the child - `threadId` is just echoed back (this
   *  process already minted it itself, synchronously, before ever sending workerThread:spawn) -
   *  see runtime/bindings/worker.ts's WorkerImpl. */
  | { type: "workerThread:started"; ticket: number; childPid: number; threadId: number };

/** Process worker -> kernel. */
export type ProcessEvent =
  | { type: "stdout" | "stderr"; chunk: Uint8Array }
  | { type: "exit"; code: number }
  /** Spawn a child_process; childPid is minted by this worker, unique kernel-wide (see kernel/processes.ts). */
  | { type: "child:spawn"; childPid: number; command: string; args: string[]; cwd?: string; env?: Record<string, string>; ipc?: boolean }
  | { type: "child:kill"; childPid: number; signal?: string }
  /** Write to / end a child_process's stdin; routed the same way as child:spawn. */
  | { type: "child:stdin"; childPid: number; chunk: Uint8Array }
  | { type: "child:stdinEnd"; childPid: number }
  /** Write to / end a fork()ed child_process's incoming ipc channel - a separate channel from stdin. */
  | { type: "child:ipc"; childPid: number; chunk: Uint8Array }
  | { type: "child:ipcEnd"; childPid: number }
  /** This process's own outgoing ipc message (only if it was itself fork()ed), or its disconnect. */
  | { type: "ipcOut"; chunk: Uint8Array }
  | { type: "ipcOutEnd" }
  /** The async half of the virtual network - see kernel/netServer.ts. `ticket` is this process's
   *  own correlation id for net:connectResult (minted locally, like a child_process's childPid). */
  | { type: "net:unlisten"; port: number }
  | { type: "net:connect"; ticket: number; port: number }
  | { type: "net:data"; connId: number; chunk: Uint8Array }
  /** Half-close (done writing) vs full teardown - see kernel/netServer.ts's shutdown()/close(). */
  | { type: "net:shutdown"; connId: number }
  | { type: "net:close"; connId: number }
  /** dgram.Socket.close(): release a UDP port binding - see kernel/netServer.ts's udpUnbind(). */
  | { type: "udp:unbind"; port: number }
  /** A datagram this process is sending from its own `fromPort` to `toPort` - see udpSend(). */
  | { type: "udp:send"; fromPort: number; toPort: number; chunk: Uint8Array }
  /** `new Worker(...)`: spawn a real worker_threads child. Unlike child:spawn's childPid, `pid` is
   *  minted by the KERNEL (see kernel/index.ts's WORKER_THREAD_PID_START) - it names a real,
   *  kernel-tracked Process Worker slot, the same reason net.listen()'s port assignment is
   *  kernel-side too. `threadId`, by contrast, is minted by THIS worker itself, synchronously, via
   *  the shared threadIdCounterSab every process holds (IProcessInit's own field) - real vendored
   *  internal/worker.js reads it immediately after constructing its own native handle, before the
   *  kernel could ever reply, so it can't wait for one (see that SAB's own comment for the full
   *  story). `ticket` is this process's own correlation id for the eventual workerThread:started
   *  reply (minted locally, like net's own connect ticket). `port` is this new worker's own half
   *  of a real MessageChannel this process already created locally (see runtime/bindings/worker.ts)
   *  - transferred through the kernel into the new process worker's own IProcessInit.workerThread.port. */
  | {
      type: "workerThread:spawn";
      ticket: number;
      threadId: number;
      threadName: string;
      isInternal: boolean;
      env: Record<string, string>;
      cwd: string;
      resourceLimits: number[];
      port: MessagePort;
    };

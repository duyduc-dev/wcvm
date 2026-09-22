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
  /** Whether this process was spawned via `fork()` and should get an IPC channel (`process.send`/`.on('message')`). */
  ipc: boolean;
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
  | { type: "watchEvent"; watchId: number; eventType: "rename" | "change"; filename: string };

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
  | { type: "ipcOutEnd" };

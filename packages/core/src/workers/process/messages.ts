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
}

/** Kernel -> process worker, for a child_process this worker spawned. */
export type ChildEvent =
  | { type: "child:stdout" | "child:stderr"; childPid: number; chunk: Uint8Array }
  | { type: "child:exit"; childPid: number; exitCode: number; signal?: "SIGTERM" | "SIGKILL"; errorMessage?: string };

/** Process worker -> kernel. */
export type ProcessEvent =
  | { type: "stdout" | "stderr"; chunk: Uint8Array }
  | { type: "exit"; code: number }
  /** Spawn a child_process; childPid is minted by this worker, unique kernel-wide (see kernel/processes.ts). */
  | { type: "child:spawn"; childPid: number; command: string; args: string[]; cwd?: string; env?: Record<string, string> }
  | { type: "child:kill"; childPid: number; signal?: string };

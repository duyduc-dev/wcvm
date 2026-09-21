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

/** Process worker -> kernel. */
export type ProcessEvent =
  | { type: "stdout" | "stderr"; chunk: Uint8Array }
  | { type: "exit"; code: number };

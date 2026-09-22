import type { IFsClient } from "../fs/fsClient";
import type { ISyscallClient } from "../protocols/syscall";
import type { IChildProcessHost, IForkIpcHost } from "../runtime/bindings/childProcess";
import type { IFsWatchHost } from "../runtime/bindings/fs";
import type { IStdinHost } from "../runtime/runtime";

export interface IProgramContext {
  /** Arguments after the command name. */
  args: string[];
  cwd: string;
  env: Record<string, string>;
  fs: IFsClient;
  stdout(data: string | Uint8Array): void;
  stderr(data: string | Uint8Array): void;
  pid: number;
  /** In a dedicated process worker, `self`: programs may install Node's globals on it. */
  globalObject?: Record<string, any>;
  /** Injected so tests need not wait in real time. */
  sleep(ms: number): Promise<void>;
  /** Backs `node`'s child_process; undefined outside a real process worker. */
  childProcess?: IChildProcessHost;
  /** This process's own stdin; undefined outside a real process worker. */
  stdin?: IStdinHost;
  /** Backs `node`'s child_process.execSync/spawnSync; undefined outside a real process worker. */
  spawnSync?: ISyscallClient;
  /** This process's own `fork()` IPC channel; only set when it was itself spawned via `fork()`. */
  ipc?: IForkIpcHost;
  /** Delivers fs.watch change events pushed from the kernel; undefined outside a real process worker. */
  fsWatch?: IFsWatchHost;
}

/** Resolves to the process exit status. */
export type Program = (ctx: IProgramContext) => number | Promise<number>;

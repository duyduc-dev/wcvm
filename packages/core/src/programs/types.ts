import type { IFsClient } from "../fs/fsClient";

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
}

/** Resolves to the process exit status. */
export type Program = (ctx: IProgramContext) => number | Promise<number>;

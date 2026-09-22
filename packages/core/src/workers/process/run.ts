import type { IFsClient } from "../../fs/fsClient";
import { resolveProgram } from "../../programs";
import type { ISyscallClient } from "../../protocols/syscall";
import type { IChildProcessHost, IForkIpcHost } from "../../runtime/bindings/childProcess";
import type { IStdinHost } from "../../runtime/runtime";

export type StdStream = "stdout" | "stderr";

export interface IRunParams {
  command: string;
  args: string[];
  cwd: string;
  env: Record<string, string>;
  fs: IFsClient;
  write(stream: StdStream, chunk: Uint8Array): void;
  sleep(ms: number): Promise<void>;
  pid?: number;
  /** See IProgramContext.globalObject. */
  globalObject?: Record<string, any>;
  /** See IProgramContext.childProcess. */
  childProcess?: IChildProcessHost;
  /** See IProgramContext.stdin. */
  stdin?: IStdinHost;
  /** See IProgramContext.spawnSync. */
  spawnSync?: ISyscallClient;
  /** See IProgramContext.ipc. */
  ipc?: IForkIpcHost;
}

const EXIT_COMMAND_NOT_FOUND = 127;

const encoder = new TextEncoder();

/**
 * Runs one command to completion and returns its exit status. Kept free of
 * `self` so it runs (and is tested) anywhere; the worker entry only wires it
 * to postMessage and the fs client.
 */
const runProcess = async (params: IRunParams): Promise<number> => {
  const { command, args, cwd, env, fs, write, sleep } = params;
  const toBytes = (data: string | Uint8Array) =>
    typeof data === "string" ? encoder.encode(data) : data;
  const stderr = (data: string | Uint8Array) => write("stderr", toBytes(data));

  const program = resolveProgram(command);
  if (!program) {
    stderr(`wcvm: command not found: ${command}\n`);
    return EXIT_COMMAND_NOT_FOUND;
  }

  try {
    if (fs.stat(cwd).kind !== "dir") throw new Error("not a directory");
  } catch {
    stderr(`wcvm: cannot change directory to '${cwd}'\n`);
    return 1;
  }

  try {
    return await program({
      args,
      cwd,
      env,
      fs,
      sleep,
      stderr,
      pid: params.pid ?? 0,
      globalObject: params.globalObject,
      childProcess: params.childProcess,
      stdin: params.stdin,
      spawnSync: params.spawnSync,
      ipc: params.ipc,
      stdout: (data) => write("stdout", toBytes(data)),
    });
  } catch (error) {
    stderr(`${command}: ${error instanceof Error ? error.message : String(error)}\n`);
    return 1;
  }
};

export { runProcess };

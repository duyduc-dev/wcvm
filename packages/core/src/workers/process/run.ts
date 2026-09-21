import type { IFsClient } from "../../fs/fsClient";
import { resolveProgram } from "../../programs";

export type StdStream = "stdout" | "stderr";

export interface IRunParams {
  command: string;
  args: string[];
  cwd: string;
  env: Record<string, string>;
  fs: IFsClient;
  write(stream: StdStream, chunk: Uint8Array): void;
  sleep(ms: number): Promise<void>;
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
  const stderr = (text: string) => write("stderr", encoder.encode(text));

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
      stdout: (data) =>
        write("stdout", typeof data === "string" ? encoder.encode(data) : data),
    });
  } catch (error) {
    stderr(`${command}: ${error instanceof Error ? error.message : String(error)}\n`);
    return 1;
  }
};

export { runProcess };

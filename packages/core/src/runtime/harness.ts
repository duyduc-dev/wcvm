import { createLoopbackFs } from "../testing/loopbackFs";
import type { ISyscallClient } from "../protocols/syscall";
import type { IChildProcessHost, IForkIpcHost } from "./bindings/childProcess";
import { createRuntime, type IRuntimeOptions, type IStdinHost } from "./runtime";

const dirname = (p: string) => p.slice(0, p.lastIndexOf("/")) || "/";

/** Writes `files` into a fresh VFS, runs `entry` under a real runtime, collects output. */
export const runScript = async (
  files: Record<string, string>,
  entry: string,
  options: Partial<Pick<IRuntimeOptions, "argv" | "env" | "cwd">> & {
    setup?: (runtime: ReturnType<typeof createRuntime>) => void;
    childProcess?: IChildProcessHost;
    stdin?: IStdinHost;
    spawnSync?: ISyscallClient;
    ipc?: IForkIpcHost;
  } = {},
) => {
  const { fs, vfs } = createLoopbackFs();
  for (const [path, contents] of Object.entries(files)) {
    fs.mkdir(dirname(path), { recursive: true });
    fs.writeFile(path, contents);
  }

  const out: string[] = [];
  const err: string[] = [];
  const decoder = new TextDecoder();
  const runtime = createRuntime({
    fs,
    cwd: options.cwd ?? "/",
    argv: options.argv ?? ["/bin/node"],
    env: options.env ?? {},
    host: {
      write: (stream, chunk) => (stream === "stdout" ? out : err).push(decoder.decode(chunk)),
      childProcess: options.childProcess,
      stdin: options.stdin,
      spawnSync: options.spawnSync,
      ipc: options.ipc,
    },
  });
  options.setup?.(runtime);
  const code = await runtime.runMain(entry);
  return { code, stdout: out.join(""), stderr: err.join(""), runtime, fs, vfs };
};

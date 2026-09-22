import { FsServer } from "../fs/FsServer";
import { createLoopbackFs } from "../testing/loopbackFs";
import type { ISyscallClient } from "../protocols/syscall";
import type { IChildProcessHost, IForkIpcHost } from "./bindings/childProcess";
import type { IFsWatchHost } from "./bindings/fs";
import type { INetHost } from "./bindings/net";
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
    net?: INetHost;
    netSync?: ISyscallClient;
  } = {},
) => {
  // fs.watch is entirely local to one FsServer (no worker boundary in this single-thread
  // harness), so every runScript() gets real watch support for free - createLoopbackFs's one
  // registered client is always id 1.
  let onWatchEvent: ((event: { watchId: number; eventType: "rename" | "change"; filename: string }) => void) | null = null;
  const server = new FsServer(undefined, (clientId, watchId, eventType, filename) => {
    if (clientId === 1) onWatchEvent?.({ watchId, eventType, filename });
  });
  const fsWatch: IFsWatchHost = { onEvent: (handler) => (onWatchEvent = handler) };

  const { fs, vfs } = createLoopbackFs(server);
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
      fsWatch,
      net: options.net,
      netSync: options.netSync,
    },
  });
  options.setup?.(runtime);
  const code = await runtime.runMain(entry);
  return { code, stdout: out.join(""), stderr: err.join(""), runtime, fs, vfs };
};

import type { IFsClient } from "../../fs/fsClient";
import type { ISyscallClient } from "../../protocols/syscall";
import type { IChildProcessHost } from "../../runtime/bindings/childProcess";
import type { IFsWatchHost } from "../../runtime/bindings/fs";
import type { INetHost } from "../../runtime/bindings/net";
import type { IUdpHost } from "../../runtime/bindings/udp";
import type { IWorkerThreadHost } from "../../runtime/bindings/worker";
import { createRuntime } from "../../runtime/runtime";
import type { IWorkerThreadInit } from "./messages";

export interface IRunWorkerThreadParams {
  pid: number;
  cwd: string;
  env: Record<string, string>;
  fs: IFsClient;
  workerThread: IWorkerThreadInit;
  globalObject?: Record<string, any>;
  write(stream: "stdout" | "stderr", chunk: Uint8Array): void;
  childProcess?: IChildProcessHost;
  spawnSync?: ISyscallClient;
  fsWatch?: IFsWatchHost;
  net?: INetHost;
  netSync?: ISyscallClient;
  udp?: IUdpHost;
  /** So a worker_threads.Worker can itself spawn nested worker_threads.Worker children. */
  workerThreadHost?: IWorkerThreadHost;
  /** So a nested worker_threads.Worker's own threadId is minted synchronously too - see
   *  runtime/bindings/worker.ts's IWorkerContext.mintThreadId. */
  mintThreadId?: () => number;
}

/** Real Node's own message-type strings (internal/worker/io.js's `messageTypes` object) - not
 *  re-exported anywhere this file could import them from, so they're just matched here as the
 *  literal wire values that vendored code actually sends/expects. */
const LOAD_SCRIPT = "loadScript";
const UP_AND_RUNNING = "upAndRunning";

interface ILoadScriptMessage {
  type: "loadScript";
  filename: string;
  doEval: false | "classic" | "internal" | "data-url";
  workerData: unknown;
  environmentData: Map<unknown, unknown>;
  publicPort: MessagePort;
  mainThreadPort: MessagePort;
}

/**
 * Bootstraps a worker_threads.Worker: sets up a real Node runtime (isMainThread: false), then
 * waits for the real LOAD_SCRIPT message real vendored internal/worker.js already sent over
 * `workerThread.port` (before ever calling this process into existence at all - see
 * bindings/worker.ts's own comment on why there's nothing to race here) to learn what to
 * actually run. Mirrors run.ts's own runProcess() shape, but there's no `command` to resolve -
 * this always runs a real Node script/eval, never a builtin program - and no
 * internal/main/worker_thread.js to vendor (Node's own bootstrap entry scripts are tightly
 * coupled to its C++ startup order; this project already hand-writes the equivalent for
 * runMain()/runEval()/runRepl() in runtime.ts itself, for the exact same reason).
 */
const runWorkerThread = async (params: IRunWorkerThreadParams): Promise<number> => {
  const { workerThread } = params;
  const runtime = createRuntime({
    fs: params.fs,
    cwd: params.cwd,
    env: params.env,
    pid: params.pid,
    argv: ["/bin/node"],
    globalObject: params.globalObject,
    host: {
      write: params.write,
      childProcess: params.childProcess,
      spawnSync: params.spawnSync,
      fsWatch: params.fsWatch,
      net: params.net,
      netSync: params.netSync,
      udp: params.udp,
      workerThread: params.workerThreadHost,
      mintThreadId: params.mintThreadId,
      workerSelf: {
        threadId: workerThread.threadId,
        threadName: workerThread.threadName,
        resourceLimits: workerThread.resourceLimits,
        port: workerThread.port,
      },
    },
  });

  const loadScript = await new Promise<ILoadScriptMessage>((resolve) => {
    workerThread.port.onmessage = (event) => {
      const data = event.data as { type?: string };
      if (data?.type !== LOAD_SCRIPT) return;
      resolve(data as ILoadScriptMessage);
    };
  });

  // internal/worker/io.js (required transitively by worker_threads, below) is what defines the
  // oninit symbol's actual FUNCTION on MessagePort.prototype and performs the NodeEventTarget
  // prototype swap - both must already have happened in THIS realm before initReceivedPort can do
  // anything useful (calling it earlier would silently no-op: the symbol property exists but
  // isn't a function yet). Load the module first, exactly once, so the require() cache serves the
  // SAME module object the child's own `require('worker_threads')` calls will reuse.
  const workerThreadsModule = runtime.loader.requireBuiltin("worker_threads");

  // loadScript.publicPort/mainThreadPort both crossed a real postMessage transfer from the
  // parent's own realm (created there, via internal/worker.js's own `new MessageChannel()`/
  // internal/worker/messaging.js's own createMainThreadPort()) - oninit()'s effects are plain
  // per-object JS state that does NOT survive that transfer, so this realm's own copy needs it
  // run again before guest code (or vendored code) can call .on()/.addEventListener() on either.
  // See messaging.ts's PLATFORM GAP comment.
  runtime.internalBinding("messaging").initReceivedPort(loadScript.publicPort);
  runtime.internalBinding("messaging").initReceivedPort(loadScript.mainThreadPort);

  workerThreadsModule.parentPort = loadScript.publicPort;
  workerThreadsModule.workerData = loadScript.workerData;
  runtime.loader.requireBuiltin("internal/worker").assignEnvironmentData(loadScript.environmentData);
  // Real internal/main/worker_thread.js (not vendored - see this file's own header) calls this
  // right after LOAD_SCRIPT arrives: without it, internal/worker/messaging.js's own module-level
  // `mainThreadPort` stays undefined in THIS realm, which is invisible until this worker thread
  // tries to spawn a NESTED worker_threads.Worker of its own - createMainThreadPort() then needs
  // to relay its own registration through `mainThreadPort.postMessage(...)` (this thread isn't
  // the main one), throwing "Cannot read properties of undefined (reading 'postMessage')"
  // instead. Confirmed in real Chromium: a worker-thread-spawns-worker-thread script crashed
  // exactly this way before this fix.
  runtime.loader.requireBuiltin("internal/worker/messaging").setupMainThreadPort(loadScript.mainThreadPort);
  loadScript.publicPort.start();

  workerThread.port.postMessage({ type: UP_AND_RUNNING });

  if (loadScript.doEval === "classic" || loadScript.doEval === "data-url") return runtime.runEval(loadScript.filename);
  return runtime.runMain(loadScript.filename);
};

export { runWorkerThread };

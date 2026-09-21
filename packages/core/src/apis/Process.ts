import { IKernelBridge } from "../bridges/kernel";
import { IProcess, IProcessExit, ISpawnOptions } from "../models";

const createProcessApi = (
  kernelBridge: IKernelBridge,
  processId: number,
  command: string,
  args: string[],
  options?: ISpawnOptions,
): IProcess => {
  const offs: Array<() => void> = [];
  const controllers: Record<"stdout" | "stderr", ReadableStreamDefaultController<Uint8Array> | undefined> = {
    stdout: undefined,
    stderr: undefined,
  };

  const stream = (name: "stdout" | "stderr") =>
    new ReadableStream<Uint8Array>({
      start(controller) {
        controllers[name] = controller;
      },
    });
  const stdout = stream("stdout");
  const stderr = stream("stderr");
  const stdin = new WritableStream<Uint8Array>({
    write: (chunk) => kernelBridge.postMessage("process:stdin", { processId, chunk }),
    close: () => kernelBridge.postMessage("process:stdinEnd", { processId }),
  });

  // Subscribe before posting so nothing the kernel sends can be missed.
  for (const name of ["stdout", "stderr"] as const) {
    offs.push(
      kernelBridge.on(`process:${name}`, (e) => {
        if (e.processId === processId) {
          controllers[name]?.enqueue(e.chunk as Uint8Array);
        }
      }),
    );
  }

  const exit = new Promise<IProcessExit>((resolve) => {
    offs.push(
      kernelBridge.on("process:exit", (e) => {
        if (e.processId !== processId) return;
        offs.forEach((off) => off());
        // Kernel messages are ordered, so every chunk is already queued.
        controllers.stdout?.close();
        controllers.stderr?.close();
        resolve({
          exitCode: e.exitCode as number,
          errorMessage: e.errorMessage as string | undefined,
          signal: e.signal as IProcessExit["signal"],
        });
      }),
    );
  });

  kernelBridge.postMessage("process:spawn", {
    processId,
    command,
    args,
    cwd: options?.cwd,
    env: options?.env,
  });

  return {
    processId,
    stdout,
    stderr,
    stdin,
    exit,
    kill: (signal) => kernelBridge.postMessage("process:kill", { processId, signal }),
  };
};

export { createProcessApi };

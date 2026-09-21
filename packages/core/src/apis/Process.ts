import { IKernelBridge } from "../bridges/kernel";
import { IProcess, IProcessExit, ISpawnOptions } from "../models";

const createProcessApi = (
  kernelBridge: IKernelBridge,
  processId: number,
  command: string,
  args: string[],
  options?: ISpawnOptions,
): IProcess => {
  // Subscribe before posting so the exit message can't be missed.
  const exit = new Promise<IProcessExit>((resolve) => {
    const off = kernelBridge.on("process:exit", (e) => {
      if (e.processId !== processId) return;
      off();
      resolve({
        errorCode: e.errorCode as number,
        errorMessage: e.errorMessage as string | undefined,
      });
    });
  });

  kernelBridge.postMessage("process:spawn", {
    processId,
    command,
    args,
    cwd: options?.cwd,
    env: options?.env,
  });

  return { processId, exit };
};

export { createProcessApi };

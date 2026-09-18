import { IKernelBridge } from "../bridges/kernel";
import { ISpawnOptions } from "../models";

const createProcessApi = (
  kernelBridge: IKernelBridge,
  processId: number,
  command: string,
  args: string[],
  options?: ISpawnOptions,
) => {
  const process = kernelBridge.request("process-spawn", {
    processId,
    command,
    args,
    cwd: options?.cwd,
    env: options?.env,
  });
  return process;
};

export { createProcessApi };

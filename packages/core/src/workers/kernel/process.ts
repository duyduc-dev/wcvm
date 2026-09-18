import { IKernelHost } from "../../kernel";

const processSpawn = (
  kernel: IKernelHost,
  processId: number,
  command: string,
  args: string[],
  cwd: string | undefined,
  env: Record<string, string> | undefined,
) => {};

export { processSpawn };

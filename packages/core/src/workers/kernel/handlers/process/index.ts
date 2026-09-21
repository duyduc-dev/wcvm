import { KernelMessage } from "../../../../bridges/models";
import { IKernelHost } from "../../../../kernel";
import { baseEnv } from "../../protocols";
import { RouteHandler } from "../../router";

interface IParams {
  kernel: IKernelHost;
  processId: number;
  command: string;
  args: string[];
  cwd: string | undefined;
  env: Record<string, string> | undefined;
  onPostMessage: (message: KernelMessage) => void;
}

const processSpawn = (params: IParams) => {
  const { processId, env: paramEnvs, cwd: paramCwd, onPostMessage } = params;
  const env = { ...baseEnv(), ...paramEnvs };
  const cwd = paramCwd || "/";

  onPostMessage({
    type: "process:exit",
    processId: processId,
    errorCode: 0,
  });
};

const processSpawnHandler: RouteHandler = ({
  event: e,
  stateManager,
  onPostMessage,
}) => {
  const data = e.data;
  const { kernel } = stateManager.getState();

  if (!kernel) {
    onPostMessage({
      type: "process:exit",
      processId: data.processId,
      errorCode: 1,
      errorMessage: "Kernel isn't ready",
    });
    return;
  }

  processSpawn({
    kernel,
    processId: data.processId as number,
    command: data.command as string,
    args: data.args as string[],
    cwd: data.cwd as string | undefined,
    env: data.env as Record<string, string> | undefined,
    onPostMessage,
  });
};

export { processSpawnHandler };

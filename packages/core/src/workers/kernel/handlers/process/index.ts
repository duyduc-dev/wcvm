import { WcvmError } from "../../../../errors/WcvmError";
import type { IKernelHost } from "../../../../kernel";
import { Router, RouteHandler } from "../../router";

const withKernel = (
  run: (kernel: IKernelHost, data: Record<string, unknown>) => void,
): RouteHandler => ({ event, stateManager, onPostMessage }) => {
  const data = event.data;
  const { kernel } = stateManager.getState();

  if (!kernel) {
    // Spawn is fire-and-forget on the wire, so the failure has to come back
    // as the process's own exit or the caller would wait forever.
    if (event.data.type === "process:spawn") {
      onPostMessage({
        type: "process:exit",
        processId: data.processId,
        errorCode: 1,
        errorMessage: "Kernel isn't ready",
      });
      return;
    }
    throw new WcvmError("ERR_WORKER", "Kernel isn't ready");
  }
  run(kernel, data);
};

const processSpawnHandler = withKernel((kernel, data) =>
  kernel.processes.spawn({
    processId: data.processId as number,
    command: data.command as string,
    args: data.args as string[],
    cwd: data.cwd as string | undefined,
    env: data.env as Record<string, string> | undefined,
  }),
);

const processKillHandler = withKernel((kernel, data) =>
  kernel.processes.kill(data.processId as number, data.signal as string | undefined),
);

const registerProcessHandlers = (router: Router): void => {
  router.handle("process:spawn", processSpawnHandler);
  router.handle("process:kill", processKillHandler);
};

export { processSpawnHandler, processKillHandler, registerProcessHandlers };

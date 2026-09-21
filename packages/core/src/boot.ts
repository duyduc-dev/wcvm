import { createProcessApi } from "./apis/Process";
import { createKernelBridge } from "./bridges/kernel";
import { WcvmError } from "./errors/WcvmError";
import { ISpawnOptions, IState } from "./models";
import { createDiagnostics } from "./protocols/diagnostics";
import { createState } from "./protocols/state";
import { isCrossOriginIsolated } from "./utilities";

const boot = () => {
  if (!isCrossOriginIsolated()) {
    throw new WcvmError(
      "ERR_NOT_ISOLATED",
      "WCVM requires a cross-origin isolated page (SharedArrayBuffer). " +
        "Serve your page with the headers `Cross-Origin-Opener-Policy: same-origin` " +
        "and `Cross-Origin-Embedder-Policy: require-corp`.",
    );
  }

  const diagnostics = createDiagnostics();
  const stateManager = createState<IState>({ processId: 0 }, diagnostics);
  const kernelBridge = createKernelBridge({ diagnostics, stateManager });

  // Boot kernel
  kernelBridge.boot();

  const spawn = async (
    command: string,
    args: string[],
    options?: ISpawnOptions,
  ) => {
    stateManager.setState((prevState) => ({
      processId: prevState.processId + 1,
    }));

    return createProcessApi(
      kernelBridge,
      stateManager.getState().processId,
      command,
      args,
      options,
    );
  };

  return { spawn, diagnostics };
};

export { boot };

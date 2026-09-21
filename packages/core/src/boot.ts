import { createProcessApi } from "./apis/Process";
import { createKernelBridge } from "./bridges/kernel";
import { WcvmError } from "./errors/WcvmError";
import { ISpawnOptions, IState } from "./models";
import { createDiagnostics } from "./protocols/diagnostics";
import { createState } from "./protocols/state";
import { isCrossOriginIsolated } from "./utilities";

interface IBootOptions {
  /** How long to wait for the kernel's `ready` message. Defaults to 10s. */
  bootTimeoutMs?: number;
}

const DEFAULT_BOOT_TIMEOUT_MS = 10_000;

const boot = (options: IBootOptions = {}) => {
  const { bootTimeoutMs = DEFAULT_BOOT_TIMEOUT_MS } = options;

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

  // Subscribe before posting `boot` so the `ready` message can't be missed.
  const ready = new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      off();
      reject(
        new WcvmError(
          "ERR_BOOT_TIMEOUT",
          `Kernel did not become ready within ${bootTimeoutMs}ms.`,
        ),
      );
    }, bootTimeoutMs);
    const off = kernelBridge.on("ready", () => {
      clearTimeout(timer);
      off();
      resolve();
    });
  });
  // Nobody is required to await `ready`; keep an unobserved rejection from
  // surfacing as an unhandled one. Awaiters still see the rejection.
  ready.catch(() => {});

  // Boot kernel
  kernelBridge.boot();

  const spawn = async (
    command: string,
    args: string[],
    options?: ISpawnOptions,
  ) => {
    await ready;
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

  return { spawn, diagnostics, ready };
};

export { boot };
export type { IBootOptions };

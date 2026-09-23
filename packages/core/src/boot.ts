import { createFsApi } from "./apis/Fs";
import { createPreviewApi } from "./apis/Preview";
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
  /**
   * Mirrors `wc.fs.*` to the Origin Private File System (OPFS), write-behind, and restores from
   * it before this boot's first syscall is ever served - so it must be decided here, not turned
   * on later. `true` uses a default storage root; an explicit `root` name keeps two wcvm
   * instances on the same origin (different demos, or just two tabs) from sharing storage unless
   * they deliberately choose the same one. OPFS has no symlinks, so a script's own symlinks are
   * not persisted (see fs/opfsPersistence.ts).
   */
  persist?: boolean | { root: string };
}

const DEFAULT_BOOT_TIMEOUT_MS = 10_000;

const boot = (options: IBootOptions = {}) => {
  const { bootTimeoutMs = DEFAULT_BOOT_TIMEOUT_MS, persist } = options;

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
      offError();
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
      offError();
      resolve();
    });
    // A failed boot never sends `ready`; surface why instead of timing out.
    const offError = kernelBridge.on("kernel:error", (message) => {
      if (message.messageType !== "boot") return;
      clearTimeout(timer);
      off();
      offError();
      reject(
        new WcvmError(
          "ERR_WORKER",
          `Kernel failed to boot: ${String(message.errorMessage)}`,
        ),
      );
    });
  });
  // Nobody is required to await `ready`; keep an unobserved rejection from
  // surfacing as an unhandled one. Awaiters still see the rejection.
  ready.catch(() => {});

  // Boot kernel
  kernelBridge.boot({ persist });

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

  const fs = createFsApi(kernelBridge, ready);
  const preview = createPreviewApi(kernelBridge);

  return { spawn, fs, diagnostics, ready, preview };
};

type IWcvm = ReturnType<typeof boot>;

export { boot };
export type { IBootOptions, IWcvm };

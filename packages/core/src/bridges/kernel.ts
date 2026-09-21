import { WcvmError } from "../errors/WcvmError";
import { IState } from "../models";
import { Diagnostics } from "../protocols/diagnostics";
import { IStateManager } from "../protocols/state";
import { kernelWorkerHandler } from "./bridgeHandler";
import { IPendingRequest, Handler } from "./models";
import { registerKernelWorker } from "./service";

interface IKernelBridgeParams {
  diagnostics: Diagnostics;
  stateManager: IStateManager<IState>;
  bootTimeoutMs?: number;
}

interface IKernelBridge {
  boot: () => void;
  request: <T = unknown>(
    type: string,
    data?: Record<string, unknown> | undefined,
  ) => Promise<T>;
  postMessage: (
    type: string,
    data?: Record<string, unknown> | undefined,
    transfer?: Transferable[],
  ) => void;
  on: (type: string, handler: Handler) => () => void;
}

const createKernelBridge = (params: IKernelBridgeParams): IKernelBridge => {
  const { diagnostics } = params;

  const pendingRequests = new Map<number, IPendingRequest>();
  const handlers = new Map<string, Set<Handler>>();

  let execId = 0;
  let kernelWorker: Worker;

  try {
    diagnostics.log("kernel-bridge", { message: "Creating kernel worker..." });
    kernelWorker = registerKernelWorker({ name: "KernelWorker" });
    kernelWorkerHandler({
      worker: kernelWorker,
      diagnostics,
      pendingRequests,
      handlers,
    });
    diagnostics.log("kernel-bridge", { message: "Kernel worker created." });
  } catch (cause) {
    diagnostics.log("kernel-bridge", {
      message: "Failed to create kernel worker.",
      cause,
    });
    throw new WcvmError(
      "ERR_WORKER",
      `Failed to create kernel worker: ${(cause as Error).message}`,
    );
  }

  const request = <T = unknown>(
    type: string,
    data?: Record<string, unknown>,
  ) => {
    const reqId = execId++;
    diagnostics.log("kernel-bridge", {
      message: "Sending request to kernel worker.",
      data,
      reqId,
    });
    return new Promise<T>((resolve, reject) => {
      kernelWorker.postMessage({ ...data, type, reqId });
      pendingRequests.set(reqId, {
        resolve: (result) => resolve(result as T),
        reject,
      });
    });
  };

  const postMessage = (
    type: string,
    data: Record<string, unknown> = {},
    transfer: Transferable[] = [],
  ) => {
    kernelWorker.postMessage(
      {
        ...data,
        type,
      },
      transfer,
    );
  };

  const addEventListener = (type: string, handler: Handler): (() => void) => {
    let set = handlers.get(type);
    if (!set) handlers.set(type, (set = new Set()));
    set.add(handler);
    return () => set!.delete(handler);
  };

  return {
    boot: () => postMessage("boot"),
    request,
    postMessage,
    on: addEventListener,
  };
};

export { createKernelBridge };
export type { IKernelBridge };

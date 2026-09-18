import { WcvmError } from "../errors/WcvmError";
import { IState } from "../models";
import { Diagnostics } from "../protocols/diagnostics";
import { IStateManager } from "../protocols/state";
import { registerKernelWorker } from "./service";

interface IKernelBridgeParams {
  diagnostics: Diagnostics;
  stateManager: IStateManager<IState>;
}

interface IKernelBridge {
  request: (
    type: string,
    data?: Record<string, unknown> | undefined,
  ) => Promise<KernelMessage>;
}

interface KernelMessage {
  type: string;
  [key: string]: unknown;
}

interface IPendingRequest {
  resolve: (value: KernelMessage) => void;
  reject: (reason?: unknown) => void;
}

const createKernelBridge = (params: IKernelBridgeParams): IKernelBridge => {
  const { diagnostics } = params;

  const pendingRequests = new Map<number, IPendingRequest>();

  let execId = 0;
  let kernelWorker: Worker;

  try {
    diagnostics.log("kernel-bridge", { message: "Creating kernel worker..." });
    kernelWorker = registerKernelWorker({ name: "KernelWorker" });
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

  kernelWorker.onmessage = (e: MessageEvent<KernelMessage>) => {
    const { type } = e.data;

    if (type == "kernel-response") {
      diagnostics.log("kernel-bridge", {
        message: "Received kernel response.",
        data: e.data,
      });
      const data = e.data;
      const pendingRequest = pendingRequests.get(data.reqId as number);
      if (pendingRequest) {
        pendingRequest.resolve(data);
        pendingRequests.delete(data.reqId as number);
      }
    }
  };

  kernelWorker.onerror = (e: ErrorEvent) => {
    diagnostics.log("kernel-bridge", {
      message: "Kernel worker error.",
      error: e,
    });
    const pendingRequest = pendingRequests.get(execId);
    if (pendingRequest) {
      pendingRequest.reject(e.error);
      pendingRequests.delete(execId);
    }
  };

  const request = (type: string, data?: Record<string, unknown>) => {
    const reqId = execId++;
    diagnostics.log("kernel-bridge", {
      message: "Sending request to kernel worker.",
      data,
      reqId,
    });
    return new Promise<KernelMessage>((resolve, reject) => {
      pendingRequests.set(reqId, { resolve, reject });
      kernelWorker.postMessage({ type, reqId, data });
    });
  };

  return { request };
};

export { createKernelBridge };
export type { IKernelBridge, KernelMessage };

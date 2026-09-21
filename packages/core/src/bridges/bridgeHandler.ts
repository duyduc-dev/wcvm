import { WcvmError } from "../errors/WcvmError";
import { Diagnostics } from "../protocols/diagnostics";
import { Handler, IPendingRequest, KernelMessage } from "./models";

interface IParams {
  worker: Worker;
  diagnostics: Diagnostics;
  pendingRequests: Map<number, IPendingRequest>;
  handlers: Map<string, Set<Handler>>;
}

const kernelWorkerHandler = ({
  worker,
  diagnostics,
  pendingRequests,
  handlers,
}: IParams) => {
  const emit = (m: KernelMessage) => {
    const set = handlers.get(m.type);
    if (set) for (const h of set) h(m);
  };

  worker.onmessage = (e: MessageEvent<KernelMessage>) => {
    const { type } = e.data;
    if (type == "kernel-response") {
      diagnostics.log("kernel-bridge", {
        message: "Received kernel response.",
        data: e.data,
      });
      const data = e.data;
      const reqId = data.reqId as number;
      const pendingRequest = pendingRequests.get(reqId);
      if (pendingRequest) {
        pendingRequests.delete(reqId);
        if (typeof data.errorMessage === "string") {
          pendingRequest.reject(new WcvmError("ERR_WORKER", data.errorMessage));
        } else {
          pendingRequest.resolve(data.result);
        }
      }
      return;
    }
    emit(e.data);
  };

  worker.onerror = (e: ErrorEvent) => {
    diagnostics.log("kernel-bridge", {
      message: "Kernel worker error.",
      error: e,
    });
    // A worker error is not tied to one request, so fail every pending one.
    const error = new WcvmError(
      "ERR_WORKER",
      `Kernel worker error: ${e.message || "unknown error"}`,
      { cause: e.error },
    );
    for (const pendingRequest of pendingRequests.values()) {
      pendingRequest.reject(error);
    }
    pendingRequests.clear();
  };
};

export { kernelWorkerHandler };

import { KernelMessage } from "../../bridges/models";
import { createState } from "../../protocols/state";
import { bootHandler } from "./handlers/boot";
import { processSpawnHandler } from "./handlers/process";
import { IWorkerState } from "./models";
import { createRouter } from "./router";

const workerStateManager = createState<IWorkerState>({
  kernel: null,
});
const router = createRouter();

const postMessage = (message: KernelMessage) => {
  self.postMessage(message);
};

router.handle("boot", bootHandler);
router.handle("process:spawn", processSpawnHandler);

self.onmessage = (e: MessageEvent<KernelMessage>) => {
  const { type, reqId } = e.data;
  // Only messages sent through `bridge.request()` carry a reqId and get a
  // reply; everything else is fire-and-forget.
  const isRequest = reqId !== undefined;

  router
    .dispatch(type, {
      event: e,
      stateManager: workerStateManager,
      onPostMessage: postMessage,
    })
    .then((result) => {
      if (isRequest) postMessage({ type: "kernel-response", reqId, result });
    })
    .catch((cause: unknown) => {
      const errorMessage =
        cause instanceof Error ? cause.message : String(cause);
      postMessage(
        isRequest
          ? { type: "kernel-response", reqId, errorMessage }
          : { type: "kernel:error", messageType: type, errorMessage },
      );
    });
};

import { KernelMessage } from "../../bridges/models";
import { createState } from "../../protocols/state";
import { bootHandler } from "./handlers/boot";
import { registerFsHandlers } from "./handlers/fs";
import { registerProcessHandlers } from "./handlers/process";
import { toErrorReply } from "./errors";
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
registerProcessHandlers(router);
registerFsHandlers(router);

self.onmessage = (e: MessageEvent<KernelMessage>) => {
  const { type, reqId } = e.data;
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
      postMessage(toErrorReply(type, reqId, cause));
    });
};

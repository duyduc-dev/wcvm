import { WcvmError } from "../../../errors/WcvmError";
import type { IPreviewFetchResult } from "../../../protocols/preview";
import { Router, RouteHandler } from "../router";
import type { IWorkerState } from "../models";
import type { IStateManager } from "../../../protocols/state";

const readyKernel = (stateManager: IStateManager<IWorkerState>) => {
  const { kernel } = stateManager.getState();
  if (!kernel) throw new WcvmError("ERR_WORKER", "Kernel isn't ready");
  return kernel;
};

const previewFetchHandler: RouteHandler = async ({ event, stateManager }): Promise<IPreviewFetchResult> => {
  const kernel = readyKernel(stateManager);
  const data = event.data;
  return kernel.preview.fetch({
    port: data.port as number,
    path: data.path as string,
    method: data.method as string,
    headers: data.headers as [string, string][],
    body: data.body as Uint8Array | null,
  });
};

// The three WebSocket messages are fire-and-forget (the host posts them, never awaits a reply):
// every outcome comes back as a "preview:ws" event instead - see kernel/previewWebSocket.ts.
const previewWsOpenHandler: RouteHandler = ({ event, stateManager }) => {
  const data = event.data;
  readyKernel(stateManager).previewWebSockets.open({
    id: data.id as number,
    port: data.port as number,
    path: data.path as string,
    protocols: data.protocols as string[],
  });
};

const previewWsSendHandler: RouteHandler = ({ event, stateManager }) => {
  readyKernel(stateManager).previewWebSockets.send(event.data.id as number, event.data.data as string | Uint8Array);
};

const previewWsCloseHandler: RouteHandler = ({ event, stateManager }) => {
  const data = event.data;
  readyKernel(stateManager).previewWebSockets.close(data.id as number, data.code as number | undefined, data.reason as string | undefined);
};

const registerPreviewHandlers = (router: Router): void => {
  router.handle("preview:fetch", previewFetchHandler);
  router.handle("preview:wsOpen", previewWsOpenHandler);
  router.handle("preview:wsSend", previewWsSendHandler);
  router.handle("preview:wsClose", previewWsCloseHandler);
};

export { previewFetchHandler, registerPreviewHandlers };

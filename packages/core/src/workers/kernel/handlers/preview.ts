import { WcvmError } from "../../../errors/WcvmError";
import type { IPreviewFetchResult } from "../../../protocols/preview";
import { Router, RouteHandler } from "../router";

const previewFetchHandler: RouteHandler = async ({ event, stateManager }): Promise<IPreviewFetchResult> => {
  const { kernel } = stateManager.getState();
  if (!kernel) throw new WcvmError("ERR_WORKER", "Kernel isn't ready");
  const data = event.data;
  return kernel.preview.fetch({
    port: data.port as number,
    path: data.path as string,
    method: data.method as string,
    headers: data.headers as [string, string][],
    body: data.body as Uint8Array | null,
  });
};

const registerPreviewHandlers = (router: Router): void => {
  router.handle("preview:fetch", previewFetchHandler);
};

export { previewFetchHandler, registerPreviewHandlers };

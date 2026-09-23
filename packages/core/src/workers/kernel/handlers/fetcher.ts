import { WcvmError } from "../../../errors/WcvmError";
import type { IFetchResult } from "../../../kernel/fetcher";
import { Router, RouteHandler } from "../router";

const fetcherFetchHandler: RouteHandler = async ({ event, stateManager }): Promise<IFetchResult> => {
  const { kernel } = stateManager.getState();
  if (!kernel) throw new WcvmError("ERR_WORKER", "Kernel isn't ready");
  const data = event.data;
  return kernel.fetcher.fetch(data.url as string, data.path as string);
};

const registerFetcherHandlers = (router: Router): void => {
  router.handle("fetcher:fetch", fetcherFetchHandler);
};

export { fetcherFetchHandler, registerFetcherHandlers };

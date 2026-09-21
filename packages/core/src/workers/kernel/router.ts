import { KernelMessage } from "../../bridges/models";
import { WcvmError } from "../../errors/WcvmError";
import { IStateManager } from "../../protocols/state";
import { IWorkerState } from "./models";

type HandlerParams = {
  event: MessageEvent<KernelMessage>;
  stateManager: IStateManager<IWorkerState>;
  onPostMessage: (message: KernelMessage) => void;
};
type RouteHandler = (params: HandlerParams) => unknown | Promise<unknown>;

interface Router {
  handle(type: string, handler: RouteHandler): void;
  dispatch(type: string, payload: HandlerParams): Promise<unknown>;
}

const createRouter = (): Router => {
  const handlers = new Map<string, RouteHandler>();

  return {
    handle(type, handler) {
      handlers.set(type, handler);
    },
    async dispatch(type, payload) {
      const handler = handlers.get(type);
      if (!handler) {
        throw new WcvmError(
          "ERR_NOT_IMPLEMENTED",
          `Unknown request type: ${type}`,
        );
      }
      return handler(payload);
    },
  };
};

export { createRouter };
export type { RouteHandler, Router };

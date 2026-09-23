import type { IFetcherWorkerLike } from "../kernel";
import type { FetcherEvent, FetcherRequest, IFetchRequest, IFetcherInit } from "../workers/fetcher/messages";

export interface IFakeFetcherWorker extends IFetcherWorkerLike {
  terminated: boolean;
  inits: IFetcherInit[];
  requests: IFetchRequest[];
  /** Simulates the worker posting an event to the kernel. */
  emit(event: FetcherEvent): void;
  /** Simulates an uncaught error inside the worker. */
  crash(message: string): void;
}

/** Like fakeFsWorker: announces readiness (or failure) right after `init`, once the owner has
 *  had a chance to attach its listeners - a real worker's own "ready" is just as asynchronous. */
export const createFakeFetcherWorker = (options: { fail?: string } = {}): IFakeFetcherWorker => {
  const worker: IFakeFetcherWorker = {
    terminated: false,
    inits: [],
    requests: [],
    onmessage: null,
    onerror: null,
    postMessage: (message: FetcherRequest) => {
      if (message.type === "init") {
        worker.inits.push(message);
        queueMicrotask(() => {
          if (options.fail) worker.onerror?.({ message: options.fail } as ErrorEvent);
          else worker.onmessage?.({ data: { type: "ready" } } as MessageEvent<FetcherEvent>);
        });
      } else {
        worker.requests.push(message);
      }
    },
    terminate() {
      worker.terminated = true;
    },
    emit: (data) => worker.onmessage?.({ data } as MessageEvent<FetcherEvent>),
    crash: (message) => worker.onerror?.({ message } as ErrorEvent),
  };
  return worker;
};

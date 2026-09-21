import type { IProcessWorkerLike } from "../kernel/processes";
import type { IProcessInit, ProcessEvent } from "../workers/process/messages";

export interface IFakeProcessWorker extends IProcessWorkerLike {
  terminated: boolean;
  inits: IProcessInit[];
  /** Simulates the worker posting an event to the kernel. */
  emit(event: ProcessEvent): void;
  /** Simulates an uncaught error inside the worker. */
  crash(message: string): void;
}

export const createFakeProcessWorker = (): IFakeProcessWorker => {
  const worker: IFakeProcessWorker = {
    terminated: false,
    inits: [],
    onmessage: null,
    onerror: null,
    postMessage: (message) => {
      worker.inits.push(message);
    },
    terminate() {
      worker.terminated = true;
    },
    emit: (data) => worker.onmessage?.({ data } as MessageEvent<ProcessEvent>),
    crash: (message) => worker.onerror?.({ message } as ErrorEvent),
  };
  return worker;
};

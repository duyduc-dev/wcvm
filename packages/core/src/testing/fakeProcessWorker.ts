import type { IProcessWorkerLike } from "../kernel/processes";
import type { ChildEvent, IProcessInit, ProcessEvent } from "../workers/process/messages";

export interface IFakeProcessWorker extends IProcessWorkerLike {
  terminated: boolean;
  inits: IProcessInit[];
  /** child:stdout/stderr/exit the kernel posted down, when this worker is acting as a parent. */
  childEvents: ChildEvent[];
  /** Simulates the worker posting an event to the kernel. */
  emit(event: ProcessEvent): void;
  /** Simulates an uncaught error inside the worker. */
  crash(message: string): void;
}

export const createFakeProcessWorker = (): IFakeProcessWorker => {
  const worker: IFakeProcessWorker = {
    terminated: false,
    inits: [],
    childEvents: [],
    onmessage: null,
    onerror: null,
    postMessage: (message) => {
      if (message.type === "init") worker.inits.push(message);
      else worker.childEvents.push(message);
    },
    terminate() {
      worker.terminated = true;
    },
    emit: (data) => worker.onmessage?.({ data } as MessageEvent<ProcessEvent>),
    crash: (message) => worker.onerror?.({ message } as ErrorEvent),
  };
  return worker;
};

import { createKernelHost, IFetcherWorkerLike, IFsWorkerLike, IKernelHost } from "../../../kernel";
import type { IProcessWorkerLike } from "../../../kernel/processes";
import { createFetcherWorker, createFsWorker, createProcessWorker } from "../fsWorker";
import { RouteHandler } from "../router";

interface IBootParams {
  createFsWorker: () => IFsWorkerLike;
  createProcessWorker: () => Promise<(pid: number) => IProcessWorkerLike>;
  createFetcherWorker: () => IFetcherWorkerLike;
}

const createBootHandler =
  ({ createFsWorker, createProcessWorker, createFetcherWorker }: IBootParams): RouteHandler =>
  async ({ event, stateManager, onPostMessage }) => {
    // Boot completes only once the fs worker is running: the kernel's first
    // blocking syscall must not race the worker's startup.
    const kernel: IKernelHost = await createKernelHost({
      createFsWorker,
      createProcessWorker,
      createFetcherWorker,
      emit: onPostMessage,
      persist: event.data.persist as boolean | { root: string } | undefined,
    });
    stateManager.setState({ kernel });
    onPostMessage({ type: "ready" });
  };

const bootHandler = createBootHandler({
  createFsWorker,
  createProcessWorker,
  createFetcherWorker,
});

export { bootHandler, createBootHandler };

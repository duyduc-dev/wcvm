import { createKernelHost, IFsWorkerLike, IKernelHost } from "../../../kernel";
import type { IProcessWorkerLike } from "../../../kernel/processes";
import { createFsWorker, createProcessWorker } from "../fsWorker";
import { RouteHandler } from "../router";

interface IBootParams {
  createFsWorker: () => IFsWorkerLike;
  createProcessWorker: (pid: number) => IProcessWorkerLike;
}

const createBootHandler =
  ({ createFsWorker, createProcessWorker }: IBootParams): RouteHandler =>
  async ({ stateManager, onPostMessage }) => {
    // Boot completes only once the fs worker is running: the kernel's first
    // blocking syscall must not race the worker's startup.
    const kernel: IKernelHost = await createKernelHost({
      createFsWorker,
      createProcessWorker,
      emit: onPostMessage,
    });
    stateManager.setState({ kernel });
    onPostMessage({ type: "ready" });
  };

const bootHandler = createBootHandler({
  createFsWorker,
  createProcessWorker,
});

export { bootHandler, createBootHandler };

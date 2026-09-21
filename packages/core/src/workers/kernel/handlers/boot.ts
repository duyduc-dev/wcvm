import { createKernelHost, IFsWorkerLike, IKernelHost } from "../../../kernel";
import { createFsWorker } from "../fsWorker";
import { RouteHandler } from "../router";

interface IBootParams {
  createFsWorker: () => IFsWorkerLike;
}

const createBootHandler =
  ({ createFsWorker }: IBootParams): RouteHandler =>
  async ({ stateManager, onPostMessage }) => {
    // Boot completes only once the fs worker is running: the kernel's first
    // blocking syscall must not race the worker's startup.
    const kernel: IKernelHost = await createKernelHost({ createFsWorker });
    stateManager.setState({ kernel });
    onPostMessage({ type: "ready" });
  };

const bootHandler = createBootHandler({ createFsWorker });

export { bootHandler, createBootHandler };

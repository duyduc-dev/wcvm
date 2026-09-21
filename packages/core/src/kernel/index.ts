import { createFsClient, IFsClient } from "../fs/fsClient";
import { WcvmError } from "../errors/WcvmError";
import {
  createSyscallBuffer,
  createSyscallClient,
  makeViews,
} from "../protocols/syscall";
import type { FsWorkerMessage } from "../workers/fs/handler";

/** The subset of `Worker` the kernel needs, so tests can substitute one. */
export interface IFsWorkerLike {
  postMessage(message: FsWorkerMessage): void;
  terminate(): void;
  onmessage: ((event: MessageEvent) => void) | null;
  onerror: ((event: ErrorEvent) => void) | null;
}

export interface IKernelHost {
  /** Blocking fs access; only call from the kernel worker thread. */
  fs: IFsClient;
  dispose(): void;
}

interface IKernelHostParams {
  createFsWorker: () => IFsWorkerLike;
}

const KERNEL_FS_CLIENT_ID = 0;

const createKernelHost = async ({
  createFsWorker,
}: IKernelHostParams): Promise<IKernelHost> => {
  const fsWorker = createFsWorker();

  await new Promise<void>((resolve, reject) => {
    fsWorker.onmessage = (event) => {
      if (event.data?.type === "ready") resolve();
    };
    fsWorker.onerror = (event) => {
      reject(
        new WcvmError(
          "ERR_WORKER",
          `File system worker error: ${event.message || "unknown error"}`,
        ),
      );
    };
  });

  const sab = createSyscallBuffer();
  fsWorker.postMessage({ type: "register", clientId: KERNEL_FS_CLIENT_ID, sab });

  const fs = createFsClient(
    createSyscallClient({
      ...makeViews(sab),
      notify: () =>
        fsWorker.postMessage({ type: "doorbell", clientId: KERNEL_FS_CLIENT_ID }),
    }),
  );

  return {
    fs,
    dispose: () => fsWorker.terminate(),
  };
};

export { createKernelHost };

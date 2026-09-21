import type { KernelMessage } from "../bridges/models";
import { createFsClient, IFsClient } from "../fs/fsClient";
import { WcvmError } from "../errors/WcvmError";
import {
  createSyscallBuffer,
  createSyscallClient,
  makeViews,
} from "../protocols/syscall";
import type { FsWorkerMessage } from "../workers/fs/handler";
import {
  createProcessTable,
  IProcessTable,
  IProcessWorkerLike,
} from "./processes";

/** The subset of `Worker` the kernel needs, so tests can substitute one. */
export interface IFsWorkerLike {
  postMessage(message: FsWorkerMessage, transfer?: Transferable[]): void;
  terminate(): void;
  onmessage: ((event: MessageEvent) => void) | null;
  onerror: ((event: ErrorEvent) => void) | null;
}

export interface IKernelHost {
  /** Blocking fs access; only call from the kernel worker thread. */
  fs: IFsClient;
  processes: IProcessTable;
  dispose(): void;
}

interface IKernelHostParams {
  createFsWorker: () => IFsWorkerLike;
  createProcessWorker: (pid: number) => IProcessWorkerLike;
  /** Sends events (`process:stdout`, `process:exit`, ...) to the host. */
  emit: (message: KernelMessage) => void;
}

const KERNEL_FS_CLIENT_ID = 0;

const createKernelHost = async ({
  createFsWorker,
  createProcessWorker,
  emit,
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

  const processes = createProcessTable({
    createProcessWorker,
    emit,
    attachFsClient: (clientId) => {
      const buffer = createSyscallBuffer();
      const { port1, port2 } = new MessageChannel();
      fsWorker.postMessage(
        { type: "register", clientId, sab: buffer, port: port1 },
        [port1],
      );
      return { sab: buffer, port: port2 };
    },
    detachFsClient: (clientId) =>
      fsWorker.postMessage({ type: "unregister", clientId }),
  });

  return {
    fs,
    processes,
    dispose: () => fsWorker.terminate(),
  };
};

export { createKernelHost };

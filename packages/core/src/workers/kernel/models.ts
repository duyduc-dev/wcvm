import { IKernelHost } from "../../kernel";

interface IWorkerState {
  kernel: IKernelHost | null;
}

export type { IWorkerState };

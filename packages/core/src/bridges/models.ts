export interface KernelMessage {
  type: string;
  [key: string]: unknown;
}

export interface IPendingRequest {
  resolve: (result: unknown) => void;
  reject: (reason?: unknown) => void;
}

export type Handler = (m: KernelMessage) => void;

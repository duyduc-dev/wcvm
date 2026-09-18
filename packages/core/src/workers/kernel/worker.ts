import { createKernelHost } from "../../kernel";
import { processSpawn } from "./process";

interface KernelMessage {
  type: string;
  [key: string]: unknown;
}

const kernel = createKernelHost();

const postMessage = (message: KernelMessage) => {
  self.postMessage(message);
};

self.onmessage = (e: MessageEvent<KernelMessage>) => {
  const data = e.data;

  if (data.type === "process-spawn") {
    processSpawn(
      kernel,
      data.processId as number,
      data.command as string,
      data.args as string[],
      data.cwd as string | undefined,
      data.env as Record<string, string> | undefined,
    );
  }
};

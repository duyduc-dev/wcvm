import { createFsClient } from "../../fs/fsClient";
import { createSyscallClient, makeViews } from "../../protocols/syscall";
import { createFetcherRuntime } from "./fetcherRuntime";
import type { FetcherEvent, FetcherRequest } from "./messages";

const post = (event: FetcherEvent) => self.postMessage(event);

let runtime: ReturnType<typeof createFetcherRuntime> | undefined;

self.onmessage = (event: MessageEvent<FetcherRequest>) => {
  const data = event.data;
  if (data.type === "init") {
    const fs = createFsClient(
      createSyscallClient({
        ...makeViews(data.sab),
        notify: () => data.port.postMessage(null),
      }),
    );
    runtime = createFetcherRuntime({ fs, post });
    post({ type: "ready" });
    return;
  }
  runtime?.enqueue(data);
};

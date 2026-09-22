import { FsServer } from "../../fs/FsServer";
import type { FsWatchEvent } from "./handler";
import { createFsWorkerHandler, FsWorkerMessage } from "./handler";

const server = new FsServer(undefined, (clientId, watchId, eventType, filename) => {
  self.postMessage({ type: "watchEvent", clientId, watchId, eventType, filename } satisfies FsWatchEvent);
});
const handle = createFsWorkerHandler(server);

self.onmessage = (e: MessageEvent<FsWorkerMessage>) => handle(e.data);

// The kernel must not issue a blocking syscall before this worker is running:
// a parent parked on Atomics.wait can starve a nested worker's startup.
self.postMessage({ type: "ready" });

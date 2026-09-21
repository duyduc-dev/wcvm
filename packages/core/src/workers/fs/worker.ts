import { FsServer } from "../../fs/FsServer";
import { createFsWorkerHandler, FsWorkerMessage } from "./handler";

const handle = createFsWorkerHandler(new FsServer());

self.onmessage = (e: MessageEvent<FsWorkerMessage>) => handle(e.data);

// The kernel must not issue a blocking syscall before this worker is running:
// a parent parked on Atomics.wait can starve a nested worker's startup.
self.postMessage({ type: "ready" });

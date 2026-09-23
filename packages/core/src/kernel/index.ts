import type { KernelMessage } from "../bridges/models";
import { createFsClient, IFsClient } from "../fs/fsClient";
import { WcvmError } from "../errors/WcvmError";
import {
  createSyscallBuffer,
  createSyscallClient,
  makeViews,
} from "../protocols/syscall";
import type { FsWatchEvent, FsWorkerMessage } from "../workers/fs/handler";
import { createNetServer } from "./netServer";
import { createPreviewRelay, PREVIEW_PID, type IPreviewRelay } from "./previewRelay";
import {
  createProcessTable,
  IProcessTable,
  IProcessWorkerLike,
} from "./processes";
import { createSpawnSyncServer } from "./spawnSyncServer";

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
  preview: IPreviewRelay;
  dispose(): void;
}

interface IKernelHostParams {
  createFsWorker: () => IFsWorkerLike;
  createProcessWorker: (pid: number) => IProcessWorkerLike;
  /** Sends events (`process:stdout`, `process:exit`, ...) to the host. */
  emit: (message: KernelMessage) => void;
}

const KERNEL_FS_CLIENT_ID = 0;

// Pids for execSync/spawnSync's synchronously-spawned children: a plain counter, chosen well
// out of range of both host-assigned top-level pids (small) and async child_process pids
// (`ownPid * 1_000_000 + counter`, bindings/childProcess.ts) - `workers.has(pid)` in
// processes.ts would catch a collision regardless.
const SYNC_PID_START = 3_000_000_000;

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

  // Reassigned once the fs worker is up: the only unprompted (non-ready, non-syscall-response)
  // message it ever sends is a watch event, to be routed to whichever process registered that
  // watch. `processes` isn't assigned until below - fine, this only ever runs later, once some
  // process's fs.watch/watchFile actually fires (see kernel/processes.ts's notifyWatch).
  fsWorker.onmessage = (event) => {
    const data = event.data as FsWatchEvent;
    if (data?.type === "watchEvent") processes.notifyWatch(data.clientId, data.watchId, data.eventType, data.filename);
  };

  const sab = createSyscallBuffer();
  fsWorker.postMessage({ type: "register", clientId: KERNEL_FS_CLIENT_ID, sab });

  const fs = createFsClient(
    createSyscallClient({
      ...makeViews(sab),
      notify: () =>
        fsWorker.postMessage({ type: "doorbell", clientId: KERNEL_FS_CLIENT_ID }),
    }),
  );

  let nextSyncPid = SYNC_PID_START;
  const spawnSyncServer = createSpawnSyncServer({
    // `processes` is defined just below, in the same closure - only ever called later,
    // once a real spawn request comes in, by which point it's fully initialized.
    processes: {
      spawn: (spec) => processes.spawn(spec),
      writeStdin: (pid, chunk) => processes.writeStdin(pid, chunk),
      endStdin: (pid) => processes.endStdin(pid),
      writeIpc: (pid, chunk) => processes.writeIpc(pid, chunk),
      endIpc: (pid) => processes.endIpc(pid),
      notifyWatch: (pid, watchId, eventType, filename) => processes.notifyWatch(pid, watchId, eventType, filename),
      notifyNet: (pid, event) => processes.notifyNet(pid, event),
      kill: (pid, signal) => processes.kill(pid, signal),
      has: (pid) => processes.has(pid),
      get size() {
        return processes.size;
      },
    },
    allocatePid: () => nextSyncPid++,
  });

  // `processes` isn't assigned until below either - same forward-reference trick as
  // spawnSyncServer above: `notify` is only ever called later, once a real net.Server.listen()
  // elsewhere accepts a connection or some data/close event actually fires. PREVIEW_PID is never
  // a real process (see previewRelay.ts) - its own events go to `previewRelay` directly instead
  // of a postMessage to a worker that doesn't exist.
  const netServer = createNetServer({
    notify: (pid, event) => (pid === PREVIEW_PID ? preview.onNetEvent(event) : processes.notifyNet(pid, event)),
    // PREVIEW_PID's own outgoing relay connections never call listen(), so this is always a real
    // guest server - the host's only way to learn a virtual port came up or went away without
    // polling (e.g. to point a preview iframe at it).
    onListenChange: ({ pid, port, listening }) => emit({ type: listening ? "net:listen" : "net:unlisten", pid, port }),
  });

  // Same forward-reference trick again: `preview` is only actually called once the host page
  // relays a real fetch() (kernel/../workers/kernel/handlers/preview.ts), well after this line.
  const preview = createPreviewRelay({
    connect: (ticket, port) => netServer.connect(PREVIEW_PID, ticket, port),
    writeData: (connId, chunk) => netServer.data(PREVIEW_PID, connId, chunk),
    close: (connId) => netServer.close(PREVIEW_PID, connId),
  });

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
    attachSyncClient: (clientId) => {
      const buffer = createSyscallBuffer();
      const { port1, port2 } = new MessageChannel();
      spawnSyncServer.registerClient(clientId, buffer);
      port1.onmessage = () => spawnSyncServer.service(clientId);
      return { sab: buffer, port: port2 };
    },
    detachSyncClient: (clientId) => spawnSyncServer.unregisterClient(clientId),
    attachNetClient: (clientId) => {
      const buffer = createSyscallBuffer();
      const { port1, port2 } = new MessageChannel();
      netServer.registerClient(clientId, buffer);
      port1.onmessage = () => netServer.service(clientId);
      return { sab: buffer, port: port2 };
    },
    detachNetClient: (clientId) => netServer.unregisterClient(clientId),
    netRelay: {
      unlisten: (pid, port) => netServer.unlisten(pid, port),
      connect: (fromPid, ticket, port) => netServer.connect(fromPid, ticket, port),
      data: (fromPid, connId, chunk) => netServer.data(fromPid, connId, chunk),
      shutdown: (fromPid, connId) => netServer.shutdown(fromPid, connId),
      close: (fromPid, connId) => netServer.close(fromPid, connId),
      releasePid: (pid) => netServer.releasePid(pid),
    },
  });

  return {
    fs,
    processes,
    preview,
    dispose: () => fsWorker.terminate(),
  };
};

export { createKernelHost };

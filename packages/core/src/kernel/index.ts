import type { KernelMessage } from "../bridges/models";
import { createFsClient, IFsClient } from "../fs/fsClient";
import { WcvmError } from "../errors/WcvmError";
import {
  createSyscallBuffer,
  createSyscallClient,
  makeViews,
} from "../protocols/syscall";
import type { FsWatchEvent, FsWorkerMessage, IFsWorkerBoot } from "../workers/fs/handler";
import type { FetcherEvent, FetcherRequest } from "../workers/fetcher/messages";
import { createFetcher, type IFetcher } from "./fetcher";
import { createNetServer } from "./netServer";
import { createPreviewRelay, PREVIEW_PID, type IPreviewRelay } from "./previewRelay";
import {
  createProcessTable,
  IProcessTable,
  IProcessWorkerLike,
} from "./processes";
import { createKernelSyncServer } from "./kernelSyncServer";

/** The subset of `Worker` the kernel needs, so tests can substitute one. */
export interface IFsWorkerLike {
  postMessage(message: FsWorkerMessage | IFsWorkerBoot, transfer?: Transferable[]): void;
  terminate(): void;
  onmessage: ((event: MessageEvent) => void) | null;
  onerror: ((event: ErrorEvent) => void) | null;
}

/** The subset of `Worker` the kernel needs for the Fetcher Worker, so tests can substitute one. */
export interface IFetcherWorkerLike {
  postMessage(message: FetcherRequest, transfer?: Transferable[]): void;
  terminate(): void;
  onmessage: ((event: MessageEvent) => void) | null;
  onerror: ((event: ErrorEvent) => void) | null;
}

export interface IKernelHost {
  /** Blocking fs access; only call from the kernel worker thread. */
  fs: IFsClient;
  processes: IProcessTable;
  preview: IPreviewRelay;
  fetcher: IFetcher;
  dispose(): void;
}

interface IKernelHostParams {
  createFsWorker: () => IFsWorkerLike;
  createProcessWorker: (pid: number) => IProcessWorkerLike;
  createFetcherWorker: () => IFetcherWorkerLike;
  /** Sends events (`process:stdout`, `process:exit`, ...) to the host. */
  emit: (message: KernelMessage) => void;
  /** OPFS persistence (fs/opfsPersistence.ts): omitted/false for a purely in-memory Vfs (the
   *  default), true for the default root name, or an explicit one - see DEFAULT_PERSIST_ROOT.
   *  Must be decided at boot: restoring happens before the fs worker ever serves a syscall. */
  persist?: boolean | { root: string };
}

const KERNEL_FS_CLIENT_ID = 0;

const DEFAULT_PERSIST_ROOT = "wcvm";

// Never a real pid or the kernel's own client id (see PREVIEW_PID's own comment for the same
// idea) - the Fetcher Worker isn't a process either, just another persistent worker with its own
// fs client, like the kernel's own KERNEL_FS_CLIENT_ID above.
const FETCHER_FS_CLIENT_ID = -1;

// Pids for execSync/spawnSync's synchronously-spawned children: a plain counter, chosen well
// out of range of both host-assigned top-level pids (small) and async child_process pids
// (`ownPid * 1_000_000 + counter`, bindings/childProcess.ts) - `workers.has(pid)` in
// processes.ts would catch a collision regardless.
const SYNC_PID_START = 3_000_000_000;

const createKernelHost = async ({
  createFsWorker,
  createProcessWorker,
  createFetcherWorker,
  emit,
  persist,
}: IKernelHostParams): Promise<IKernelHost> => {
  const fsWorker = createFsWorker();

  // Listeners attached BEFORE posting "boot" (which is what makes the fs worker actually restore
  // from OPFS, if asked, and then reply "ready") - same ordering the fetcher worker's own boot
  // handshake already gets right.
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
    fsWorker.postMessage({
      type: "boot",
      persist: persist ? { root: typeof persist === "object" ? persist.root : DEFAULT_PERSIST_ROOT } : false,
    });
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

  // Shared by every fs client the kernel hands out - a real process's own (below, via
  // createProcessTable's own param) and the Fetcher Worker's (right after this).
  const attachFsClient = (clientId: number): { sab: SharedArrayBuffer; port: MessagePort } => {
    const buffer = createSyscallBuffer();
    const { port1, port2 } = new MessageChannel();
    fsWorker.postMessage({ type: "register", clientId, sab: buffer, port: port1 }, [port1]);
    return { sab: buffer, port: port2 };
  };

  // Same "await ready before this thread ever parks on its SAB" rule as the fs worker above -
  // boot must not race the Fetcher Worker's own startup either. Listeners are attached BEFORE
  // posting "init" (which is what actually makes the worker reply "ready"), same ordering the fs
  // worker's own boot above already gets right.
  const fetcherWorker = createFetcherWorker();
  const fetcherClient = attachFsClient(FETCHER_FS_CLIENT_ID);
  const fetcher = createFetcher({ postMessage: (message) => fetcherWorker.postMessage(message) });
  await new Promise<void>((resolve, reject) => {
    fetcherWorker.onmessage = (event) => {
      const data = event.data as FetcherEvent;
      if (data?.type === "ready") resolve();
    };
    fetcherWorker.onerror = (event) => {
      reject(new WcvmError("ERR_WORKER", `Fetcher worker error: ${event.message || "unknown error"}`));
    };
    fetcherWorker.postMessage({ type: "init", sab: fetcherClient.sab, port: fetcherClient.port }, [fetcherClient.port]);
  });
  fetcherWorker.onmessage = (event) => fetcher.dispatch(event.data as FetcherEvent);

  let nextSyncPid = SYNC_PID_START;
  const kernelSyncServer = createKernelSyncServer({
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
  // kernelSyncServer above: `notify` is only ever called later, once a real net.Server.listen()
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
    attachFsClient,
    detachFsClient: (clientId) =>
      fsWorker.postMessage({ type: "unregister", clientId }),
    attachSyncClient: (clientId) => {
      const buffer = createSyscallBuffer();
      const { port1, port2 } = new MessageChannel();
      kernelSyncServer.registerClient(clientId, buffer);
      port1.onmessage = () => kernelSyncServer.service(clientId);
      return { sab: buffer, port: port2 };
    },
    detachSyncClient: (clientId) => kernelSyncServer.unregisterClient(clientId),
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
    fetcher,
    dispose: () => {
      fsWorker.terminate();
      fetcherWorker.terminate();
    },
  };
};

export { createKernelHost };

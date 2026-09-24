import { createFsClient } from "../../fs/fsClient";
import { createSyscallClient, makeViews } from "../../protocols/syscall";
import type { ChildProcessEvent, IChildProcessHost, IForkIpcHost } from "../../runtime/bindings/childProcess";
import type { IFsWatchHost } from "../../runtime/bindings/fs";
import type { INetHost, NetEvent } from "../../runtime/bindings/net";
import type { IUdpHost, UdpEvent } from "../../runtime/bindings/udp";
import type { IWorkerThreadHost, WorkerThreadEvent } from "../../runtime/bindings/worker";
import type { IStdinHost } from "../../runtime/runtime";
import { ChildEvent, IProcessInit, ProcessEvent } from "./messages";
import { runProcess } from "./run";
import { runWorkerThread } from "./runWorkerThread";

// self's ambient type (lib.dom, no "webworker" lib configured) only offers Window's own 3-arg
// postMessage(message, targetOrigin, transfer?) overload - cast to the worker-global shape to
// reach the real 2-arg postMessage(message, transfer?) this scope actually has at runtime.
const workerSelf = self as unknown as { postMessage(message: unknown, transfer: Transferable[]): void };
const post = (event: ProcessEvent, transfer?: Transferable[]) => workerSelf.postMessage(event, transfer ?? []);

// Set once the runtime's process_wrap/pipe_wrap binding registers itself
// (see childProcess.ts's ChildRouter); child:* messages arrive only after init.
let onChildEvent: ((event: ChildProcessEvent) => void) | null = null;

const childProcess: IChildProcessHost = {
  spawn: (childPid, command, args, cwd, env, ipc) => post({ type: "child:spawn", childPid, command, args, cwd, env, ipc }),
  kill: (childPid, signal) => post({ type: "child:kill", childPid, signal }),
  writeStdin: (childPid, chunk) => post({ type: "child:stdin", childPid, chunk }),
  endStdin: (childPid) => post({ type: "child:stdinEnd", childPid }),
  writeIpc: (childPid, chunk) => post({ type: "child:ipc", childPid, chunk }),
  endIpc: (childPid) => post({ type: "child:ipcEnd", childPid }),
  onEvent: (handler) => {
    onChildEvent = handler;
  },
};

// This process's own stdin can arrive before the runtime has registered a
// handler (e.g. the kernel forwards it while `node` is still bootstrapping);
// buffer until someone's listening, same idea as childProcess.ts's Pipe queue.
//
// onData only ever keeps the ONE most recently registered handler - a program `sh`'s REPL runs
// in-process (cat, node, a nested sh) registers its own handler on this SAME IStdinHost and
// steals it. Once that program exits, sh's own lineReader must re-register to get further input
// (programs/sh/sh.ts's runReplSh calls its ILineReader's reattach() after every line for this).
// `stdinEnded` makes that safe even if EOF arrived while the nested program owned it: without
// this, a handler that (re-)registers after the real EOF already fired once would just wait
// forever for input that will never come.
let onStdinData: ((chunk: Uint8Array | null) => void) | null = null;
const pendingStdin: Array<Uint8Array | null> = [];
let stdinEnded = false;

const stdin: IStdinHost = {
  onData: (handler) => {
    onStdinData = handler;
    for (const chunk of pendingStdin) handler(chunk);
    pendingStdin.length = 0;
    if (stdinEnded) handler(null);
  },
};

const deliverStdin = (chunk: Uint8Array | null) => {
  if (chunk === null) stdinEnded = true;
  if (onStdinData) onStdinData(chunk);
  else pendingStdin.push(chunk);
};

// This process's own fork() IPC channel, if it was spawned with one (see start()'s `init.ipc`).
// Mirrors stdin's own buffer-until-registered pattern - the kernel may deliver an incoming ipc
// chunk before the runtime has finished bootstrapping setupChannel.
let onIpcData: ((chunk: Uint8Array | null) => void) | null = null;
const pendingIpc: Array<Uint8Array | null> = [];

const ipc: IForkIpcHost = {
  send: (chunk) => post({ type: "ipcOut", chunk }),
  end: () => post({ type: "ipcOutEnd" }),
  onData: (handler) => {
    onIpcData = handler;
    for (const chunk of pendingIpc) handler(chunk);
    pendingIpc.length = 0;
  },
};

const deliverIpc = (chunk: Uint8Array | null) => {
  if (onIpcData) onIpcData(chunk);
  else pendingIpc.push(chunk);
};

// One handler total, like childProcess's onEvent: the fs_event_wrap binding (runtime/bindings/fs.ts)
// dispatches to individual FSEvent instances itself, by watchId, once it has this.
let onWatchEvent: ((event: { watchId: number; eventType: "rename" | "change"; filename: string }) => void) | null = null;

const fsWatch: IFsWatchHost = {
  onEvent: (handler) => {
    onWatchEvent = handler;
  },
};

// One handler total, like fsWatch's own - runtime/bindings/net.ts dispatches to individual TCP
// instances itself, by connId (or ticket, for a connect() still in flight).
let onNetEvent: ((event: NetEvent) => void) | null = null;

const net: INetHost = {
  unlisten: (port) => post({ type: "net:unlisten", port }),
  connect: (ticket, port) => post({ type: "net:connect", ticket, port }),
  writeData: (connId, chunk) => post({ type: "net:data", connId, chunk }),
  shutdown: (connId) => post({ type: "net:shutdown", connId }),
  close: (connId) => post({ type: "net:close", connId }),
  onEvent: (handler) => {
    onNetEvent = handler;
  },
};

// One handler total, like net's own - runtime/bindings/udp.ts dispatches to individual UDP
// instances itself, by port.
let onUdpEvent: ((event: UdpEvent) => void) | null = null;

const udp: IUdpHost = {
  unbind: (port) => post({ type: "udp:unbind", port }),
  send: (fromPort, toPort, chunk) => post({ type: "udp:send", fromPort, toPort, chunk }),
  onEvent: (handler) => {
    onUdpEvent = handler;
  },
};

// One handler total, like net's/udp's own - runtime/bindings/worker.ts dispatches to individual
// WorkerHandle instances itself, by ticket (still pending) or childPid (already started).
// `workerThreadChildPids` is this file's own bookkeeping, not the binding's: a "started" reply
// and a plain child:exit both arrive as ordinary kernel events keyed by childPid, indistinguishable
// from a real child_process's own without tracking which childPids ARE worker threads - net/udp
// don't need this because their own event types are already distinct from child:*.
let onWorkerThreadEvent: ((event: { type: "started"; ticket: number; childPid: number; threadId: number } | WorkerThreadEvent) => void) | null = null;
const workerThreadChildPids = new Set<number>();

const workerThread: IWorkerThreadHost = {
  // spec.port is a real MessagePort - transferable only, not structurally cloneable - so it MUST
  // be listed in postMessage's own transfer list, or the browser throws a DataCloneError right
  // here (synchronously, inside WorkerHandle.startThread(), which real vendored internal/worker.js
  // calls synchronously at the very end of `new Worker(...)`'s own constructor). Confirmed in real
  // Chromium: this exact miss surfaced as an uncaught exception inside the newly spawned worker
  // thread's own... no - inside THIS (parent) process worker, which the kernel worker's own
  // onerror listener doesn't preventDefault() on, so it kept bubbling: parent process worker ->
  // kernel worker -> main page, arriving as a bare "null" pageerror three layers removed from
  // where it actually happened.
  spawn: (ticket, spec) => post({ type: "workerThread:spawn", ticket, ...spec }, [spec.port]),
  kill: (childPid) => post({ type: "child:kill", childPid }),
  onEvent: (handler) => {
    onWorkerThreadEvent = handler;
  },
};

const start = async (init: IProcessInit) => {
  // See IProcessInit.threadIdCounterSab's own comment: threadId must be mintable synchronously,
  // with no kernel round trip - a plain Atomics.add on a SharedArrayBuffer every process shares.
  const threadIdCounterView = new Uint32Array(init.threadIdCounterSab);
  const mintThreadId = () => Atomics.add(threadIdCounterView, 0, 1);

  const fs = createFsClient(
    createSyscallClient({
      ...makeViews(init.sab),
      notify: () => init.fsPort.postMessage(null),
    }),
  );
  const spawnSync = createSyscallClient({
    ...makeViews(init.syncSab),
    notify: () => init.syncPort.postMessage(null),
  });
  const netSync = createSyscallClient({
    ...makeViews(init.netSab),
    notify: () => init.netPort.postMessage(null),
  });

  let code: number;
  try {
    code = init.workerThread
      ? await runWorkerThread({
          pid: init.pid,
          cwd: init.cwd,
          env: init.env,
          fs,
          workerThread: init.workerThread,
          globalObject: self as unknown as Record<string, any>,
          write: (stream, chunk) => post({ type: stream, chunk }),
          childProcess,
          spawnSync,
          fsWatch,
          net,
          netSync,
          udp,
          workerThreadHost: workerThread,
          mintThreadId,
        })
      : await runProcess({
          command: init.command,
          args: init.args,
          cwd: init.cwd,
          env: init.env,
          fs,
          pid: init.pid,
          globalObject: self as unknown as Record<string, any>,
          write: (stream, chunk) => post({ type: stream, chunk }),
          sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
          childProcess,
          stdin,
          spawnSync,
          ipc: init.ipc ? ipc : undefined,
          fsWatch,
          net,
          netSync,
          udp,
          workerThread,
          mintThreadId,
        });
  } catch (error) {
    post({
      type: "stderr",
      chunk: new TextEncoder().encode(
        `wcvm: ${error instanceof Error ? error.message : String(error)}\n`,
      ),
    });
    code = 1;
  }
  post({ type: "exit", code });
};

self.onmessage = (event: MessageEvent<IProcessInit | ChildEvent>) => {
  const data = event.data;
  switch (data.type) {
    case "init":
      void start(data);
      break;
    case "stdin":
      deliverStdin(data.chunk);
      break;
    case "stdinEnd":
      deliverStdin(null);
      break;
    case "ipc":
      deliverIpc(data.chunk);
      break;
    case "ipcEnd":
      deliverIpc(null);
      break;
    case "child:stdout":
    case "child:stderr": {
      const stream = data.type === "child:stdout" ? "stdout" : "stderr";
      // A worker_threads.Worker's own stdout/stderr (like child:exit above) isn't a real
      // child_process ChildRouter would recognize - it has no fd/pipe of its own here (stdio
      // piping via options.stdout/options.stderr isn't implemented - see bindings/worker.ts's
      // file header), so its output just flows straight through as if it were this process's
      // own, the simplest behavior that's still actually visible anywhere instead of silently
      // dropped (confirmed missing in real Chromium: a worker thread's own console.log output
      // never reached anywhere at all before this fix, making failures inside one undebuggable).
      if (workerThreadChildPids.has(data.childPid)) post({ type: stream, chunk: data.chunk });
      else onChildEvent?.({ type: "data", childPid: data.childPid, stream, chunk: data.chunk });
      break;
    }
    case "child:ipcOut":
      onChildEvent?.({ type: "data", childPid: data.childPid, stream: "ipc", chunk: data.chunk });
      break;
    case "child:ipcOutEnd":
      onChildEvent?.({ type: "ipcDisconnect", childPid: data.childPid });
      break;
    case "child:exit":
      // A worker_threads.Worker's own child:exit (kernel/processes.ts's finalize() reports it
      // exactly like any other child, real childProcess.ts never sees them at all) routes to
      // WorkerRouter instead of ChildRouter - see workerThreadChildPids above.
      if (workerThreadChildPids.has(data.childPid)) {
        workerThreadChildPids.delete(data.childPid);
        onWorkerThreadEvent?.({ type: "exit", childPid: data.childPid, code: data.exitCode });
      } else {
        onChildEvent?.({ type: "exit", childPid: data.childPid, exitCode: data.exitCode, signal: data.signal });
      }
      break;
    case "workerThread:started":
      workerThreadChildPids.add(data.childPid);
      onWorkerThreadEvent?.({ type: "started", ticket: data.ticket, childPid: data.childPid, threadId: data.threadId });
      break;
    case "watchEvent":
      onWatchEvent?.({ watchId: data.watchId, eventType: data.eventType, filename: data.filename });
      break;
    case "net:connectResult":
      onNetEvent?.(
        data.ok
          ? { type: "connectResult", ticket: data.ticket, ok: true, connId: data.connId }
          : { type: "connectResult", ticket: data.ticket, ok: false, code: data.code },
      );
      break;
    case "net:incoming":
      onNetEvent?.({ type: "incoming", connId: data.connId, port: data.port });
      break;
    case "net:data":
      onNetEvent?.({ type: "data", connId: data.connId, chunk: data.chunk });
      break;
    case "net:eof":
      onNetEvent?.({ type: "eof", connId: data.connId });
      break;
    case "net:close":
      onNetEvent?.({ type: "close", connId: data.connId });
      break;
    case "udp:message":
      onUdpEvent?.({ type: "message", port: data.port, fromPort: data.fromPort, chunk: data.chunk });
      break;
  }
};

import { createFsClient } from "../../fs/fsClient";
import { createSyscallClient, makeViews } from "../../protocols/syscall";
import type { ChildProcessEvent, IChildProcessHost, IForkIpcHost } from "../../runtime/bindings/childProcess";
import type { IStdinHost } from "../../runtime/runtime";
import { ChildEvent, IProcessInit, ProcessEvent } from "./messages";
import { runProcess } from "./run";

const post = (event: ProcessEvent) => self.postMessage(event);

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

const start = async (init: IProcessInit) => {
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

  let code: number;
  try {
    code = await runProcess({
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
    case "child:stderr":
      onChildEvent?.({ type: "data", childPid: data.childPid, stream: data.type === "child:stdout" ? "stdout" : "stderr", chunk: data.chunk });
      break;
    case "child:ipcOut":
      onChildEvent?.({ type: "data", childPid: data.childPid, stream: "ipc", chunk: data.chunk });
      break;
    case "child:ipcOutEnd":
      onChildEvent?.({ type: "ipcDisconnect", childPid: data.childPid });
      break;
    case "child:exit":
      onChildEvent?.({ type: "exit", childPid: data.childPid, exitCode: data.exitCode, signal: data.signal });
      break;
  }
};

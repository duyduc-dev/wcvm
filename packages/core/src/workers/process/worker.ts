import { createFsClient } from "../../fs/fsClient";
import { createSyscallClient, makeViews } from "../../protocols/syscall";
import type { ChildProcessEvent, IChildProcessHost } from "../../runtime/bindings/childProcess";
import type { IStdinHost } from "../../runtime/runtime";
import { ChildEvent, IProcessInit, ProcessEvent } from "./messages";
import { runProcess } from "./run";

const post = (event: ProcessEvent) => self.postMessage(event);

// Set once the runtime's process_wrap/pipe_wrap binding registers itself
// (see childProcess.ts's ChildRouter); child:* messages arrive only after init.
let onChildEvent: ((event: ChildProcessEvent) => void) | null = null;

const childProcess: IChildProcessHost = {
  spawn: (childPid, command, args, cwd, env) => post({ type: "child:spawn", childPid, command, args, cwd, env }),
  kill: (childPid, signal) => post({ type: "child:kill", childPid, signal }),
  writeStdin: (childPid, chunk) => post({ type: "child:stdin", childPid, chunk }),
  endStdin: (childPid) => post({ type: "child:stdinEnd", childPid }),
  onEvent: (handler) => {
    onChildEvent = handler;
  },
};

// This process's own stdin can arrive before the runtime has registered a
// handler (e.g. the kernel forwards it while `node` is still bootstrapping);
// buffer until someone's listening, same idea as childProcess.ts's Pipe queue.
let onStdinData: ((chunk: Uint8Array | null) => void) | null = null;
const pendingStdin: Array<Uint8Array | null> = [];

const stdin: IStdinHost = {
  onData: (handler) => {
    onStdinData = handler;
    for (const chunk of pendingStdin) handler(chunk);
    pendingStdin.length = 0;
  },
};

const deliverStdin = (chunk: Uint8Array | null) => {
  if (onStdinData) onStdinData(chunk);
  else pendingStdin.push(chunk);
};

const start = async (init: IProcessInit) => {
  const fs = createFsClient(
    createSyscallClient({
      ...makeViews(init.sab),
      notify: () => init.fsPort.postMessage(null),
    }),
  );

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
    case "child:stdout":
    case "child:stderr":
      onChildEvent?.({ type: "data", childPid: data.childPid, stream: data.type === "child:stdout" ? "stdout" : "stderr", chunk: data.chunk });
      break;
    case "child:exit":
      onChildEvent?.({ type: "exit", childPid: data.childPid, exitCode: data.exitCode, signal: data.signal });
      break;
  }
};

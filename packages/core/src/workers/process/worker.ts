import { createFsClient } from "../../fs/fsClient";
import { createSyscallClient, makeViews } from "../../protocols/syscall";
import type { ChildProcessEvent, IChildProcessHost } from "../../runtime/bindings/childProcess";
import { ChildEvent, IProcessInit, ProcessEvent } from "./messages";
import { runProcess } from "./run";

const post = (event: ProcessEvent) => self.postMessage(event);

// Set once the runtime's process_wrap/pipe_wrap binding registers itself
// (see childProcess.ts's ChildRouter); child:* messages arrive only after init.
let onChildEvent: ((event: ChildProcessEvent) => void) | null = null;

const childProcess: IChildProcessHost = {
  spawn: (childPid, command, args, cwd, env) => post({ type: "child:spawn", childPid, command, args, cwd, env }),
  kill: (childPid, signal) => post({ type: "child:kill", childPid, signal }),
  onEvent: (handler) => {
    onChildEvent = handler;
  },
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
  if (data.type === "init") {
    void start(data);
    return;
  }
  if (data.type === "child:stdout" || data.type === "child:stderr") {
    onChildEvent?.({ type: "data", childPid: data.childPid, stream: data.type === "child:stdout" ? "stdout" : "stderr", chunk: data.chunk });
  } else if (data.type === "child:exit") {
    onChildEvent?.({ type: "exit", childPid: data.childPid, exitCode: data.exitCode, signal: data.signal });
  }
};

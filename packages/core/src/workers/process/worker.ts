import { createFsClient } from "../../fs/fsClient";
import { createSyscallClient, makeViews } from "../../protocols/syscall";
import { IProcessInit, ProcessEvent } from "./messages";
import { runProcess } from "./run";

const post = (event: ProcessEvent) => self.postMessage(event);

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
      write: (stream, chunk) => post({ type: stream, chunk }),
      sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
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

self.onmessage = (event: MessageEvent<IProcessInit>) => {
  if (event.data?.type === "init") void start(event.data);
};

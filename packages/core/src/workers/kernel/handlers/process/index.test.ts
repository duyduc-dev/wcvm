import { describe, expect, it, vi } from "vitest";
import { IKernelHost } from "../../../../kernel";
import { createState } from "../../../../protocols/state";
import { IWorkerState } from "../../models";
import { createRouter } from "../../router";
import { registerProcessHandlers } from ".";

const setup = (ready = true) => {
  const processes = { spawn: vi.fn(), kill: vi.fn() };
  const stateManager = createState<IWorkerState>({
    kernel: ready ? ({ processes } as unknown as IKernelHost) : null,
  });
  const posted: unknown[] = [];
  const router = createRouter();
  registerProcessHandlers(router);
  const send = (type: string, data: Record<string, unknown>) =>
    router.dispatch(type, {
      event: { data: { type, ...data } } as MessageEvent,
      stateManager,
      onPostMessage: (m) => posted.push(m),
    });
  return { send, processes, posted };
};

describe("process handlers", () => {
  it("spawn passes the spec to the kernel's process table", async () => {
    const { send, processes } = setup();
    await send("process:spawn", {
      processId: 2,
      command: "echo",
      args: ["a"],
      cwd: "/w",
      env: { X: "1" },
    });
    expect(processes.spawn).toHaveBeenCalledWith({
      processId: 2,
      command: "echo",
      args: ["a"],
      cwd: "/w",
      env: { X: "1" },
    });
  });

  it("kill passes the pid and signal", async () => {
    const { send, processes } = setup();
    await send("process:kill", { processId: 2, signal: "SIGKILL" });
    expect(processes.kill).toHaveBeenCalledWith(2, "SIGKILL");
  });

  it("before the kernel is ready, spawn reports the failure as the process's exit", async () => {
    const { send, posted } = setup(false);
    await send("process:spawn", { processId: 5, command: "x", args: [] });
    expect(posted).toEqual([
      {
        type: "process:exit",
        processId: 5,
        errorCode: 1,
        errorMessage: "Kernel isn't ready",
      },
    ]);
  });

  it("before the kernel is ready, kill is rejected", async () => {
    await expect(setup(false).send("process:kill", { processId: 1 })).rejects.toMatchObject(
      { type: "ERR_WORKER" },
    );
  });
});

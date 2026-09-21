import { beforeEach, describe, expect, it, vi } from "vitest";
import { IFakeProcessWorker, createFakeProcessWorker } from "../testing/fakeProcessWorker";
import { createProcessTable } from "./processes";

const setup = () => {
  const workers: IFakeProcessWorker[] = [];
  const events: Array<Record<string, unknown>> = [];
  const attach = vi.fn((id: number) => ({
    sab: new SharedArrayBuffer(8),
    port: { id } as unknown as MessagePort,
  }));
  const detach = vi.fn();
  const table = createProcessTable({
    createProcessWorker: () => {
      const worker = createFakeProcessWorker();
      workers.push(worker);
      return worker;
    },
    attachFsClient: attach,
    detachFsClient: detach,
    emit: (m) => events.push(m),
  });
  return { table, workers, events, attach, detach };
};

let t: ReturnType<typeof setup>;
beforeEach(() => {
  t = setup();
});

describe("process table", () => {
  it("starts a worker, hands it its buffer, doorbell and merged environment", () => {
    t.table.spawn({
      processId: 7,
      command: "echo",
      args: ["hi"],
      cwd: "/w",
      env: { FOO: "bar", PATH: "/custom" },
    });

    expect(t.table.has(7)).toBe(true);
    const [init] = t.workers[0].inits;
    expect(init).toMatchObject({
      type: "init",
      pid: 7,
      command: "echo",
      args: ["hi"],
      cwd: "/w",
      env: { PATH: "/custom", HOME: "/home/user", PWD: "/w", FOO: "bar" },
    });
    expect(init.sab).toBeInstanceOf(SharedArrayBuffer);
    expect(t.attach).toHaveBeenCalledWith(7);
  });

  it("defaults cwd to the root", () => {
    t.table.spawn({ processId: 1, command: "pwd", args: [] });
    expect(t.workers[0].inits[0].cwd).toBe("/");
    expect(t.workers[0].inits[0].env.PWD).toBe("/");
  });

  it("forwards output and, on exit, tears down exactly once", () => {
    t.table.spawn({ processId: 1, command: "x", args: [] });
    const [worker] = t.workers;
    const chunk = new Uint8Array([1]);

    worker.emit({ type: "stdout", chunk });
    worker.emit({ type: "stderr", chunk });
    expect(t.events).toEqual([
      { type: "process:stdout", processId: 1, chunk },
      { type: "process:stderr", processId: 1, chunk },
    ]);

    const onmessage = worker.onmessage!;
    worker.emit({ type: "exit", code: 3 });
    expect(t.events.at(-1)).toEqual({
      type: "process:exit",
      processId: 1,
      exitCode: 3,
    });
    expect(worker.terminated).toBe(true);
    expect(t.detach).toHaveBeenCalledWith(1);
    expect(t.table.has(1)).toBe(false);
    expect(t.table.size).toBe(0);

    // A late message from the dying worker must not produce a second exit.
    onmessage({ data: { type: "exit", code: 9 } } as MessageEvent);
    expect(t.events.filter((e) => e.type === "process:exit")).toHaveLength(1);
  });

  it("kill reports 143 for SIGTERM and 137 for SIGKILL, with the signal", () => {
    t.table.spawn({ processId: 1, command: "sleep", args: ["9"] });
    t.table.spawn({ processId: 2, command: "sleep", args: ["9"] });
    t.table.kill(1);
    t.table.kill(2, "SIGKILL");

    const exits = t.events.filter((e) => e.type === "process:exit");
    expect(exits).toEqual([
      { type: "process:exit", processId: 1, exitCode: 143, signal: "SIGTERM" },
      { type: "process:exit", processId: 2, exitCode: 137, signal: "SIGKILL" },
    ]);
    expect(t.workers.every((w) => w.terminated)).toBe(true);
  });

  it("treats an unknown signal name as SIGTERM", () => {
    t.table.spawn({ processId: 1, command: "x", args: [] });
    t.table.kill(1, "SIGWHATEVER");
    expect(t.events.at(-1)).toMatchObject({ exitCode: 143, signal: "SIGTERM" });
  });

  it("kill on an unknown or already-exited process does nothing", () => {
    t.table.kill(99);
    t.table.spawn({ processId: 1, command: "x", args: [] });
    t.workers[0].emit({ type: "exit", code: 0 });
    t.table.kill(1);
    expect(t.events.filter((e) => e.type === "process:exit")).toHaveLength(1);
  });

  it("a worker crash becomes exit 1 with the reason, and cleans up", () => {
    t.table.spawn({ processId: 1, command: "x", args: [] });
    t.workers[0].crash("out of memory");
    expect(t.events.at(-1)).toEqual({
      type: "process:exit",
      processId: 1,
      exitCode: 1,
      errorMessage: "Process worker error: out of memory",
    });
    expect(t.detach).toHaveBeenCalledWith(1);
    expect(t.table.size).toBe(0);
  });

  it("rejects a duplicate pid without disturbing the running process", () => {
    t.table.spawn({ processId: 1, command: "x", args: [] });
    t.table.spawn({ processId: 1, command: "y", args: [] });
    expect(t.events).toEqual([
      {
        type: "process:exit",
        processId: 1,
        exitCode: 1,
        errorMessage: "Process 1 already exists",
      },
    ]);
    expect(t.table.has(1)).toBe(true);
    expect(t.workers).toHaveLength(1);
  });

  it("reports a failure to start as exit 1 and leaves no entry behind", () => {
    const events: Array<Record<string, unknown>> = [];
    const table = createProcessTable({
      createProcessWorker: () => {
        throw new Error("no workers left");
      },
      attachFsClient: t.attach,
      detachFsClient: t.detach,
      emit: (m) => events.push(m),
    });
    table.spawn({ processId: 1, command: "x", args: [] });
    expect(events).toEqual([
      {
        type: "process:exit",
        processId: 1,
        exitCode: 1,
        errorMessage: "Failed to start process: no workers left",
      },
    ]);
    expect(table.size).toBe(0);
  });

  it("keeps processes independent", () => {
    t.table.spawn({ processId: 1, command: "x", args: [] });
    t.table.spawn({ processId: 2, command: "y", args: [] });
    t.workers[0].emit({ type: "exit", code: 0 });
    expect(t.table.has(1)).toBe(false);
    expect(t.table.has(2)).toBe(true);
    expect(t.workers[1].terminated).toBe(false);
  });
});

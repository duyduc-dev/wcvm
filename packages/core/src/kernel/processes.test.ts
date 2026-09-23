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
  const attachSync = vi.fn((id: number) => ({
    sab: new SharedArrayBuffer(8),
    port: { id } as unknown as MessagePort,
  }));
  const detachSync = vi.fn();
  const attachNet = vi.fn((id: number) => ({
    sab: new SharedArrayBuffer(8),
    port: { id } as unknown as MessagePort,
  }));
  const detachNet = vi.fn();
  const netRelay = { unlisten: vi.fn(), connect: vi.fn(), data: vi.fn(), shutdown: vi.fn(), close: vi.fn(), releasePid: vi.fn() };
  const udpRelay = { unbind: vi.fn(), send: vi.fn(), releasePid: vi.fn() };
  const table = createProcessTable({
    createProcessWorker: () => {
      const worker = createFakeProcessWorker();
      workers.push(worker);
      return worker;
    },
    attachFsClient: attach,
    detachFsClient: detach,
    attachSyncClient: attachSync,
    detachSyncClient: detachSync,
    attachNetClient: attachNet,
    detachNetClient: detachNet,
    netRelay,
    udpRelay,
    emit: (m) => events.push(m),
  });
  return { table, workers, events, attach, detach, attachSync, detachSync, attachNet, detachNet, netRelay, udpRelay };
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
      attachSyncClient: t.attachSync,
      detachSyncClient: t.detachSync,
      attachNetClient: t.attachNet,
      detachNetClient: t.detachNet,
      netRelay: t.netRelay,
      udpRelay: t.udpRelay,
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

describe("child_process routing", () => {
  it("a child:spawn message starts a real process and never reaches the host", () => {
    t.table.spawn({ processId: 1, command: "node", args: [] });
    t.workers[0].emit({ type: "child:spawn", childPid: 1_000_001, command: "echo", args: ["hi"], cwd: "/w", env: { FOO: "bar" } });

    expect(t.table.has(1_000_001)).toBe(true);
    expect(t.workers).toHaveLength(2);
    expect(t.workers[1].inits[0]).toMatchObject({ command: "echo", args: ["hi"], cwd: "/w" });
    expect(t.events).toEqual([]);
  });

  it("routes a child's stdout/stderr/exit to its parent worker, not the host", () => {
    t.table.spawn({ processId: 1, command: "node", args: [] });
    t.workers[0].emit({ type: "child:spawn", childPid: 1_000_001, command: "echo", args: ["hi"] });
    const chunk = new Uint8Array([1]);

    t.workers[1].emit({ type: "stdout", chunk });
    t.workers[1].emit({ type: "stderr", chunk });
    t.workers[1].emit({ type: "exit", code: 0 });

    expect(t.workers[0].childEvents).toEqual([
      { type: "child:stdout", childPid: 1_000_001, chunk },
      { type: "child:stderr", childPid: 1_000_001, chunk },
      { type: "child:exit", childPid: 1_000_001, exitCode: 0 },
    ]);
    expect(t.events).toEqual([]);
    expect(t.table.has(1_000_001)).toBe(false);
  });

  it("a child:kill message kills only that child, reporting the signal to the parent", () => {
    t.table.spawn({ processId: 1, command: "node", args: [] });
    t.workers[0].emit({ type: "child:spawn", childPid: 1_000_001, command: "sleep", args: ["9"] });
    t.workers[0].emit({ type: "child:kill", childPid: 1_000_001, signal: "SIGKILL" });

    expect(t.workers[0].childEvents.at(-1)).toEqual({
      type: "child:exit",
      childPid: 1_000_001,
      exitCode: 137,
      signal: "SIGKILL",
    });
    expect(t.workers[1].terminated).toBe(true);
    expect(t.table.has(1)).toBe(true);
  });

  it("a top-level process's own stdout/exit still go to the host, unaffected by child routing", () => {
    t.table.spawn({ processId: 1, command: "node", args: [] });
    const chunk = new Uint8Array([9]);
    t.workers[0].emit({ type: "stdout", chunk });
    t.workers[0].emit({ type: "exit", code: 0 });

    expect(t.events).toEqual([
      { type: "process:stdout", processId: 1, chunk },
      { type: "process:exit", processId: 1, exitCode: 0 },
    ]);
  });

  it("a child:stdin message from a parent worker delivers to its child's own worker", () => {
    t.table.spawn({ processId: 1, command: "node", args: [] });
    t.workers[0].emit({ type: "child:spawn", childPid: 1_000_001, command: "cat", args: [] });
    const chunk = new Uint8Array([7]);

    t.workers[0].emit({ type: "child:stdin", childPid: 1_000_001, chunk });
    t.workers[0].emit({ type: "child:stdinEnd", childPid: 1_000_001 });

    expect(t.workers[1].childEvents).toEqual([{ type: "stdin", chunk }, { type: "stdinEnd" }]);
  });

  it("a child:spawn with ipc:true is passed through to the child's own init", () => {
    t.table.spawn({ processId: 1, command: "node", args: [] });
    t.workers[0].emit({ type: "child:spawn", childPid: 1_000_001, command: "node", args: ["/child.js"], ipc: true });

    expect(t.workers[1].inits[0]).toMatchObject({ ipc: true });
  });

  it("a child:spawn with no ipc flag defaults the child's init to ipc: false", () => {
    t.table.spawn({ processId: 1, command: "node", args: [] });
    t.workers[0].emit({ type: "child:spawn", childPid: 1_000_001, command: "echo", args: [] });

    expect(t.workers[1].inits[0]).toMatchObject({ ipc: false });
  });

  it("a child:ipc/child:ipcEnd message from a parent worker delivers to its child's own worker", () => {
    t.table.spawn({ processId: 1, command: "node", args: [] });
    t.workers[0].emit({ type: "child:spawn", childPid: 1_000_001, command: "node", args: ["/child.js"], ipc: true });
    const chunk = new Uint8Array([9]);

    t.workers[0].emit({ type: "child:ipc", childPid: 1_000_001, chunk });
    t.workers[0].emit({ type: "child:ipcEnd", childPid: 1_000_001 });

    expect(t.workers[1].childEvents).toEqual([{ type: "ipc", chunk }, { type: "ipcEnd" }]);
  });

  it("a child's own ipcOut/ipcOutEnd relay to its parent worker as child:ipcOut/child:ipcOutEnd", () => {
    t.table.spawn({ processId: 1, command: "node", args: [] });
    t.workers[0].emit({ type: "child:spawn", childPid: 1_000_001, command: "node", args: ["/child.js"], ipc: true });
    const chunk = new Uint8Array([3]);

    t.workers[1].emit({ type: "ipcOut", chunk });
    t.workers[1].emit({ type: "ipcOutEnd" });

    expect(t.workers[0].childEvents).toEqual([
      { type: "child:ipcOut", childPid: 1_000_001, chunk },
      { type: "child:ipcOutEnd", childPid: 1_000_001 },
    ]);
  });

  it("a top-level process's own ipcOut has no parent to relay to, and is silently dropped", () => {
    t.table.spawn({ processId: 1, command: "node", args: [] });
    expect(() => t.workers[0].emit({ type: "ipcOut", chunk: new Uint8Array([1]) })).not.toThrow();
    expect(t.events).toEqual([]);
  });
});

describe("ipc", () => {
  it("writeIpc/endIpc deliver ipc/ipcEnd straight to that process's worker", () => {
    t.table.spawn({ processId: 1, command: "node", args: ["/child.js"], ipc: true });
    const chunk = new Uint8Array([1, 2, 3]);

    t.table.writeIpc(1, chunk);
    t.table.endIpc(1);

    expect(t.workers[0].childEvents).toEqual([{ type: "ipc", chunk }, { type: "ipcEnd" }]);
  });

  it("writeIpc/endIpc on an unknown or already-exited pid does nothing", () => {
    expect(() => t.table.writeIpc(99, new Uint8Array())).not.toThrow();
    expect(() => t.table.endIpc(99)).not.toThrow();
  });
});

describe("stdin", () => {
  it("writeStdin/endStdin deliver stdin/stdinEnd straight to that process's worker", () => {
    t.table.spawn({ processId: 1, command: "node", args: [] });
    const chunk = new Uint8Array([1, 2, 3]);

    t.table.writeStdin(1, chunk);
    t.table.endStdin(1);

    expect(t.workers[0].childEvents).toEqual([{ type: "stdin", chunk }, { type: "stdinEnd" }]);
  });

  it("writeStdin/endStdin on an unknown or already-exited pid does nothing", () => {
    expect(() => t.table.writeStdin(99, new Uint8Array())).not.toThrow();
    expect(() => t.table.endStdin(99)).not.toThrow();

    t.table.spawn({ processId: 1, command: "x", args: [] });
    t.workers[0].emit({ type: "exit", code: 0 });
    expect(() => t.table.writeStdin(1, new Uint8Array())).not.toThrow();
  });
});

describe("subtree kill", () => {
  it("killing a parent also kills its child_process children, silently", () => {
    t.table.spawn({ processId: 1, command: "node", args: [] });
    t.workers[0].emit({ type: "child:spawn", childPid: 1_000_001, command: "sleep", args: ["9"] });
    t.workers[0].emit({ type: "child:spawn", childPid: 1_000_002, command: "sleep", args: ["9"] });

    t.table.kill(1);

    expect(t.workers[0].terminated).toBe(true);
    expect(t.workers[1].terminated).toBe(true);
    expect(t.workers[2].terminated).toBe(true);
    expect(t.table.has(1)).toBe(false);
    expect(t.table.has(1_000_001)).toBe(false);
    expect(t.table.has(1_000_002)).toBe(false);
    // Only the parent's own exit is reported; the cascaded children are silent.
    expect(t.events).toEqual([{ type: "process:exit", processId: 1, exitCode: 143, signal: "SIGTERM" }]);
  });

  it("a natural exit (not just an explicit kill) also cascades", () => {
    t.table.spawn({ processId: 1, command: "node", args: [] });
    t.workers[0].emit({ type: "child:spawn", childPid: 1_000_001, command: "sleep", args: ["9"] });

    t.workers[0].emit({ type: "exit", code: 0 });

    expect(t.workers[1].terminated).toBe(true);
    expect(t.table.has(1_000_001)).toBe(false);
    expect(t.events).toEqual([{ type: "process:exit", processId: 1, exitCode: 0 }]);
  });

  it("cascades through grandchildren too", () => {
    t.table.spawn({ processId: 1, command: "node", args: [] });
    t.workers[0].emit({ type: "child:spawn", childPid: 1_000_001, command: "node", args: [] });
    t.workers[1].emit({ type: "child:spawn", childPid: 1_000_001_000_001, command: "sleep", args: ["9"] });

    t.table.kill(1);

    expect(t.workers.every((w) => w.terminated)).toBe(true);
    expect(t.table.has(1_000_001_000_001)).toBe(false);
  });

  it("killing a child directly leaves its parent and siblings alone", () => {
    t.table.spawn({ processId: 1, command: "node", args: [] });
    t.workers[0].emit({ type: "child:spawn", childPid: 1_000_001, command: "sleep", args: ["9"] });
    t.workers[0].emit({ type: "child:spawn", childPid: 1_000_002, command: "sleep", args: ["9"] });

    t.table.kill(1_000_001);

    expect(t.table.has(1)).toBe(true);
    expect(t.table.has(1_000_002)).toBe(true);
    expect(t.workers[0].terminated).toBe(false);
    expect(t.workers[2].terminated).toBe(false);
    expect(t.workers[0].childEvents).toEqual([{ type: "child:exit", childPid: 1_000_001, exitCode: 143, signal: "SIGTERM" }]);
  });
});

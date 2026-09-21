import { describe, expect, it } from "vitest";
import { createFakeFsWorker } from "../testing/fakeFsWorker";
import { createFakeProcessWorker } from "../testing/fakeProcessWorker";
import { createKernelHost } from ".";

const deps = (worker: ReturnType<typeof createFakeFsWorker>["worker"]) => ({
  createFsWorker: () => worker,
  createProcessWorker: () => createFakeProcessWorker(),
  emit: () => {},
});

describe("kernel host", () => {
  it("waits for the fs worker to be ready, then serves blocking fs calls", async () => {
    const { worker, server } = createFakeFsWorker();
    const kernel = await createKernelHost(deps(worker));

    kernel.fs.mkdir("/a/b", { recursive: true });
    kernel.fs.writeFile("/a/b/f", "hi");
    expect(new TextDecoder().decode(kernel.fs.readFile("/a/b/f"))).toBe("hi");
    expect(server.vfs.exists("/a/b/f")).toBe(true);
  });

  it("surfaces an errno from the fs worker as a code on the thrown error", async () => {
    const { worker } = createFakeFsWorker();
    const kernel = await createKernelHost(deps(worker));
    expect(() => kernel.fs.readFile("/missing")).toThrow(
      expect.objectContaining({ code: "ENOENT" }),
    );
  });

  it("rejects boot when the fs worker fails to start", async () => {
    const { worker } = createFakeFsWorker(undefined, { fail: "no such script" });
    await expect(
      createKernelHost(deps(worker)),
    ).rejects.toMatchObject({
      type: "ERR_WORKER",
      message: expect.stringContaining("no such script"),
    });
  });

  it("terminates the fs worker on dispose", async () => {
    const { worker } = createFakeFsWorker();
    const kernel = await createKernelHost(deps(worker));
    kernel.dispose();
    expect(worker.terminated).toBe(true);
  });

  it("attaches a per-process fs client that the fs worker will service, and detaches it", async () => {
    const { worker } = createFakeFsWorker();
    const processWorker = createFakeProcessWorker();
    const events: unknown[] = [];
    const kernel = await createKernelHost({
      createFsWorker: () => worker,
      createProcessWorker: () => processWorker,
      emit: (m) => events.push(m),
    });

    kernel.processes.spawn({ processId: 4, command: "pwd", args: [] });
    const init = processWorker.inits[0];
    expect(init.sab).toBeInstanceOf(SharedArrayBuffer);
    expect(init.fsPort).toBeDefined();
    expect(kernel.processes.has(4)).toBe(true);

    processWorker.emit({ type: "exit", code: 0 });
    expect(events).toContainEqual({ type: "process:exit", processId: 4, errorCode: 0 });
    init.fsPort.close();
  });
});

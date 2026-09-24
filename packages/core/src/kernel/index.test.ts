import { describe, expect, it } from "vitest";
import { createFakeFetcherWorker } from "../testing/fakeFetcherWorker";
import { createFakeFsWorker } from "../testing/fakeFsWorker";
import { createFakeProcessWorker } from "../testing/fakeProcessWorker";
import { createKernelHost } from ".";

const deps = (worker: ReturnType<typeof createFakeFsWorker>["worker"]) => ({
  createFsWorker: () => worker,
  createProcessWorker: async () => () => createFakeProcessWorker(),
  createFetcherWorker: () => createFakeFetcherWorker(),
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

  it("terminates the fs worker and the fetcher worker on dispose", async () => {
    const { worker } = createFakeFsWorker();
    const fetcherWorker = createFakeFetcherWorker();
    const kernel = await createKernelHost({
      createFsWorker: () => worker,
      createProcessWorker: async () => () => createFakeProcessWorker(),
      createFetcherWorker: () => fetcherWorker,
      emit: () => {},
    });
    kernel.dispose();
    expect(worker.terminated).toBe(true);
    expect(fetcherWorker.terminated).toBe(true);
  });

  it("rejects boot when the fetcher worker fails to start", async () => {
    const { worker } = createFakeFsWorker();
    await expect(
      createKernelHost({
        createFsWorker: () => worker,
        createProcessWorker: async () => () => createFakeProcessWorker(),
        createFetcherWorker: () => createFakeFetcherWorker({ fail: "no such script" }),
        emit: () => {},
      }),
    ).rejects.toMatchObject({
      type: "ERR_WORKER",
      message: expect.stringContaining("no such script"),
    });
  });

  it("registers the Fetcher Worker's own fs client, and routes wc.fs.fetch() through it", async () => {
    const { worker } = createFakeFsWorker();
    const fetcherWorker = createFakeFetcherWorker();
    const kernel = await createKernelHost({
      createFsWorker: () => worker,
      createProcessWorker: async () => () => createFakeProcessWorker(),
      createFetcherWorker: () => fetcherWorker,
      emit: () => {},
    });

    expect(fetcherWorker.inits[0].sab).toBeInstanceOf(SharedArrayBuffer);
    expect(fetcherWorker.inits[0].port).toBeDefined();

    const pending = kernel.fetcher.fetch("https://example.test/a", "/a.txt");
    expect(fetcherWorker.requests).toEqual([{ type: "fetch", id: 1, url: "https://example.test/a", path: "/a.txt" }]);

    fetcherWorker.emit({ type: "fetch:done", id: 1, status: 200, headers: [] });
    await expect(pending).resolves.toEqual({ status: 200, headers: [] });
  });

  it("boots the fs worker with persist: false when no persist option is given", async () => {
    const { worker } = createFakeFsWorker();
    await createKernelHost(deps(worker));
    expect(worker.boots).toEqual([false]);
  });

  it("boots the fs worker with the default persist root when persist: true", async () => {
    const { worker } = createFakeFsWorker();
    await createKernelHost({ ...deps(worker), persist: true });
    expect(worker.boots).toEqual([{ root: "wcvm" }]);
  });

  it("boots the fs worker with an explicit persist root", async () => {
    const { worker } = createFakeFsWorker();
    await createKernelHost({ ...deps(worker), persist: { root: "my-app" } });
    expect(worker.boots).toEqual([{ root: "my-app" }]);
  });

  it("attaches a per-process fs client that the fs worker will service, and detaches it", async () => {
    const { worker } = createFakeFsWorker();
    const processWorker = createFakeProcessWorker();
    const events: unknown[] = [];
    const kernel = await createKernelHost({
      createFsWorker: () => worker,
      createProcessWorker: async () => () => processWorker,
      createFetcherWorker: () => createFakeFetcherWorker(),
      emit: (m) => events.push(m),
    });

    kernel.processes.spawn({ processId: 4, command: "pwd", args: [] });
    const init = processWorker.inits[0];
    expect(init.sab).toBeInstanceOf(SharedArrayBuffer);
    expect(init.fsPort).toBeDefined();
    expect(kernel.processes.has(4)).toBe(true);

    processWorker.emit({ type: "exit", code: 0 });
    expect(events).toContainEqual({ type: "process:exit", processId: 4, exitCode: 0 });
    init.fsPort.close();
  });
});

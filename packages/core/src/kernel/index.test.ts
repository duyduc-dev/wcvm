import { describe, expect, it } from "vitest";
import { createFakeFsWorker } from "../testing/fakeFsWorker";
import { createKernelHost } from ".";

describe("kernel host", () => {
  it("waits for the fs worker to be ready, then serves blocking fs calls", async () => {
    const { worker, server } = createFakeFsWorker();
    const kernel = await createKernelHost({ createFsWorker: () => worker });

    kernel.fs.mkdir("/a/b", { recursive: true });
    kernel.fs.writeFile("/a/b/f", "hi");
    expect(new TextDecoder().decode(kernel.fs.readFile("/a/b/f"))).toBe("hi");
    expect(server.vfs.exists("/a/b/f")).toBe(true);
  });

  it("surfaces an errno from the fs worker as a code on the thrown error", async () => {
    const { worker } = createFakeFsWorker();
    const kernel = await createKernelHost({ createFsWorker: () => worker });
    expect(() => kernel.fs.readFile("/missing")).toThrow(
      expect.objectContaining({ code: "ENOENT" }),
    );
  });

  it("rejects boot when the fs worker fails to start", async () => {
    const { worker } = createFakeFsWorker(undefined, { fail: "no such script" });
    await expect(
      createKernelHost({ createFsWorker: () => worker }),
    ).rejects.toMatchObject({
      type: "ERR_WORKER",
      message: expect.stringContaining("no such script"),
    });
  });

  it("terminates the fs worker on dispose", async () => {
    const { worker } = createFakeFsWorker();
    const kernel = await createKernelHost({ createFsWorker: () => worker });
    kernel.dispose();
    expect(worker.terminated).toBe(true);
  });
});

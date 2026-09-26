import { describe, expect, it, vi } from "vitest";
import { IKernelBridge } from "../bridges/kernel";
import { createFsApi } from "./Fs";

const setup = () => {
  const request = vi.fn(async (_type: string, _data?: unknown) => "result");
  const bridge = { request } as unknown as IKernelBridge;
  let release!: () => void;
  const ready = new Promise<void>((resolve) => (release = resolve));
  return { fs: createFsApi(bridge, ready), request, release };
};

describe("fs api", () => {
  it("holds every call until the kernel is ready", async () => {
    const { fs, request, release } = setup();
    const pending = fs.readFile("/a");
    await Promise.resolve();
    expect(request).not.toHaveBeenCalled();

    release();
    await pending;
    expect(request).toHaveBeenCalledWith("fs:readFile", { path: "/a" });
  });

  it("maps each method onto its kernel request", async () => {
    const { fs, request, release } = setup();
    release();

    await fs.writeFile("/a", "x");
    await fs.mkdir("/d", { recursive: true });
    await fs.mkdir("/e");
    await fs.rm("/d", { recursive: true });
    await fs.rename("/a", "/b");
    await fs.symlink("/b", "/l");
    await fs.mount({ f: { file: { contents: "" } } }, "/m");
    await fs.mount({});
    await fs.reset();
    await fs.fetch("https://example.test/a", "/a.txt");

    expect(request.mock.calls.map(([type]) => type)).toEqual([
      "fs:writeFile",
      "fs:mkdir",
      "fs:mkdir",
      "fs:rm",
      "fs:rename",
      "fs:symlink",
      "fs:mount",
      "fs:mount",
      "fs:reset",
      "fetcher:fetch",
    ]);
    expect(request.mock.calls[1][1]).toEqual({ path: "/d", recursive: true });
    expect(request.mock.calls[2][1]).toEqual({ path: "/e", recursive: false });
    expect(request.mock.calls[7][1]).toEqual({ tree: {}, basePath: "/" });
    expect(request.mock.calls[9][1]).toEqual({ url: "https://example.test/a", path: "/a.txt" });
  });

  it("does not call the kernel if boot failed", async () => {
    const request = vi.fn();
    const ready = Promise.reject(new Error("boot failed"));
    ready.catch(() => {});
    const fs = createFsApi({ request } as unknown as IKernelBridge, ready);
    await expect(fs.readFile("/a")).rejects.toThrow("boot failed");
    expect(request).not.toHaveBeenCalled();
  });
});

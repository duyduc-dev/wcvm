import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Handler } from "./bridges/models";

const listeners = new Map<string, Handler>();
const bridge = {
  boot: vi.fn(),
  request: vi.fn(),
  postMessage: vi.fn(),
  on: vi.fn((type: string, handler: Handler) => {
    listeners.set(type, handler);
    return () => listeners.delete(type);
  }),
};

vi.mock("./bridges/kernel", () => ({ createKernelBridge: () => bridge }));

const isolate = (value: boolean) => {
  vi.stubGlobal("self", { crossOriginIsolated: value });
  vi.stubGlobal("SharedArrayBuffer", SharedArrayBuffer);
};

describe("boot", () => {
  beforeEach(() => {
    listeners.clear();
    bridge.boot.mockClear();
    bridge.postMessage.mockClear();
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it("throws ERR_NOT_ISOLATED on a page that is not cross-origin isolated", async () => {
    isolate(false);
    const { boot } = await import("./boot");
    expect(() => boot()).toThrow(
      expect.objectContaining({ type: "ERR_NOT_ISOLATED" }),
    );
  });

  it("resolves ready when the kernel reports ready", async () => {
    isolate(true);
    const { boot } = await import("./boot");
    const { ready } = boot();
    expect(bridge.boot).toHaveBeenCalledOnce();
    listeners.get("ready")!({ type: "ready" });
    await expect(ready).resolves.toBeUndefined();
  });

  it("rejects ready with ERR_BOOT_TIMEOUT when the kernel never answers", async () => {
    isolate(true);
    const { boot } = await import("./boot");
    const { ready } = boot({ bootTimeoutMs: 50 });
    const assertion = expect(ready).rejects.toMatchObject({
      type: "ERR_BOOT_TIMEOUT",
    });
    await vi.advanceTimersByTimeAsync(50);
    await assertion;
  });

  it("rejects ready with the kernel's reason when boot fails, not a timeout", async () => {
    isolate(true);
    const { boot } = await import("./boot");
    const { ready } = boot();
    listeners.get("kernel:error")!({
      type: "kernel:error",
      messageType: "boot",
      errorMessage: "fs worker exploded",
    });
    await expect(ready).rejects.toMatchObject({
      type: "ERR_WORKER",
      message: expect.stringContaining("fs worker exploded"),
    });
  });

  it("ignores kernel errors for other message types", async () => {
    isolate(true);
    const { boot } = await import("./boot");
    const { ready } = boot();
    listeners.get("kernel:error")!({
      type: "kernel:error",
      messageType: "fs:readFile",
      errorMessage: "unrelated",
    });
    listeners.get("ready")!({ type: "ready" });
    await expect(ready).resolves.toBeUndefined();
  });

  it("exposes an fs api bound to the kernel", async () => {
    isolate(true);
    const { boot } = await import("./boot");
    const { fs } = boot();
    listeners.get("ready")!({ type: "ready" });
    bridge.request.mockResolvedValueOnce(true);
    await expect(fs.exists("/x")).resolves.toBe(true);
    expect(bridge.request).toHaveBeenCalledWith("fs:exists", { path: "/x" });
  });

  it("holds spawn until the kernel is ready, then posts process:spawn", async () => {
    isolate(true);
    const { boot } = await import("./boot");
    const { spawn } = boot();
    const spawned = spawn("echo", ["hi"]);
    await Promise.resolve();
    expect(bridge.postMessage).not.toHaveBeenCalled();

    listeners.get("ready")!({ type: "ready" });
    const proc = await spawned;
    expect(proc.processId).toBe(1);
    expect(bridge.postMessage).toHaveBeenCalledWith(
      "process:spawn",
      expect.objectContaining({ processId: 1, command: "echo", args: ["hi"] }),
    );
  });
});

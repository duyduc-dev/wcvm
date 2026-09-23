import { describe, expect, it, vi } from "vitest";
import { IKernelHost } from "../../../kernel";
import { createState } from "../../../protocols/state";
import { IWorkerState } from "../models";
import { createRouter } from "../router";
import { registerPreviewHandlers } from "./preview";

const setup = (ready = true, fetchImpl = vi.fn()) => {
  const preview = { fetch: fetchImpl, onNetEvent: vi.fn() };
  const stateManager = createState<IWorkerState>({
    kernel: ready ? ({ preview } as unknown as IKernelHost) : null,
  });
  const router = createRouter();
  registerPreviewHandlers(router);
  const send = (data: Record<string, unknown>) =>
    router.dispatch("preview:fetch", {
      event: { data: { type: "preview:fetch", ...data } } as MessageEvent,
      stateManager,
      onPostMessage: () => {},
    });
  return { send, preview };
};

describe("preview handlers", () => {
  it("passes the request through to the kernel's preview relay and returns its result", async () => {
    const result = { status: 200, statusMessage: "OK", headers: [["x", "y"]], body: new Uint8Array([1]) };
    const { send, preview } = setup(true, vi.fn().mockResolvedValue(result));
    const response = await send({
      port: 4000,
      path: "/a?b=1",
      method: "POST",
      headers: [["Content-Type", "text/plain"]],
      body: new Uint8Array([1, 2]),
    });
    expect(preview.fetch).toHaveBeenCalledWith({
      port: 4000,
      path: "/a?b=1",
      method: "POST",
      headers: [["Content-Type", "text/plain"]],
      body: new Uint8Array([1, 2]),
    });
    expect(response).toBe(result);
  });

  it("a rejection from the relay (e.g. ECONNREFUSED) propagates as the request's own rejection", async () => {
    const { send } = setup(true, vi.fn().mockRejectedValue(new Error("ECONNREFUSED")));
    await expect(send({ port: 1, path: "/", method: "GET", headers: [], body: null })).rejects.toThrow("ECONNREFUSED");
  });

  it("before the kernel is ready, it's rejected instead of hanging", async () => {
    const { send } = setup(false);
    await expect(send({ port: 1, path: "/", method: "GET", headers: [], body: null })).rejects.toMatchObject({ type: "ERR_WORKER" });
  });
});

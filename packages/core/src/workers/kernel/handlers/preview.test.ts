import { describe, expect, it, vi } from "vitest";
import { IKernelHost } from "../../../kernel";
import { createState } from "../../../protocols/state";
import { IWorkerState } from "../models";
import { createRouter } from "../router";
import { registerPreviewHandlers } from "./preview";

const setup = (ready = true, fetchImpl = vi.fn()) => {
  const preview = { fetch: fetchImpl, onNetEvent: vi.fn() };
  const previewWebSockets = { open: vi.fn(), send: vi.fn(), close: vi.fn(), onNetEvent: vi.fn() };
  const stateManager = createState<IWorkerState>({
    kernel: ready ? ({ preview, previewWebSockets } as unknown as IKernelHost) : null,
  });
  const router = createRouter();
  registerPreviewHandlers(router);
  const dispatch = (type: string, data: Record<string, unknown>) =>
    router.dispatch(type, {
      event: { data: { type, ...data } } as MessageEvent,
      stateManager,
      onPostMessage: () => {},
    });
  const send = (data: Record<string, unknown>) => dispatch("preview:fetch", data);
  return { send, dispatch, preview, previewWebSockets };
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

  describe("WebSocket tunnel messages", () => {
    it("preview:wsOpen opens a tunnel with the host-minted id", async () => {
      const { dispatch, previewWebSockets } = setup();
      await dispatch("preview:wsOpen", { id: 3, port: 5173, path: "/?token=x", protocols: ["vite-hmr"] });
      expect(previewWebSockets.open).toHaveBeenCalledWith({ id: 3, port: 5173, path: "/?token=x", protocols: ["vite-hmr"] });
    });

    it("preview:wsSend and preview:wsClose reach the matching tunnel", async () => {
      const { dispatch, previewWebSockets } = setup();
      await dispatch("preview:wsSend", { id: 3, data: "hi" });
      await dispatch("preview:wsClose", { id: 3, code: 1000, reason: "bye" });
      expect(previewWebSockets.send).toHaveBeenCalledWith(3, "hi");
      expect(previewWebSockets.close).toHaveBeenCalledWith(3, 1000, "bye");
    });

    it("before the kernel is ready, they're rejected instead of silently dropped", async () => {
      const { dispatch } = setup(false);
      await expect(dispatch("preview:wsOpen", { id: 1, port: 1, path: "/", protocols: [] })).rejects.toMatchObject({ type: "ERR_WORKER" });
    });
  });
});

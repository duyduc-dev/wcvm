import { describe, expect, it, vi } from "vitest";
import { IKernelHost } from "../../../kernel";
import { createState } from "../../../protocols/state";
import { IWorkerState } from "../models";
import { createRouter } from "../router";
import { registerFetcherHandlers } from "./fetcher";

const setup = (ready = true, fetchImpl = vi.fn()) => {
  const fetcher = { fetch: fetchImpl, dispatch: vi.fn() };
  const stateManager = createState<IWorkerState>({
    kernel: ready ? ({ fetcher } as unknown as IKernelHost) : null,
  });
  const router = createRouter();
  registerFetcherHandlers(router);
  const send = (data: Record<string, unknown>) =>
    router.dispatch("fetcher:fetch", {
      event: { data: { type: "fetcher:fetch", ...data } } as MessageEvent,
      stateManager,
      onPostMessage: () => {},
    });
  return { send, fetcher };
};

describe("fetcher handlers", () => {
  it("passes the request through to the kernel's fetcher and returns its result", async () => {
    const result = { status: 200, headers: [["content-type", "text/plain"]] as [string, string][] };
    const { send, fetcher } = setup(true, vi.fn().mockResolvedValue(result));
    const response = await send({ url: "https://example.test/a", path: "/a.txt" });
    expect(fetcher.fetch).toHaveBeenCalledWith("https://example.test/a", "/a.txt");
    expect(response).toBe(result);
  });

  it("a rejection from the fetcher propagates as the request's own rejection", async () => {
    const { send } = setup(true, vi.fn().mockRejectedValue(Object.assign(new Error("fetch failed: 404 Not Found"), { code: "EHTTP404" })));
    await expect(send({ url: "https://example.test/missing", path: "/m.txt" })).rejects.toThrow("fetch failed: 404 Not Found");
  });

  it("before the kernel is ready, it's rejected instead of hanging", async () => {
    const { send } = setup(false);
    await expect(send({ url: "https://example.test/a", path: "/a.txt" })).rejects.toMatchObject({ type: "ERR_WORKER" });
  });
});

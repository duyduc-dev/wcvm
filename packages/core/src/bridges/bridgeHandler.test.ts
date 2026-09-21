import { describe, expect, it, vi } from "vitest";
import { createDiagnostics } from "../protocols/diagnostics";
import { kernelWorkerHandler } from "./bridgeHandler";
import { Handler, IPendingRequest } from "./models";

const setup = () => {
  const worker = {} as Worker;
  const pendingRequests = new Map<number, IPendingRequest>();
  const handlers = new Map<string, Set<Handler>>();
  kernelWorkerHandler({
    worker,
    diagnostics: createDiagnostics(),
    pendingRequests,
    handlers,
  });
  const receive = (data: unknown) =>
    worker.onmessage!({ data } as MessageEvent);
  return { worker, pendingRequests, handlers, receive };
};

const pending = () => {
  const resolve = vi.fn<IPendingRequest["resolve"]>();
  const reject = vi.fn<IPendingRequest["reject"]>();
  return { resolve, reject };
};

describe("kernel bridge handler", () => {
  it("resolves a pending request from a kernel-response", () => {
    const { pendingRequests, receive } = setup();
    const p = pending();
    pendingRequests.set(1, p);
    receive({ type: "kernel-response", reqId: 1, result: "ok" });
    expect(p.resolve).toHaveBeenCalledWith("ok");
    expect(pendingRequests.has(1)).toBe(false);
  });

  it("rejects with ERR_WORKER when the response carries an errorMessage", () => {
    const { pendingRequests, receive } = setup();
    const p = pending();
    pendingRequests.set(2, p);
    receive({ type: "kernel-response", reqId: 2, errorMessage: "boom" });
    expect(p.reject).toHaveBeenCalledWith(
      expect.objectContaining({ type: "ERR_WORKER", message: "boom" }),
    );
  });

  it("ignores responses for unknown request ids", () => {
    const { receive } = setup();
    expect(() =>
      receive({ type: "kernel-response", reqId: 99, result: 1 }),
    ).not.toThrow();
  });

  it("emits non-response messages to subscribers of that type", () => {
    const { handlers, receive } = setup();
    const a = vi.fn();
    const b = vi.fn();
    handlers.set("process:exit", new Set([a]));
    handlers.set("other", new Set([b]));
    receive({ type: "process:exit", processId: 1 });
    expect(a).toHaveBeenCalledOnce();
    expect(b).not.toHaveBeenCalled();
  });

  it("fails every pending request on a worker error", () => {
    const { worker, pendingRequests } = setup();
    const p1 = pending();
    const p2 = pending();
    pendingRequests.set(1, p1);
    pendingRequests.set(2, p2);
    worker.onerror!({ message: "died" } as ErrorEvent);
    expect(p1.reject).toHaveBeenCalledWith(
      expect.objectContaining({ type: "ERR_WORKER" }),
    );
    expect(p2.reject).toHaveBeenCalledOnce();
    expect(pendingRequests.size).toBe(0);
  });
});

import { describe, expect, it, vi } from "vitest";
import { createRouter } from "./router";

const params = {} as Parameters<ReturnType<typeof createRouter>["dispatch"]>[1];

describe("kernel router", () => {
  it("dispatches to the registered handler and returns its result", async () => {
    const router = createRouter();
    const handler = vi.fn(() => 42);
    router.handle("x", handler);
    await expect(router.dispatch("x", params)).resolves.toBe(42);
    expect(handler).toHaveBeenCalledWith(params);
  });

  it("rejects unknown types with ERR_NOT_IMPLEMENTED", async () => {
    await expect(createRouter().dispatch("nope", params)).rejects.toMatchObject(
      { name: "WcvmError", type: "ERR_NOT_IMPLEMENTED" },
    );
  });

  it("surfaces a throwing sync handler as a rejection", async () => {
    const router = createRouter();
    router.handle("boom", () => {
      throw new Error("bad");
    });
    await expect(router.dispatch("boom", params)).rejects.toThrow("bad");
  });
});

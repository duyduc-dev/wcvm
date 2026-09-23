import { describe, expect, it, vi } from "vitest";
import type { IKernelBridge } from "../bridges/kernel";
import type { Handler, KernelMessage } from "../bridges/models";
import { createPreviewApi } from "./Preview";

/** A fake kernelBridge with just enough of `on()` to drive onListen: real handler storage and
 *  dispatch, so unsubscribing actually stops future events (unlike a bare vi.fn() would catch). */
const createFakeKernelBridge = (): { bridge: IKernelBridge; emit: (m: KernelMessage) => void } => {
  const handlers = new Map<string, Set<Handler>>();
  const emit = (m: KernelMessage) => {
    for (const h of handlers.get(m.type) ?? []) h(m);
  };
  const bridge: IKernelBridge = {
    boot: vi.fn(),
    request: vi.fn(),
    postMessage: vi.fn(),
    on: (type, handler) => {
      let set = handlers.get(type);
      if (!set) handlers.set(type, (set = new Set()));
      set.add(handler);
      return () => set!.delete(handler);
    },
  };
  return { bridge, emit };
};

describe("createPreviewApi", () => {
  describe("url", () => {
    it("builds a preview URL for a port, defaulting the path to /", () => {
      const { bridge } = createFakeKernelBridge();
      const preview = createPreviewApi(bridge);
      expect(preview.url(3000)).toBe("/__wcvm_preview__/3000/");
    });

    it("preserves an explicit path, adding a leading slash if missing", () => {
      const { bridge } = createFakeKernelBridge();
      const preview = createPreviewApi(bridge);
      expect(preview.url(3000, "/api/x")).toBe("/__wcvm_preview__/3000/api/x");
      expect(preview.url(3000, "api/x")).toBe("/__wcvm_preview__/3000/api/x");
    });
  });

  describe("onListen", () => {
    it("reports listening:true for a net:listen event and listening:false for net:unlisten", () => {
      const { bridge, emit } = createFakeKernelBridge();
      const preview = createPreviewApi(bridge);
      const seen: Array<{ port: number; listening: boolean }> = [];
      preview.onListen((info) => seen.push(info));

      emit({ type: "net:listen", pid: 1, port: 3000 });
      emit({ type: "net:unlisten", pid: 1, port: 3000 });

      expect(seen).toEqual([
        { port: 3000, listening: true },
        { port: 3000, listening: false },
      ]);
    });

    it("stops delivering events once unsubscribed", () => {
      const { bridge, emit } = createFakeKernelBridge();
      const preview = createPreviewApi(bridge);
      const seen: Array<{ port: number; listening: boolean }> = [];
      const off = preview.onListen((info) => seen.push(info));

      off();
      emit({ type: "net:listen", pid: 1, port: 3000 });

      expect(seen).toEqual([]);
    });

    it("supports more than one independent subscriber", () => {
      const { bridge, emit } = createFakeKernelBridge();
      const preview = createPreviewApi(bridge);
      const a: unknown[] = [];
      const b: unknown[] = [];
      preview.onListen((info) => a.push(info));
      preview.onListen((info) => b.push(info));

      emit({ type: "net:listen", pid: 1, port: 3000 });

      expect(a).toHaveLength(1);
      expect(b).toHaveLength(1);
    });
  });
});

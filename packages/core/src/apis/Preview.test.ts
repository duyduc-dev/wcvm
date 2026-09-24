import { describe, expect, it, vi } from "vitest";
import type { IKernelBridge } from "../bridges/kernel";
import type { Handler, KernelMessage } from "../bridges/models";
import { createPreviewApi, createPreviewWebSocketRelay } from "./Preview";

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

  describe("WebSocket relay", () => {
    const ORIGIN = "http://localhost:4173";

    /** What the page's shim does: a request message carrying one end of a fresh MessageChannel. */
    const shimRequest = (data: unknown, origin = ORIGIN) => {
      const channel = new MessageChannel();
      const event = { data, origin, ports: [channel.port2] } as unknown as MessageEvent;
      const received: unknown[] = [];
      channel.port1.onmessage = (e) => received.push(e.data);
      return { event, page: channel.port1, received };
    };

    const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

    const setupRelay = () => {
      const { bridge, emit } = createFakeKernelBridge();
      const relay = createPreviewWebSocketRelay(bridge);
      return { relay, emit, posted: bridge.postMessage as ReturnType<typeof vi.fn> };
    };

    it("a same-origin shim request opens a kernel tunnel under a freshly minted id", () => {
      const { relay, posted } = setupRelay();
      const a = shimRequest({ type: "wcvm:previewWebSocket", port: 5173, path: "/?token=t", protocols: ["vite-hmr"] });
      const b = shimRequest({ type: "wcvm:previewWebSocket", port: 3000, path: "/ws", protocols: [] });
      relay.handleMessage(a.event, ORIGIN);
      relay.handleMessage(b.event, ORIGIN);
      expect(posted.mock.calls).toEqual([
        ["preview:wsOpen", { id: 1, port: 5173, path: "/?token=t", protocols: ["vite-hmr"] }],
        ["preview:wsOpen", { id: 2, port: 3000, path: "/ws", protocols: [] }],
      ]);
      a.page.close();
      b.page.close();
    });

    it("ignores a request from another origin, a foreign message, or one with no port", () => {
      const { relay, posted } = setupRelay();
      const request = { type: "wcvm:previewWebSocket", port: 1, path: "/", protocols: [] };
      const foreign = shimRequest(request, "http://evil.example");
      relay.handleMessage(foreign.event, ORIGIN);
      const other = shimRequest({ type: "something-else" });
      relay.handleMessage(other.event, ORIGIN);
      relay.handleMessage({ data: request, origin: ORIGIN, ports: [] } as unknown as MessageEvent, ORIGIN);
      expect(posted).not.toHaveBeenCalled();
      foreign.page.close();
      other.page.close();
    });

    it("relays the page's send/close commands to the kernel under that socket's id", async () => {
      const { relay, posted } = setupRelay();
      const s = shimRequest({ type: "wcvm:previewWebSocket", port: 1, path: "/", protocols: [] });
      relay.handleMessage(s.event, ORIGIN);
      s.page.postMessage({ kind: "send", data: "hi" });
      s.page.postMessage({ kind: "send", data: new Uint8Array([1]) });
      s.page.postMessage({ kind: "close", code: 1000, reason: "bye" });
      await vi.waitFor(() => expect(posted).toHaveBeenCalledTimes(4));
      expect(posted.mock.calls.slice(1)).toEqual([
        ["preview:wsSend", { id: 1, data: "hi" }],
        ["preview:wsSend", { id: 1, data: new Uint8Array([1]) }],
        ["preview:wsClose", { id: 1, code: 1000, reason: "bye" }],
      ]);
      s.page.close();
    });

    it("delivers kernel events for a socket to that socket's page port, in order, and stops after close", async () => {
      const { relay, emit } = setupRelay();
      const a = shimRequest({ type: "wcvm:previewWebSocket", port: 1, path: "/", protocols: [] });
      const b = shimRequest({ type: "wcvm:previewWebSocket", port: 2, path: "/", protocols: [] });
      relay.handleMessage(a.event, ORIGIN);
      relay.handleMessage(b.event, ORIGIN);
      emit({ type: "preview:ws", id: 1, event: { kind: "open", protocol: "" } });
      emit({ type: "preview:ws", id: 2, event: { kind: "open", protocol: "p" } });
      emit({ type: "preview:ws", id: 1, event: { kind: "message", data: "one" } });
      emit({ type: "preview:ws", id: 1, event: { kind: "close", code: 1000, reason: "", wasClean: true } });
      emit({ type: "preview:ws", id: 1, event: { kind: "message", data: "after close" } });
      await vi.waitFor(() => expect(a.received).toHaveLength(3));
      await vi.waitFor(() => expect(b.received).toHaveLength(1));
      await tick();
      expect(a.received).toEqual([
        { kind: "open", protocol: "" },
        { kind: "message", data: "one" },
        { kind: "close", code: 1000, reason: "", wasClean: true },
      ]);
      expect(b.received).toEqual([{ kind: "open", protocol: "p" }]);
      a.page.close();
      b.page.close();
    });
  });
});

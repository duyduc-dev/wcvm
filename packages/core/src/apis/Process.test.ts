import { describe, expect, it, vi } from "vitest";
import { IKernelBridge } from "../bridges/kernel";
import { Handler } from "../bridges/models";
import { createProcessApi } from "./Process";

const setup = () => {
  const listeners = new Map<string, Set<Handler>>();
  const postMessage = vi.fn();
  const bridge = {
    postMessage,
    on: (type: string, handler: Handler) => {
      if (!listeners.has(type)) listeners.set(type, new Set());
      listeners.get(type)!.add(handler);
      return () => listeners.get(type)!.delete(handler);
    },
  } as unknown as IKernelBridge;
  const emit = (message: { type: string; [k: string]: unknown }) =>
    listeners.get(message.type)?.forEach((h) => h(message));
  const listenerCount = () =>
    [...listeners.values()].reduce((n, set) => n + set.size, 0);
  return { bridge, postMessage, emit, listenerCount };
};

const text = (stream: ReadableStream<Uint8Array>) => new Response(stream).text();
const bytes = (s: string) => new TextEncoder().encode(s);

describe("process api", () => {
  it("posts a spawn request with its options", () => {
    const { bridge, postMessage } = setup();
    createProcessApi(bridge, 3, "echo", ["hi"], { cwd: "/w", env: { A: "1" } });
    expect(postMessage).toHaveBeenCalledWith("process:spawn", {
      processId: 3,
      command: "echo",
      args: ["hi"],
      cwd: "/w",
      env: { A: "1" },
    });
  });

  it("delivers stdout and stderr in order, then closes both streams on exit", async () => {
    const { bridge, emit } = setup();
    const proc = createProcessApi(bridge, 1, "x", []);

    emit({ type: "process:stdout", processId: 1, chunk: bytes("a") });
    emit({ type: "process:stderr", processId: 1, chunk: bytes("E") });
    emit({ type: "process:stdout", processId: 1, chunk: bytes("b") });
    emit({ type: "process:exit", processId: 1, errorCode: 0 });

    expect(await text(proc.stdout)).toBe("ab");
    expect(await text(proc.stderr)).toBe("E");
    expect(await proc.exit).toEqual({
      errorCode: 0,
      errorMessage: undefined,
      signal: undefined,
    });
  });

  it("ignores events for other processes", async () => {
    const { bridge, emit } = setup();
    const proc = createProcessApi(bridge, 1, "x", []);
    emit({ type: "process:stdout", processId: 2, chunk: bytes("nope") });
    emit({ type: "process:exit", processId: 2, errorCode: 9 });
    emit({ type: "process:exit", processId: 1, errorCode: 0 });
    expect(await text(proc.stdout)).toBe("");
    expect((await proc.exit).errorCode).toBe(0);
  });

  it("reports the signal and message from the kernel", async () => {
    const { bridge, emit } = setup();
    const proc = createProcessApi(bridge, 1, "x", []);
    emit({
      type: "process:exit",
      processId: 1,
      errorCode: 143,
      signal: "SIGTERM",
      errorMessage: "m",
    });
    expect(await proc.exit).toEqual({
      errorCode: 143,
      signal: "SIGTERM",
      errorMessage: "m",
    });
  });

  it("stops listening once the process exits", async () => {
    const { bridge, emit, listenerCount } = setup();
    const proc = createProcessApi(bridge, 1, "x", []);
    expect(listenerCount()).toBe(3);
    emit({ type: "process:exit", processId: 1, errorCode: 0 });
    await proc.exit;
    expect(listenerCount()).toBe(0);
  });

  it("kill posts process:kill with the signal", () => {
    const { bridge, postMessage } = setup();
    const proc = createProcessApi(bridge, 4, "sleep", ["9"]);
    proc.kill("SIGKILL");
    proc.kill();
    expect(postMessage).toHaveBeenCalledWith("process:kill", {
      processId: 4,
      signal: "SIGKILL",
    });
    expect(postMessage).toHaveBeenCalledWith("process:kill", {
      processId: 4,
      signal: undefined,
    });
  });
});

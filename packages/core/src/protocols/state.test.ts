import { describe, expect, it, vi } from "vitest";
import { createDiagnostics } from "./diagnostics";
import { createState } from "./state";

describe("state", () => {
  it("merges object and functional updates", () => {
    const state = createState({ a: 1, b: 2 });
    state.setState({ a: 5 });
    state.setState((prev) => ({ b: prev.b + 1 }));
    expect(state.getState()).toEqual({ a: 5, b: 3 });
  });

  it("returns a copy so callers cannot mutate internal state", () => {
    const state = createState({ a: 1 });
    (state.getState() as { a: number }).a = 99;
    expect(state.getState().a).toBe(1);
  });

  it("logs updates to diagnostics when provided", () => {
    const diagnostics = createDiagnostics();
    const seen: string[] = [];
    diagnostics.onEvent((e) => seen.push(e.type));
    createState({ a: 1 }, diagnostics).setState({ a: 2 });
    expect(seen).toContain("state:update");
  });
});

describe("diagnostics", () => {
  it("replays history to late subscribers", () => {
    const diagnostics = createDiagnostics();
    diagnostics.log("early", 1);
    const handler = vi.fn();
    diagnostics.onEvent(handler);
    expect(handler).toHaveBeenCalledWith(
      expect.objectContaining({ type: "early", payload: 1 }),
    );
  });

  it("keeps only the most recent 50 events", () => {
    const diagnostics = createDiagnostics();
    for (let i = 0; i < 60; i++) diagnostics.log("e", i);
    const payloads: unknown[] = [];
    diagnostics.onEvent((e) => payloads.push(e.payload));
    expect(payloads).toHaveLength(50);
    expect(payloads[0]).toBe(10);
  });

  it("stops delivering after unsubscribe", () => {
    const diagnostics = createDiagnostics();
    const handler = vi.fn();
    const off = diagnostics.onEvent(handler);
    off();
    diagnostics.log("late");
    expect(handler).not.toHaveBeenCalled();
  });
});

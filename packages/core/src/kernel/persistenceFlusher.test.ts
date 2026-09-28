import { describe, expect, it } from "vitest";
import { createPersistenceFlusher } from "./persistenceFlusher";

const setup = () => {
  const posted: unknown[] = [];
  const flusher = createPersistenceFlusher({ postMessage: (m) => posted.push(m) });
  return { flusher, posted };
};

describe("kernel persistence flusher", () => {
  it("posts a flushPersistence request with an incrementing id, and resolves on the matching reply", async () => {
    const { flusher, posted } = setup();
    const p = flusher.flush();
    expect(posted).toEqual([{ type: "flushPersistence", id: 1 }]);

    flusher.dispatch({ type: "flushPersistence:done", id: 1 });
    await expect(p).resolves.toBeUndefined();
  });

  it("each concurrent flush() gets its own id, and resolves independently regardless of reply order", async () => {
    const { flusher, posted } = setup();
    const p1 = flusher.flush();
    const p2 = flusher.flush();
    expect(posted).toEqual([
      { type: "flushPersistence", id: 1 },
      { type: "flushPersistence", id: 2 },
    ]);

    flusher.dispatch({ type: "flushPersistence:done", id: 2 });
    flusher.dispatch({ type: "flushPersistence:done", id: 1 });
    await expect(p1).resolves.toBeUndefined();
    await expect(p2).resolves.toBeUndefined();
  });

  it("ignores a reply for an unknown/already-resolved id", () => {
    const { flusher } = setup();
    expect(() => flusher.dispatch({ type: "flushPersistence:done", id: 999 })).not.toThrow();
  });
});

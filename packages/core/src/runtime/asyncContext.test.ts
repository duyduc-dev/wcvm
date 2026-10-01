import { afterEach, describe, expect, it } from "vitest";
import { AsyncLocalStorageShim } from "./asyncContext";
import { createTestLoader } from "./testing";

const created: { disable(): void }[] = [];
const make = (options?: object) => {
  const als = new AsyncLocalStorageShim(options);
  created.push(als);
  return als;
};
afterEach(() => {
  for (const als of created.splice(0)) als.disable();
});

const tick = () => new Promise<void>((resolve) => setTimeout(resolve, 5));

describe("AsyncLocalStorage (no V8 promise hooks)", () => {
  it("is what async_hooks exports, and constructing it no longer needs internal/promise_hooks", () => {
    const { AsyncLocalStorage, createHook } = createTestLoader().require("async_hooks");
    const als = new AsyncLocalStorage();
    created.push(als);
    expect(als.run("x", () => als.getStore())).toBe("x");
    // `AsyncHook#enable` used to throw ERR_UNKNOWN_BUILTIN_MODULE for internal/promise_hooks.
    expect(() => createHook({ init() {} }).enable().disable()).not.toThrow();
  });

  it("a nested run puts its parent's store back; the outermost keeps its own (see #scoped)", () => {
    const als = make();
    expect(als.getStore()).toBeUndefined();
    const seen: unknown[] = [];
    als.run("outer", () => {
      seen.push(als.getStore());
      als.run("inner", () => seen.push(als.getStore()));
      seen.push(als.getStore());
    });
    seen.push(als.getStore());
    // Node would answer `undefined` for the last one. Here the outermost run leaves its value in place,
    // so a streaming render that outlives its run() (Next.js's app router) still has its context.
    expect(seen).toEqual(["outer", "inner", "outer", "outer"]);
    als.run("next request", () => {});
    expect(als.getStore()).toBe("next request"); // replaced by the next run
    als.disable();
    expect(als.getStore()).toBeUndefined(); // and disable() clears it
  });

  it("returns the callback's value, forwards arguments, and undoes the scope when it throws synchronously", () => {
    const als = make();
    expect(als.run("s", (a: number, b: number) => a + b, 2, 3)).toBe(5);
    als.disable();
    const fresh = make();
    expect(() =>
      fresh.run("s", () => {
        throw new Error("boom");
      }),
    ).toThrow("boom");
    expect(fresh.getStore()).toBeUndefined(); // a throw means the scope really is over
  });

  it("keeps the store across a raw await inside an async callback", async () => {
    const als = make();
    const seen: unknown[] = [];
    await als.run({ id: 1 }, async () => {
      seen.push((als.getStore() as any).id);
      await tick();
      seen.push((als.getStore() as any).id);
      await Promise.resolve();
      seen.push((als.getStore() as any).id);
    });
    expect(seen).toEqual([1, 1, 1]);
  });

  it("a nested async run gets its parent back once its promise settles - on rejection too", async () => {
    const als = make();
    await als.run("parent", async () => {
      await als.run("child", async () => {
        await tick();
        expect(als.getStore()).toBe("child");
      });
      expect(als.getStore()).toBe("parent");
      await expect(
        als.run("child2", async () => {
          await tick();
          throw new Error("late");
        }),
      ).rejects.toThrow("late");
      expect(als.getStore()).toBe("parent");
    });
  });

  it("carries the store into work scheduled from inside a run", async () => {
    const als = make();
    const seen: Record<string, unknown> = {};
    // The loader's `process` is what the factory patches (as in a real runtime, where it is not the
    // host's `globalThis.process`).
    const loader = createTestLoader();
    loader.require("async_hooks");
    als.run("ctx", () => {
      setTimeout(() => (seen.timeout = als.getStore()), 0);
      queueMicrotask(() => (seen.microtask = als.getStore()));
      Promise.resolve().then(() => (seen.then = als.getStore()));
      loader.process.nextTick(() => (seen.nextTick = als.getStore()));
      setImmediate(() => (seen.immediate = als.getStore()));
    });
    await tick();
    await tick();
    // Each detached callback saw the store that was current when it was scheduled.
    expect(seen).toEqual({ timeout: "ctx", microtask: "ctx", then: "ctx", nextTick: "ctx", immediate: "ctx" });
  });

  it("a callback scheduled after disable() sees no store", async () => {
    const als = make({ defaultValue: "dflt" });
    const seen: unknown[] = [];
    als.run("ctx", () => {});
    als.disable();
    setTimeout(() => seen.push(als.getStore()), 0);
    await tick();
    expect(seen).toEqual(["dflt"]);
  });

  it("supports enterWith, exit, defaultValue, name and disable", () => {
    const als = make({ defaultValue: "dflt", name: "req" });
    expect(als.name).toBe("req");
    expect(als.getStore()).toBe("dflt");
    als.enterWith("entered");
    expect(als.getStore()).toBe("entered");
    expect(als.exit(() => als.getStore())).toBe("dflt");
    expect(als.getStore()).toBe("entered");
    als.disable();
    expect(als.getStore()).toBe("dflt");
    als.run("again", () => expect(als.getStore()).toBe("again"));
  });

  it("bind and snapshot capture every live store at call time", () => {
    const a = make();
    const b = make();
    let bound!: () => unknown[];
    let snap!: (cb: () => unknown) => unknown;
    a.run("A", () =>
      b.run("B", () => {
        bound = AsyncLocalStorageShim.bind(() => [a.getStore(), b.getStore()]);
        snap = AsyncLocalStorageShim.snapshot();
      }),
    );
    expect(bound()).toEqual(["A", "B"]);
    expect(snap(() => a.getStore())).toBe("A");
    // Bound to what was current when captured, not what is current when called.
    b.run("changed", () => {});
    expect(bound()).toEqual(["A", "B"]);
  });

  it("keeps independent instances independent", () => {
    const a = make();
    const b = make();
    a.run("A", () => {
      expect(a.getStore()).toBe("A");
      expect(b.getStore()).toBeUndefined();
    });
  });

  it("rejects a non-object options argument like Node", () => {
    expect(() => new AsyncLocalStorageShim("nope" as never)).toThrow(/options/);
  });
});

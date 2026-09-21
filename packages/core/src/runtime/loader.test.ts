import { describe, expect, it } from "vitest";
import { createBuiltinLoader } from "./loader";
import { createPrimordials } from "./primordials";
import { createTestLoader } from "./testing";

const bindings = () => {
  throw new Error("no bindings in this test");
};

const setup = () => createTestLoader().loader;

describe("primordials", () => {
  it("come from Node's real per-context script", () => {
    const p = createPrimordials();
    expect(p.ArrayPrototypeJoin([1, 2], "-")).toBe("1-2");
    expect(p.StringPrototypeSlice("hello", 1, 3)).toBe("el");
    expect(p.ObjectKeys({ a: 1 })).toEqual(["a"]);
    expect(new p.SafeMap([[1, 2]]).get(1)).toBe(2);
    expect(typeof p.SafePromiseAll).toBe("function");
    expect(typeof p.uncurryThis).toBe("function");
  });
});

describe("builtin loader", () => {
  it("runs Node's real path module unmodified", () => {
    const loader = setup();
    const path = loader.requireBuiltin("path");
    expect(path.join("/a", "b", "../c")).toBe("/a/c");
    expect(path.resolve("/x", "y")).toBe("/x/y");
    expect(path.basename("/a/b.txt", ".txt")).toBe("b");
    expect(path.posix).toBe(path);
  });

  it("caches instances and accepts the node: scheme", () => {
    const loader = setup();
    expect(loader.requireBuiltin("node:path")).toBe(loader.requireBuiltin("path"));
  });

  it("only lets users require public, vendored modules", () => {
    const loader = setup();
    expect(loader.canBeRequiredByUsers("path")).toBe(true);
    expect(loader.canBeRequiredByUsers("node:path")).toBe(true);
    expect(loader.canBeRequiredByUsers("internal/per_context/primordials")).toBe(false);
    expect(loader.canBeRequiredByUsers("nope")).toBe(false);
  });

  it("fails loudly for a module that is not vendored", () => {
    expect(() => setup().requireBuiltin("nope")).toThrow(
      expect.objectContaining({ code: "ERR_UNKNOWN_BUILTIN_MODULE" }),
    );
  });

  it("tolerates a require cycle by handing back the partial exports", () => {
    const primordials = createPrimordials();
    const loader = createBuiltinLoader({
      process: {},
      internalBinding: bindings,
      primordials,
      factories: {
        a: (exports, require) => {
          exports.early = 1;
          exports.fromB = require("b").seenA;
        },
        b: (exports, require) => {
          exports.seenA = { ...require("a") };
        },
      },
    });
    expect(loader.requireBuiltin("a")).toEqual({ early: 1, fromB: { early: 1 } });
  });

  it("does not cache a module whose factory threw", () => {
    let attempts = 0;
    const loader = createBuiltinLoader({
      process: {},
      internalBinding: bindings,
      primordials: createPrimordials(),
      factories: {
        flaky: () => {
          if (++attempts === 1) throw new Error("first try fails");
        },
      },
    });
    expect(() => loader.requireBuiltin("flaky")).toThrow("first try fails");
    expect(() => loader.requireBuiltin("flaky")).not.toThrow();
  });
});

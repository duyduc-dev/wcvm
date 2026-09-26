import { describe, expect, it } from "vitest";
import { createLoopbackFs } from "../testing/loopbackFs";
import { resetFs } from "./reset";

describe("resetFs", () => {
  it("removes every entry under root, recursively, but not root itself", () => {
    const { fs } = createLoopbackFs();
    fs.mkdir("/a/b", { recursive: true });
    fs.writeFile("/a/b/f", "x");
    fs.writeFile("/top", "y");

    resetFs(fs);

    expect(fs.readdir("/")).toEqual([]);
    expect(fs.exists("/a")).toBe(false);
    expect(fs.exists("/top")).toBe(false);
    expect(fs.stat("/").kind).toBe("dir");
  });

  it("is a no-op against an already-empty filesystem", () => {
    const { fs } = createLoopbackFs();
    expect(() => resetFs(fs)).not.toThrow();
    expect(fs.readdir("/")).toEqual([]);
  });
});

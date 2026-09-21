import { describe, expect, it } from "vitest";
import { createLoopbackFs } from "../testing/loopbackFs";
import { mountTree } from "./mount";

const text = (b: Uint8Array) => new TextDecoder().decode(b);

describe("mountTree", () => {
  it("creates files, nested directories and symlinks", () => {
    const { fs } = createLoopbackFs();
    mountTree(fs, {
      "package.json": { file: { contents: "{}" } },
      src: {
        directory: {
          "index.js": { file: { contents: new TextEncoder().encode("1") } },
          deep: { directory: { "x.txt": { file: { contents: "x" } } } },
        },
      },
      latest: { symlink: "/app/src" },
    }, "/app");

    expect(text(fs.readFile("/app/package.json"))).toBe("{}");
    expect(text(fs.readFile("/app/src/index.js"))).toBe("1");
    expect(text(fs.readFile("/app/src/deep/x.txt"))).toBe("x");
    expect(text(fs.readFile("/app/latest/index.js"))).toBe("1");
  });

  it("mounts into the root by default and merges into existing directories", () => {
    const { fs } = createLoopbackFs();
    fs.mkdir("/d");
    fs.writeFile("/d/keep", "k");
    mountTree(fs, { d: { directory: { new: { file: { contents: "n" } } } } });
    expect(fs.readdir("/d")).toEqual(["keep", "new"]);
  });

  it("creates an empty directory for an empty subtree", () => {
    const { fs } = createLoopbackFs();
    mountTree(fs, { empty: { directory: {} } });
    expect(fs.stat("/empty").kind).toBe("dir");
  });

  it("rejects names that would escape their directory", () => {
    const { fs } = createLoopbackFs();
    for (const name of ["", ".", "..", "a/b"]) {
      expect(() =>
        mountTree(fs, { [name]: { file: { contents: "" } } }, "/x"),
      ).toThrow(expect.objectContaining({ code: "EINVAL" }));
    }
  });
});

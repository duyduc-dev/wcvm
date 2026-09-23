import { describe, expect, it, vi } from "vitest";
import { createFakeOpfsDir } from "../testing/fakeOpfs";
import { Vfs } from "./Vfs";
import { createOpfsMirror, restoreFromOpfs } from "./opfsPersistence";

const decode = (bytes: Uint8Array | undefined): string | undefined => (bytes === undefined ? undefined : new TextDecoder().decode(bytes));

describe("restoreFromOpfs", () => {
  it("recreates OPFS's files and directories inside a fresh Vfs", async () => {
    const root = createFakeOpfsDir();
    root.seedFile("/a.txt", "hello");
    root.seedFile("/dir/b.txt", "world");
    root.seedFile("/dir/nested/c.txt", "deep");

    const vfs = new Vfs();
    await restoreFromOpfs(vfs, root);

    expect(decode(vfs.readFile("/a.txt"))).toBe("hello");
    expect(decode(vfs.readFile("/dir/b.txt"))).toBe("world");
    expect(decode(vfs.readFile("/dir/nested/c.txt"))).toBe("deep");
    expect(vfs.stat("/dir").kind).toBe("dir");
  });

  it("restores an empty directory with nothing in it", async () => {
    const root = createFakeOpfsDir();
    await root.getDirectoryHandle("empty", { create: true });

    const vfs = new Vfs();
    await restoreFromOpfs(vfs, root);

    expect(vfs.stat("/empty").kind).toBe("dir");
    expect(vfs.readdir("/empty")).toEqual([]);
  });

  it("an empty OPFS root restores to an empty vfs", async () => {
    const vfs = new Vfs();
    await restoreFromOpfs(vfs, createFakeOpfsDir());
    expect(vfs.readdir("/")).toEqual([]);
  });
});

describe("createOpfsMirror", () => {
  const setup = () => {
    const vfs = new Vfs();
    const root = createFakeOpfsDir();
    vfs.onChange = createOpfsMirror(vfs, root);
    return { vfs, root };
  };

  /** The mirror runs write-behind (fire-and-forget); tests wait for the queue to drain. */
  const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

  it("mirrors a new file's content to OPFS", async () => {
    const { vfs, root } = setup();
    vfs.writeFile("/a.txt", new TextEncoder().encode("hi"));
    await flush();
    expect(decode(root.readFileAt("/a.txt"))).toBe("hi");
  });

  it("mirrors an overwrite", async () => {
    const { vfs, root } = setup();
    vfs.writeFile("/a.txt", new TextEncoder().encode("hi"));
    vfs.writeFile("/a.txt", new TextEncoder().encode("bye"));
    await flush();
    expect(decode(root.readFileAt("/a.txt"))).toBe("bye");
  });

  it("mirrors mkdir, including nested directories", async () => {
    const { vfs, root } = setup();
    vfs.mkdir("/a/b/c", { recursive: true });
    await flush();
    expect(root.hasDirAt("/a/b/c")).toBe(true);
  });

  it("mirrors a delete (unlink)", async () => {
    const { vfs, root } = setup();
    vfs.writeFile("/a.txt", new TextEncoder().encode("hi"));
    await flush();
    expect(root.readFileAt("/a.txt")).toBeDefined();

    vfs.unlink("/a.txt");
    await flush();
    expect(root.readFileAt("/a.txt")).toBeUndefined();
  });

  it("mirrors a directory rename, including its whole existing subtree", async () => {
    const { vfs, root } = setup();
    vfs.mkdir("/src");
    vfs.writeFile("/src/a.txt", new TextEncoder().encode("hi"));
    vfs.mkdir("/src/nested");
    vfs.writeFile("/src/nested/b.txt", new TextEncoder().encode("world"));
    await flush();

    vfs.rename("/src", "/dst");
    await flush();

    expect(root.readFileAt("/src/a.txt")).toBeUndefined();
    expect(decode(root.readFileAt("/dst/a.txt"))).toBe("hi");
    expect(decode(root.readFileAt("/dst/nested/b.txt"))).toBe("world");
  });

  it("applies changes to the same path in order, even if their async work would otherwise race", async () => {
    const { vfs, root } = setup();
    // Three writes in a row, synchronously - the mirror's own OPFS work for each is async, so
    // without ordering, a slower earlier write could clobber a faster later one.
    vfs.writeFile("/a.txt", new TextEncoder().encode("1"));
    vfs.writeFile("/a.txt", new TextEncoder().encode("2"));
    vfs.writeFile("/a.txt", new TextEncoder().encode("3"));
    await flush();
    expect(decode(root.readFileAt("/a.txt"))).toBe("3");
  });

  it("does not mirror a symlink (OPFS has none)", async () => {
    const { vfs, root } = setup();
    vfs.writeFile("/real.txt", new TextEncoder().encode("hi"));
    vfs.symlink("/real.txt", "/link");
    await flush();
    expect(root.readFileAt("/link")).toBeUndefined();
  });

  it("a persistence failure is logged and does not break later mirrored changes", async () => {
    const { vfs, root } = setup();
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    const originalGetFileHandle = root.getFileHandle.bind(root);
    root.getFileHandle = async (name, options) => {
      if (name === "bad.txt") throw new Error("boom");
      return originalGetFileHandle(name, options);
    };

    vfs.writeFile("/bad.txt", new TextEncoder().encode("x"));
    vfs.writeFile("/ok.txt", new TextEncoder().encode("y"));
    await flush();

    expect(spy).toHaveBeenCalledWith(expect.stringContaining("/bad.txt"), expect.any(Error));
    expect(decode(root.readFileAt("/ok.txt"))).toBe("y");
    spy.mockRestore();
  });
});

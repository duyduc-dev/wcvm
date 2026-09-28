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

  it("a corrupted symlink manifest is logged and ignored, not a boot-hanging throw (a real, reproduced regression)", async () => {
    // Reproduces the actual bug: a page reload interrupting saveSymlinkManifest's own write left
    // truncated JSON behind. Before the fix, JSON.parse's SyntaxError propagated out of
    // restoreFromOpfs uncaught - which the FS Worker's own boot() never catches either, so it
    // never sent "ready" and the whole kernel boot hung until ERR_BOOT_TIMEOUT, 10s later.
    const root = createFakeOpfsDir();
    root.seedFile("/a.txt", "hello");
    root.seedFile("/__wcvm_symlinks__.json", '{"/link": "/a.tx'); // truncated mid-write

    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    const vfs = new Vfs();
    await expect(restoreFromOpfs(vfs, root)).resolves.toBeUndefined();
    expect(spy).toHaveBeenCalledWith(expect.stringContaining("symlink manifest is unreadable"), expect.any(Error));
    spy.mockRestore();

    // The rest of the tree still restores normally despite the corrupted manifest.
    expect(decode(vfs.readFile("/a.txt"))).toBe("hello");
    expect(vfs.exists("/link")).toBe(false);
  });

  it("skips a single corrupted/unreadable file during restore instead of failing the whole tree (per-entry resilience)", async () => {
    // The same class of bug as the corrupted-manifest case above, but for an ORDINARY file: any
    // OPFS entry can fail to read (another real way an interrupted write can leave things), and
    // before this fix a single bad file failed the ENTIRE restore the same uncaught, boot-hanging
    // way - not just the symlink manifest.
    const root = createFakeOpfsDir();
    root.seedFile("/good.txt", "fine");
    root.seedFile("/bad.txt", "irrelevant - getFile() is about to be replaced");
    root.seedFile("/dir/also-good.txt", "still here");

    const originalEntries = root.entries.bind(root);
    root.entries = async function* () {
      for await (const [name, handle] of originalEntries()) {
        if (name === "bad.txt") {
          yield [name, { ...handle, getFile: async () => { throw new Error("boom"); } }] as const;
        } else {
          yield [name, handle] as const;
        }
      }
    };

    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    const vfs = new Vfs();
    await expect(restoreFromOpfs(vfs, root)).resolves.toBeUndefined();
    expect(spy).toHaveBeenCalledWith(expect.stringContaining("/bad.txt"), expect.any(Error));
    spy.mockRestore();

    expect(decode(vfs.readFile("/good.txt"))).toBe("fine");
    expect(decode(vfs.readFile("/dir/also-good.txt"))).toBe("still here");
    expect(vfs.exists("/bad.txt")).toBe(false);
  });
});

describe("createOpfsMirror", () => {
  const setup = () => {
    const vfs = new Vfs();
    const root = createFakeOpfsDir();
    const mirror = createOpfsMirror(vfs, root);
    vfs.onChange = mirror.notify;
    return { vfs, root, mirror };
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

  it("mirrors unrelated paths concurrently instead of one at a time (why sync() is fast now)", async () => {
    const { vfs, root, mirror } = setup();
    let releaseSlow!: () => void;
    const slowGate = new Promise<void>((resolve) => (releaseSlow = resolve));
    const originalGetFileHandle = root.getFileHandle.bind(root);
    root.getFileHandle = async (name, options) => {
      if (name === "slow.txt") await slowGate;
      return originalGetFileHandle(name, options);
    };

    // Queued in the same tick, slow first - with one shared queue (the old behavior), fast.txt
    // would have to wait behind slow.txt's still-gated write.
    vfs.writeFile("/slow.txt", new TextEncoder().encode("slow"));
    vfs.writeFile("/fast.txt", new TextEncoder().encode("fast"));

    await flush();
    expect(decode(root.readFileAt("/fast.txt"))).toBe("fast"); // done despite slow.txt still gated
    expect(root.readFileAt("/slow.txt")).toBeUndefined();

    releaseSlow();
    await mirror.flush();
    expect(decode(root.readFileAt("/slow.txt"))).toBe("slow");
  });

  it("caches a resolved directory handle instead of re-walking it for every sibling file", async () => {
    const { vfs, root, mirror } = setup();
    const calls: string[] = [];
    const originalGetDirectoryHandle = root.getDirectoryHandle.bind(root);
    root.getDirectoryHandle = async (name, options) => {
      calls.push(name);
      return originalGetDirectoryHandle(name, options);
    };

    vfs.mkdir("/pkg", { recursive: true });
    vfs.writeFile("/pkg/a.txt", new TextEncoder().encode("a"));
    await mirror.flush();
    vfs.writeFile("/pkg/b.txt", new TextEncoder().encode("b"));
    vfs.writeFile("/pkg/c.txt", new TextEncoder().encode("c"));
    await mirror.flush();

    // "pkg" was resolved once (by the mkdir) - a.txt/b.txt/c.txt's own writes all reuse the
    // cached handle instead of each calling getDirectoryHandle("pkg") again.
    expect(calls.filter((n) => n === "pkg")).toHaveLength(1);
    expect(decode(root.readFileAt("/pkg/b.txt"))).toBe("b");
    expect(decode(root.readFileAt("/pkg/c.txt"))).toBe("c");
  });

  it("resolves a shared ancestor only once even when several concurrent top-level changes need it at the same time", async () => {
    const { vfs, root, mirror } = setup();
    const calls: string[] = [];
    const originalGetDirectoryHandle = root.getDirectoryHandle.bind(root);
    root.getDirectoryHandle = async (name, options) => {
      calls.push(name);
      return originalGetDirectoryHandle(name, options);
    };

    // mkdir AND two sibling files' writes all fire as SEPARATE, independent top-level changes in
    // the same tick - each is its own path/queue with no ordering relationship to the others, so
    // without promise-level memoization every one of them would race to resolve "pkg" itself.
    vfs.mkdir("/pkg", { recursive: true });
    vfs.writeFile("/pkg/a.txt", new TextEncoder().encode("a"));
    vfs.writeFile("/pkg/b.txt", new TextEncoder().encode("b"));
    await mirror.flush();

    expect(calls.filter((n) => n === "pkg")).toHaveLength(1);
    expect(decode(root.readFileAt("/pkg/a.txt"))).toBe("a");
    expect(decode(root.readFileAt("/pkg/b.txt"))).toBe("b");
  });

  it("invalidates a removed directory's cached handle, so a later recreation isn't stale", async () => {
    const { vfs, root, mirror } = setup();
    vfs.mkdir("/pkg", { recursive: true });
    vfs.writeFile("/pkg/old.txt", new TextEncoder().encode("old"));
    await mirror.flush();

    vfs.rm("/pkg", { recursive: true });
    await mirror.flush();
    vfs.mkdir("/pkg", { recursive: true });
    vfs.writeFile("/pkg/new.txt", new TextEncoder().encode("new"));
    await mirror.flush();

    const restored = new Vfs();
    await restoreFromOpfs(restored, root);
    expect(restored.exists("/pkg/old.txt")).toBe(false);
    expect(decode(restored.readFile("/pkg/new.txt"))).toBe("new");
  });

  it("does not mirror a symlink as an OPFS file entry (OPFS has none) - it's tracked separately", async () => {
    const { vfs, root } = setup();
    vfs.writeFile("/real.txt", new TextEncoder().encode("hi"));
    vfs.symlink("/real.txt", "/link");
    await flush();
    expect(root.readFileAt("/link")).toBeUndefined();
  });

  it("a symlink survives a restore into a fresh vfs (the actual regression: npm's bin-linking)", async () => {
    const { vfs, root } = setup();
    vfs.mkdir("/node_modules/.bin", { recursive: true });
    vfs.mkdir("/node_modules/vite/bin", { recursive: true });
    vfs.writeFile("/node_modules/vite/bin/vite.js", new TextEncoder().encode("#!/usr/bin/env node"));
    vfs.symlink("../vite/bin/vite.js", "/node_modules/.bin/vite");
    await flush();

    const restored = new Vfs();
    await restoreFromOpfs(restored, root);

    expect(restored.lstat("/node_modules/.bin/vite").kind).toBe("symlink");
    expect(restored.readlink("/node_modules/.bin/vite")).toBe("../vite/bin/vite.js");
    // The manifest file itself is bookkeeping, not part of the project's own tree.
    expect(restored.exists("/__wcvm_symlinks__.json")).toBe(false);
  });

  it("removing a symlink drops it from what gets restored", async () => {
    const { vfs, root } = setup();
    vfs.writeFile("/real.txt", new TextEncoder().encode("hi"));
    vfs.symlink("/real.txt", "/link");
    await flush();
    vfs.unlink("/link");
    await flush();

    const restored = new Vfs();
    await restoreFromOpfs(restored, root);
    expect(restored.exists("/link")).toBe(false);
    expect(decode(restored.readFile("/real.txt"))).toBe("hi");
  });

  it("renaming a directory carries its nested symlink to the new location, not the old one", async () => {
    const { vfs, root } = setup();
    vfs.mkdir("/src/.bin", { recursive: true });
    vfs.writeFile("/src/real.js", new TextEncoder().encode("x"));
    vfs.symlink("../real.js", "/src/.bin/tool");
    await flush();

    vfs.rename("/src", "/dst");
    await flush();

    const restored = new Vfs();
    await restoreFromOpfs(restored, root);
    expect(restored.exists("/src/.bin/tool")).toBe(false);
    expect(restored.lstat("/dst/.bin/tool").kind).toBe("symlink");
    expect(restored.readlink("/dst/.bin/tool")).toBe("../real.js");
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

  it("flush() resolves once every write queued so far has actually landed, with no arbitrary delay", async () => {
    const { vfs, root, mirror } = setup();
    vfs.writeFile("/a.txt", new TextEncoder().encode("1"));
    vfs.writeFile("/b.txt", new TextEncoder().encode("2"));
    vfs.mkdir("/dir/nested", { recursive: true });

    await mirror.flush();

    expect(decode(root.readFileAt("/a.txt"))).toBe("1");
    expect(decode(root.readFileAt("/b.txt"))).toBe("2");
    expect(root.hasDirAt("/dir/nested")).toBe(true);
  });

  it("flush() does not reject even if one of the queued writes failed", async () => {
    const { vfs, root, mirror } = setup();
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    root.getFileHandle = async () => {
      throw new Error("boom");
    };

    vfs.writeFile("/bad.txt", new TextEncoder().encode("x"));

    await expect(mirror.flush()).resolves.toBeUndefined();
    spy.mockRestore();
  });
});

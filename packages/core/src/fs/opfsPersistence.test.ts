import { describe, expect, it, vi } from "vitest";
import { createFakeOpfsDir } from "../testing/fakeOpfs";
import { Vfs } from "./Vfs";
import { createOpfsMirror, restoreFromOpfs, restoreFromOpfsLazy } from "./opfsPersistence";

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

  it("prunes an orphaned symlink manifest entry (its own project is genuinely gone) so it doesn't re-log forever, but leaves a merely-occupied one alone", async () => {
    // Reproduces the actual reported bug: wc.fs.reset() ("Clear All") deletes a project via
    // fs.rm(), whose own manifest cleanup (createOpfsMirror's removeSymlinksUnder) runs on the
    // write-behind mirror's own async queue - a reload landing before that queue drains can leave
    // the project's real files gone while its manifest entries survive, orphaned. Before this fix,
    // every future boot re-attempted (and re-logged) the same dead entry forever.
    const root = createFakeOpfsDir();
    root.seedFile("/home/user/projects/other/real.txt", "still here");
    root.seedFile(
      "/__wcvm_symlinks__.json",
      JSON.stringify({
        // "n" doesn't exist at all - deleted, but its manifest entry survived (the actual bug).
        "/home/user/projects/n/node_modules/.bin/vite": "../vite/bin/vite.js",
        // A real, currently-occupied conflict (not orphaning) - must NOT be pruned.
        "/home/user/projects/other/real.txt": "/home/user/projects/other/somewhere-else",
      }),
    );

    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    const vfs = new Vfs();
    await expect(restoreFromOpfs(vfs, root)).resolves.toBeUndefined();
    expect(spy).toHaveBeenCalledWith(expect.stringContaining("pruning 1 orphaned symlink"), ["/home/user/projects/n/node_modules/.bin/vite"]);
    spy.mockRestore();

    // Restoring again (a later boot) doesn't re-log anything - the orphan was actually removed
    // from the persisted manifest, not just skipped this one time.
    const spy2 = vi.spyOn(console, "error").mockImplementation(() => {});
    const vfs2 = new Vfs();
    await restoreFromOpfs(vfs2, root);
    expect(spy2).not.toHaveBeenCalledWith(expect.stringContaining("pruning"), expect.anything());
    spy2.mockRestore();

    // The other, merely-occupied entry is untouched - still a real file, still in the manifest,
    // still (correctly) not a symlink.
    expect(decode(vfs.readFile("/home/user/projects/other/real.txt"))).toBe("still here");
    expect(vfs.lstat("/home/user/projects/other/real.txt").kind).toBe("file");
  });
});

describe("restoreFromOpfsLazy", () => {
  // Studio's own convention: /home/user/projects/<name> - 4 segments, so each project becomes
  // its own lazy unit.
  const LAZY_DEPTH = 4;

  it("restores directory structure eagerly but defers file content past the lazy boundary", async () => {
    const root = createFakeOpfsDir();
    root.seedFile("/home/user/projects/a/file.txt", "hello a");
    root.seedFile("/home/user/projects/b/file.txt", "hello b");

    const vfs = new Vfs();
    await restoreFromOpfsLazy(vfs, root, LAZY_DEPTH);

    // The shallow structure (down to, and including, each project directory) exists...
    expect(vfs.stat("/home/user/projects/a").kind).toBe("dir");
    expect(vfs.stat("/home/user/projects/b").kind).toBe("dir");
    // ...but nothing under a project has been materialized yet.
    expect(vfs.readdir("/home/user/projects/a")).toEqual([]);
    expect(vfs.exists("/home/user/projects/a/file.txt")).toBe(false);
  });

  it("ensureRestored materializes exactly the project a touched path belongs to, not others", async () => {
    const root = createFakeOpfsDir();
    root.seedFile("/home/user/projects/a/file.txt", "hello a");
    root.seedFile("/home/user/projects/b/file.txt", "hello b");

    const vfs = new Vfs();
    const lazy = await restoreFromOpfsLazy(vfs, root, LAZY_DEPTH);
    await lazy.ensureRestored(["/home/user/projects/a/file.txt"]);

    expect(decode(vfs.readFile("/home/user/projects/a/file.txt"))).toBe("hello a");
    // b is untouched - still deferred.
    expect(vfs.readdir("/home/user/projects/b")).toEqual([]);
  });

  it("ensureRestored on the project root itself (not a path under it) also materializes it", async () => {
    const root = createFakeOpfsDir();
    root.seedFile("/home/user/projects/a/file.txt", "hello a");

    const vfs = new Vfs();
    const lazy = await restoreFromOpfsLazy(vfs, root, LAZY_DEPTH);
    await lazy.ensureRestored(["/home/user/projects/a"]);

    expect(decode(vfs.readFile("/home/user/projects/a/file.txt"))).toBe("hello a");
  });

  it("a path outside every pending root is a no-op", async () => {
    const root = createFakeOpfsDir();
    root.seedFile("/home/user/projects/a/file.txt", "hello a");

    const vfs = new Vfs();
    const lazy = await restoreFromOpfsLazy(vfs, root, LAZY_DEPTH);
    await expect(lazy.ensureRestored(["/some/unrelated/path"])).resolves.toBeUndefined();
    expect(vfs.readdir("/home/user/projects/a")).toEqual([]); // still deferred
  });

  it("materializing a project a second time (concurrently, or after the fact) never re-reads OPFS and so never clobbers an in-memory edit made since", async () => {
    const root = createFakeOpfsDir();
    root.seedFile("/home/user/projects/a/file.txt", "hello a");

    const vfs = new Vfs();
    const lazy = await restoreFromOpfsLazy(vfs, root, LAZY_DEPTH);
    // Three concurrent callers, two different paths under the same root - all three must settle
    // on the one real materialization, not three independent ones.
    await Promise.all([
      lazy.ensureRestored(["/home/user/projects/a/file.txt"]),
      lazy.ensureRestored(["/home/user/projects/a/file.txt"]),
      lazy.ensureRestored(["/home/user/projects/a"]),
    ]);
    expect(decode(vfs.readFile("/home/user/projects/a/file.txt"))).toBe("hello a");

    // Simulates the user editing the file after it was materialized - OPFS itself still has the
    // OLD content (the write-behind mirror is what would normally catch this up, not modeled
    // here). A naive non-memoized ensureRestored would re-read OPFS and clobber this edit.
    vfs.writeFile("/home/user/projects/a/file.txt", new TextEncoder().encode("edited"));
    await lazy.ensureRestored(["/home/user/projects/a/file.txt"]);
    expect(decode(vfs.readFile("/home/user/projects/a/file.txt"))).toBe("edited");
  });

  it("a mutation whose OWN path CONTAINS pending roots materializes all of them (rename data-loss guard)", async () => {
    const root = createFakeOpfsDir();
    root.seedFile("/home/user/projects/a/file.txt", "hello a");
    root.seedFile("/home/user/projects/b/file.txt", "hello b");

    const vfs = new Vfs();
    const lazy = await restoreFromOpfsLazy(vfs, root, LAZY_DEPTH);
    // Simulates what OP_RENAME's own peeked path would trigger for the ancestor of both projects -
    // see FsServer.peekPendingRequest and this file's own comment on why this direction matters.
    await lazy.ensureRestored(["/home/user/projects"]);

    expect(decode(vfs.readFile("/home/user/projects/a/file.txt"))).toBe("hello a");
    expect(decode(vfs.readFile("/home/user/projects/b/file.txt"))).toBe("hello b");
  });

  it("replays a lazy project's own symlinks only once it materializes, not at boot", async () => {
    const root = createFakeOpfsDir();
    root.seedFile("/home/user/projects/a/real.txt", "real");
    root.seedFile("/__wcvm_symlinks__.json", JSON.stringify({ "/home/user/projects/a/link.txt": "/home/user/projects/a/real.txt" }));

    const vfs = new Vfs();
    const lazy = await restoreFromOpfsLazy(vfs, root, LAZY_DEPTH);
    expect(vfs.exists("/home/user/projects/a/link.txt")).toBe(false); // deferred, not a broken restore

    await lazy.ensureRestored(["/home/user/projects/a"]);
    expect(vfs.lstat("/home/user/projects/a/link.txt").kind).toBe("symlink");
    expect(decode(vfs.readFile("/home/user/projects/a/link.txt"))).toBe("real");
  });

  it("materializing a project does not re-trigger vfs.onChange for its own restored entries (no pointless OPFS round trip, no spurious watch events)", async () => {
    const root = createFakeOpfsDir();
    root.seedFile("/home/user/projects/a/file.txt", "hello a");

    const vfs = new Vfs();
    const lazy = await restoreFromOpfsLazy(vfs, root, LAZY_DEPTH);
    const onChange = vi.fn();
    vfs.onChange = onChange;

    await lazy.ensureRestored(["/home/user/projects/a/file.txt"]);
    expect(onChange).not.toHaveBeenCalled();

    // The real handler is restored afterward - a genuinely new change still reports normally.
    vfs.writeFile("/home/user/projects/a/new.txt", new TextEncoder().encode("new"));
    expect(onChange).toHaveBeenCalledWith("/home/user/projects/a/new.txt", "rename", true, false);
  });

  it("skips a corrupted/unreadable file during a project's own materialization, same per-entry resilience as restoreFromOpfs", async () => {
    const root = createFakeOpfsDir();
    root.seedFile("/home/user/projects/a/good.txt", "fine");
    root.seedFailingFile("/home/user/projects/a/bad.txt");

    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    const vfs = new Vfs();
    const lazy = await restoreFromOpfsLazy(vfs, root, LAZY_DEPTH);
    await expect(lazy.ensureRestored(["/home/user/projects/a"])).resolves.toBeUndefined();
    spy.mockRestore();

    expect(decode(vfs.readFile("/home/user/projects/a/good.txt"))).toBe("fine");
    expect(vfs.exists("/home/user/projects/a/bad.txt")).toBe(false);
  });

  describe("discardPending", () => {
    it("drops a still-pending root; a later ensureRestored for a path under it is then a no-op instead of resurrecting it", async () => {
      const root = createFakeOpfsDir();
      root.seedFile("/home/user/projects/a/file.txt", "hello a");

      const vfs = new Vfs();
      const lazy = await restoreFromOpfsLazy(vfs, root, LAZY_DEPTH);
      lazy.discardPending(["/home/user/projects/a"]);

      // Nothing left to materialize, so the project simply doesn't exist in the vfs - matching
      // what fs.rm() would do next (this is exactly the sequence handler.ts's own discardPending
      // call is followed immediately by: service() running the real vfs.rm()).
      await lazy.ensureRestored(["/home/user/projects/a/file.txt"]);
      expect(vfs.exists("/home/user/projects/a/file.txt")).toBe(false);
    });

    it("matches the SAME both-directions reach as ensureRestored - an ancestor of many pending roots discards all of them at once", async () => {
      const root = createFakeOpfsDir();
      root.seedFile("/home/user/projects/a/file.txt", "hello a");
      root.seedFile("/home/user/projects/b/file.txt", "hello b");

      const vfs = new Vfs();
      const lazy = await restoreFromOpfsLazy(vfs, root, LAZY_DEPTH);
      // Simulates OP_RM("/home", recursive) sweeping every project under it - resetFs's own
      // real-world shape (wc.fs.reset(), "Clear All").
      lazy.discardPending(["/home"]);

      await lazy.ensureRestored(["/home/user/projects/a/file.txt"]);
      await lazy.ensureRestored(["/home/user/projects/b/file.txt"]);
      expect(vfs.exists("/home/user/projects/a/file.txt")).toBe(false);
      expect(vfs.exists("/home/user/projects/b/file.txt")).toBe(false);
    });

    it("is a safe no-op for a path that isn't (or doesn't contain) any pending root", async () => {
      const root = createFakeOpfsDir();
      root.seedFile("/home/user/projects/a/file.txt", "hello a");

      const vfs = new Vfs();
      const lazy = await restoreFromOpfsLazy(vfs, root, LAZY_DEPTH);
      expect(() => lazy.discardPending(["/some/unrelated/path"])).not.toThrow();

      // "a" is still pending and still restores normally - discardPending touched nothing here.
      await lazy.ensureRestored(["/home/user/projects/a/file.txt"]);
      expect(decode(vfs.readFile("/home/user/projects/a/file.txt"))).toBe("hello a");
    });
  });
});

describe("createOpfsMirror", () => {
  const setup = () => {
    const vfs = new Vfs();
    const root = createFakeOpfsDir();
    const mirror = createOpfsMirror(vfs, root);
    // Same adaptation FsServer's own constructor does for real: onPersist only cares about
    // contentChanged and subtreeIsOnlyAnnouncement, not kind (that's watch dispatch's own concern).
    vfs.onChange = (path, _kind, contentChanged, subtreeIsOnlyAnnouncement) => {
      if (contentChanged) mirror.notify(path, subtreeIsOnlyAnnouncement);
    };
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

  it("retries a delete OPFS refuses while a writer still holds the entry, then succeeds (NoModificationAllowedError)", async () => {
    const { vfs, root } = setup();
    vfs.writeFile("/a.txt", new TextEncoder().encode("hi"));
    await flush();
    expect(root.readFileAt("/a.txt")).toBeDefined();

    const real = root.removeEntry.bind(root);
    let refusals = 2;
    const spy = vi.spyOn(root, "removeEntry").mockImplementation(async (name, options) => {
      if (refusals-- > 0) throw Object.assign(new Error("An attempt was made to modify an object where modifications are not allowed."), { name: "NoModificationAllowedError" });
      return real(name, options);
    });
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});

    vfs.unlink("/a.txt");
    await new Promise((resolve) => setTimeout(resolve, 300));

    expect(spy).toHaveBeenCalledTimes(3);
    expect(root.readFileAt("/a.txt")).toBeUndefined();
    expect(errors).not.toHaveBeenCalled();
    spy.mockRestore();
    errors.mockRestore();
  });

  it("gives up and reports a delete that stays locked, instead of retrying forever", async () => {
    const { vfs, root } = setup();
    vfs.writeFile("/a.txt", new TextEncoder().encode("hi"));
    await flush();

    const spy = vi.spyOn(root, "removeEntry").mockRejectedValue(Object.assign(new Error("locked"), { name: "NoModificationAllowedError" }));
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});

    vfs.unlink("/a.txt");
    await new Promise((resolve) => setTimeout(resolve, 1200));

    expect(spy).toHaveBeenCalledTimes(6); // the first try plus one per retry delay
    expect(errors).toHaveBeenCalledWith(expect.stringContaining("OPFS persistence failed for /a.txt"), expect.anything());
    spy.mockRestore();
    errors.mockRestore();
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

  it("caps how many OPFS writes run concurrently, even when every onChange fires in one synchronous burst (cp()'s own shape)", async () => {
    const { vfs, root, mirror } = setup();
    const originalGetFileHandle = root.getFileHandle.bind(root);
    let active = 0;
    let peak = 0;
    root.getFileHandle = async (name, options) => {
      active++;
      peak = Math.max(peak, active);
      // Long enough that a real burst of concurrent calls would overlap and be observed, short
      // enough the test stays fast.
      await new Promise((resolve) => setTimeout(resolve, 5));
      const handle = await originalGetFileHandle(name, options);
      active--;
      return handle;
    };

    // Mirrors cp()'s own shape: many onChange events fired in one synchronous loop, no per-file
    // pacing at all - exactly the burst that used to drive unbounded concurrency.
    for (let i = 0; i < 40; i++) vfs.writeFile(`/f${i}.txt`, new TextEncoder().encode("x"));
    await mirror.flush();

    expect(peak).toBeLessThanOrEqual(16);
    expect(peak).toBeGreaterThan(1); // still genuinely concurrent, not accidentally serialized
    for (let i = 0; i < 40; i++) expect(root.readFileAt(`/f${i}.txt`)).toBeDefined();
  });
});

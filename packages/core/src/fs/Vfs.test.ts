import { beforeEach, describe, expect, it } from "vitest";
import {
  O_APPEND,
  O_CREAT,
  O_EXCL,
  O_RDONLY,
  O_RDWR,
  O_TRUNC,
  O_WRONLY,
  S_IFDIR,
  S_IFLNK,
  S_IFREG,
  Vfs,
} from "./Vfs";

const bytes = (s: string) => new TextEncoder().encode(s);
const text = (b: Uint8Array) => new TextDecoder().decode(b);
const code = (fn: () => unknown) => {
  try {
    fn();
  } catch (error) {
    return (error as { code?: string }).code;
  }
  return undefined;
};

let vfs: Vfs;
beforeEach(() => {
  vfs = new Vfs();
});

describe("Vfs files and directories", () => {
  it("writes and reads a file, copying data both ways", () => {
    const input = bytes("hello");
    vfs.writeFile("/a.txt", input);
    input[0] = 0;
    const out = vfs.readFile("/a.txt");
    expect(text(out)).toBe("hello");
    out[0] = 0;
    expect(text(vfs.readFile("/a.txt"))).toBe("hello");
  });

  it("overwrites and truncates on writeFile", () => {
    vfs.writeFile("/a", bytes("long content"));
    vfs.writeFile("/a", bytes("hi"));
    expect(text(vfs.readFile("/a"))).toBe("hi");
    expect(vfs.stat("/a").size).toBe(2);
  });

  it("reports ENOENT, ENOTDIR, EISDIR and EINVAL", () => {
    vfs.writeFile("/f", bytes("x"));
    vfs.mkdir("/d");
    expect(code(() => vfs.readFile("/missing"))).toBe("ENOENT");
    expect(code(() => vfs.writeFile("/missing/x", bytes("")))).toBe("ENOENT");
    expect(code(() => vfs.readFile("/f/x"))).toBe("ENOTDIR");
    expect(code(() => vfs.readdir("/f"))).toBe("ENOTDIR");
    expect(code(() => vfs.readFile("/d"))).toBe("EISDIR");
    expect(code(() => vfs.writeFile("/d", bytes("")))).toBe("EISDIR");
    expect(code(() => vfs.stat("relative"))).toBe("EINVAL");
  });

  it("mkdir: EEXIST, and recursive creates parents idempotently", () => {
    vfs.mkdir("/a");
    expect(code(() => vfs.mkdir("/a"))).toBe("EEXIST");
    expect(code(() => vfs.mkdir("/"))).toBe("EEXIST");
    expect(code(() => vfs.mkdir("/x/y"))).toBe("ENOENT");

    vfs.mkdir("/p/q/r", { recursive: true });
    vfs.mkdir("/p/q/r", { recursive: true });
    expect(vfs.readdir("/p/q")).toEqual(["r"]);

    vfs.writeFile("/file", bytes(""));
    expect(code(() => vfs.mkdir("/file", { recursive: true }))).toBe("EEXIST");
    expect(code(() => vfs.mkdir("/file/sub", { recursive: true }))).toBe(
      "ENOTDIR",
    );
  });

  it("readdir is sorted", () => {
    for (const n of ["b", "c", "a"]) vfs.writeFile(`/${n}`, bytes(""));
    expect(vfs.readdir("/")).toEqual(["a", "b", "c"]);
  });

  it("normalizes . .. and duplicate slashes", () => {
    vfs.mkdir("/a/b", { recursive: true });
    vfs.writeFile("/a/b/f", bytes("x"));
    expect(text(vfs.readFile("//a/./b/../b//f"))).toBe("x");
    expect(vfs.readdir("/a/b/../..")).toEqual(["a"]);
  });

  it("stat reports type bits, size and nlink", () => {
    vfs.writeFile("/f", bytes("abc"), { mode: 0o600 });
    vfs.mkdir("/d");
    vfs.symlink("/f", "/l");
    expect(vfs.stat("/f")).toMatchObject({
      kind: "file",
      size: 3,
      mode: S_IFREG | 0o600,
    });
    expect(vfs.stat("/d").mode & S_IFDIR).toBe(S_IFDIR);
    expect(vfs.lstat("/l").mode & S_IFLNK).toBe(S_IFLNK);
    expect(vfs.stat("/l").kind).toBe("file");
  });

  it("chmod changes permission bits only", () => {
    vfs.writeFile("/f", bytes(""));
    vfs.chmod("/f", 0o755);
    expect(vfs.stat("/f").mode).toBe(S_IFREG | 0o755);
  });
});

describe("Vfs removal", () => {
  it("unlink removes files but not directories", () => {
    vfs.writeFile("/f", bytes(""));
    vfs.mkdir("/d");
    vfs.unlink("/f");
    expect(vfs.exists("/f")).toBe(false);
    expect(code(() => vfs.unlink("/d"))).toBe("EISDIR");
    expect(code(() => vfs.unlink("/f"))).toBe("ENOENT");
  });

  it("rmdir requires an empty directory", () => {
    vfs.mkdir("/d/e", { recursive: true });
    vfs.writeFile("/f", bytes(""));
    expect(code(() => vfs.rmdir("/d"))).toBe("ENOTEMPTY");
    expect(code(() => vfs.rmdir("/f"))).toBe("ENOTDIR");
    expect(code(() => vfs.rmdir("/"))).toBe("EBUSY");
    vfs.rmdir("/d/e");
    vfs.rmdir("/d");
    expect(vfs.exists("/d")).toBe(false);
  });

  it("rm needs recursive for directories and refuses the root", () => {
    vfs.mkdir("/d/e", { recursive: true });
    vfs.writeFile("/d/e/f", bytes(""));
    expect(code(() => vfs.rm("/d"))).toBe("EISDIR");
    vfs.rm("/d", { recursive: true });
    expect(vfs.exists("/d")).toBe(false);
    expect(code(() => vfs.rm("/", { recursive: true }))).toBe("EBUSY");
    expect(code(() => vfs.rm("/gone"))).toBe("ENOENT");
  });
});

describe("Vfs rename", () => {
  it("moves files and directories, keeping contents", () => {
    vfs.mkdir("/a");
    vfs.writeFile("/a/f", bytes("x"));
    vfs.rename("/a", "/b");
    expect(vfs.exists("/a")).toBe(false);
    expect(text(vfs.readFile("/b/f"))).toBe("x");
  });

  it("replaces an existing file and an empty directory", () => {
    vfs.writeFile("/a", bytes("new"));
    vfs.writeFile("/b", bytes("old"));
    vfs.rename("/a", "/b");
    expect(text(vfs.readFile("/b"))).toBe("new");

    vfs.mkdir("/d1");
    vfs.mkdir("/d2");
    vfs.rename("/d1", "/d2");
    expect(vfs.readdir("/")).toEqual(["b", "d2"]);
  });

  it("rejects type mismatches, non-empty targets, and moving into itself", () => {
    vfs.writeFile("/f", bytes(""));
    vfs.mkdir("/d/sub", { recursive: true });
    vfs.mkdir("/e");
    vfs.writeFile("/e/x", bytes(""));
    expect(code(() => vfs.rename("/f", "/d"))).toBe("EISDIR");
    expect(code(() => vfs.rename("/d", "/f"))).toBe("ENOTDIR");
    expect(code(() => vfs.rename("/d", "/e"))).toBe("ENOTEMPTY");
    expect(code(() => vfs.rename("/d", "/d/sub/inner"))).toBe("EINVAL");
    expect(code(() => vfs.rename("/nope", "/x"))).toBe("ENOENT");
    expect(code(() => vfs.rename("/f", "/no/such/x"))).toBe("ENOENT");
  });

  it("is a no-op when source and target are the same", () => {
    vfs.writeFile("/f", bytes("x"));
    vfs.rename("/f", "/f");
    expect(text(vfs.readFile("/f"))).toBe("x");
  });
});

describe("Vfs symlinks", () => {
  it("follows absolute and relative links, and readlink returns the raw target", () => {
    vfs.mkdir("/real");
    vfs.writeFile("/real/f", bytes("x"));
    vfs.symlink("/real", "/abs");
    vfs.symlink("real/f", "/rel");
    expect(text(vfs.readFile("/abs/f"))).toBe("x");
    expect(text(vfs.readFile("/rel"))).toBe("x");
    expect(vfs.readlink("/rel")).toBe("real/f");
    expect(code(() => vfs.readlink("/real"))).toBe("EINVAL");
  });

  it("resolves .. physically after a symlink", () => {
    vfs.mkdir("/a/b", { recursive: true });
    vfs.mkdir("/other");
    vfs.writeFile("/a/marker", bytes("A"));
    vfs.writeFile("/other/marker", bytes("O"));
    vfs.symlink("/a/b", "/other/link");
    expect(text(vfs.readFile("/other/link/../marker"))).toBe("A");
  });

  it("realpath resolves links; dangling links are ENOENT; loops are ELOOP", () => {
    vfs.mkdir("/d");
    vfs.writeFile("/d/f", bytes(""));
    vfs.symlink("/d", "/l");
    expect(vfs.realpath("/l/f")).toBe("/d/f");
    expect(vfs.realpath("/l")).toBe("/d");
    expect(vfs.realpath("/")).toBe("/");

    vfs.symlink("/nowhere", "/dangling");
    expect(code(() => vfs.readFile("/dangling"))).toBe("ENOENT");
    expect(vfs.lstat("/dangling").kind).toBe("symlink");

    vfs.symlink("/loop2", "/loop1");
    vfs.symlink("/loop1", "/loop2");
    expect(code(() => vfs.readFile("/loop1"))).toBe("ELOOP");
  });

  it("unlink removes the link, not its target", () => {
    vfs.writeFile("/f", bytes("x"));
    vfs.symlink("/f", "/l");
    vfs.unlink("/l");
    expect(vfs.exists("/l")).toBe(false);
    expect(vfs.exists("/f")).toBe(true);
  });

  it("symlink refuses an existing path", () => {
    vfs.writeFile("/f", bytes(""));
    expect(code(() => vfs.symlink("/x", "/f"))).toBe("EEXIST");
  });
});

describe("Vfs file descriptors", () => {
  it("open with O_CREAT creates; without it is ENOENT; O_EXCL is EEXIST", () => {
    expect(code(() => vfs.open("/f", O_RDONLY))).toBe("ENOENT");
    const fd = vfs.open("/f", O_WRONLY | O_CREAT);
    vfs.close(fd);
    expect(vfs.exists("/f")).toBe(true);
    expect(code(() => vfs.open("/f", O_WRONLY | O_CREAT | O_EXCL))).toBe(
      "EEXIST",
    );
  });

  it("allocates the lowest free descriptor from 3", () => {
    vfs.writeFile("/f", bytes(""));
    const a = vfs.open("/f", O_RDONLY);
    const b = vfs.open("/f", O_RDONLY);
    expect([a, b]).toEqual([3, 4]);
    vfs.close(a);
    expect(vfs.open("/f", O_RDONLY)).toBe(3);
  });

  it("cursor reads advance; positional reads do not", () => {
    vfs.writeFile("/f", bytes("abcdef"));
    const fd = vfs.open("/f", O_RDONLY);
    expect(text(vfs.read(fd, 2, -1))).toBe("ab");
    expect(text(vfs.read(fd, 2, -1))).toBe("cd");
    expect(text(vfs.read(fd, 2, 0))).toBe("ab");
    expect(text(vfs.read(fd, 2, -1))).toBe("ef");
    expect(vfs.read(fd, 2, -1)).toHaveLength(0);
  });

  it("writes at the cursor, positionally, and zero-fills gaps", () => {
    const fd = vfs.open("/f", O_RDWR | O_CREAT);
    vfs.write(fd, bytes("ab"), -1);
    vfs.write(fd, bytes("cd"), -1);
    vfs.write(fd, bytes("X"), 1);
    expect(text(vfs.readFile("/f"))).toBe("aXcd");
    vfs.write(fd, bytes("z"), 6);
    expect(Array.from(vfs.readFile("/f"))).toEqual([97, 88, 99, 100, 0, 0, 122]);
  });

  it("O_APPEND appends regardless of position; O_TRUNC empties", () => {
    vfs.writeFile("/f", bytes("abc"));
    const fd = vfs.open("/f", O_WRONLY | O_APPEND);
    vfs.write(fd, bytes("d"), 0);
    vfs.write(fd, bytes("e"), -1);
    vfs.close(fd);
    expect(text(vfs.readFile("/f"))).toBe("abcde");

    vfs.close(vfs.open("/f", O_WRONLY | O_TRUNC));
    expect(vfs.stat("/f").size).toBe(0);
  });

  it("enforces access modes and rejects bad descriptors", () => {
    vfs.writeFile("/f", bytes("x"));
    const ro = vfs.open("/f", O_RDONLY);
    const wo = vfs.open("/f", O_WRONLY);
    expect(code(() => vfs.write(ro, bytes("y"), -1))).toBe("EBADF");
    expect(code(() => vfs.read(wo, 1, -1))).toBe("EBADF");
    expect(code(() => vfs.read(99, 1, -1))).toBe("EBADF");
    expect(code(() => vfs.close(99))).toBe("EBADF");
    vfs.close(ro);
    expect(code(() => vfs.read(ro, 1, -1))).toBe("EBADF");
  });

  it("directories open read-only and read as EISDIR; writing is EISDIR", () => {
    vfs.mkdir("/d");
    expect(code(() => vfs.open("/d", O_WRONLY))).toBe("EISDIR");
    const fd = vfs.open("/d", O_RDONLY);
    expect(code(() => vfs.read(fd, 1, -1))).toBe("EISDIR");
  });

  it("fstat and ftruncate work, and truncate-then-grow exposes zeros", () => {
    const fd = vfs.open("/f", O_RDWR | O_CREAT);
    vfs.write(fd, bytes("abcdef"), -1);
    vfs.ftruncate(fd, 2);
    expect(vfs.fstat(fd).size).toBe(2);
    vfs.ftruncate(fd, 4);
    expect(Array.from(vfs.readFile("/f"))).toEqual([97, 98, 0, 0]);
  });

  it("an open descriptor keeps working after the file is unlinked", () => {
    vfs.writeFile("/f", bytes("data"));
    const fd = vfs.open("/f", O_RDONLY);
    vfs.unlink("/f");
    expect(text(vfs.read(fd, 10, -1))).toBe("data");
  });
});

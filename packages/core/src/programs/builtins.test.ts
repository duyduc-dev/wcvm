import { beforeEach, describe, expect, it } from "vitest";
import { createLoopbackFs } from "../testing/loopbackFs";
import type { IStdinHost } from "../runtime/runtime";
import { resolveProgram } from ".";

/** A stdin host the test drives directly, like the process worker would. */
const createFakeStdin = () => {
  let handler: ((chunk: Uint8Array | null) => void) | null = null;
  const host: IStdinHost = {
    onData: (h) => {
      handler = h;
    },
  };
  return { host, push: (chunk: Uint8Array | null) => handler?.(chunk) };
};

const setup = () => {
  const { fs, vfs } = createLoopbackFs();
  const sleeps: number[] = [];
  const run = async (command: string, args: string[], cwd = "/", stdin?: IStdinHost) => {
    const out: string[] = [];
    const err: string[] = [];
    const program = resolveProgram(command)!;
    const status = await program({
      args,
      cwd,
      env: {},
      fs,
      pid: 1,
      stdout: (d) =>
        out.push(typeof d === "string" ? d : new TextDecoder().decode(d)),
      stderr: (t) =>
        err.push(typeof t === "string" ? t : new TextDecoder().decode(t)),
      sleep: async (ms) => {
        sleeps.push(ms);
      },
      stdin,
    });
    return { status, out: out.join(""), err: err.join("") };
  };
  return { fs, vfs, run, sleeps };
};

let t: ReturnType<typeof setup>;
beforeEach(() => {
  t = setup();
});

describe("resolveProgram", () => {
  it("finds built-ins by name or /bin path, and nothing else", () => {
    expect(resolveProgram("echo")).toBeDefined();
    expect(resolveProgram("/bin/echo")).toBe(resolveProgram("echo"));
    expect(resolveProgram("nope")).toBeUndefined();
    expect(resolveProgram("/usr/bin/echo")).toBeUndefined();
    expect(resolveProgram("toString")).toBeUndefined();
    expect(resolveProgram("__proto__")).toBeUndefined();
  });
});

describe("echo / pwd / true / false", () => {
  it("echo joins args; -n drops the newline", async () => {
    expect((await t.run("echo", ["Hello,", "World!"])).out).toBe("Hello, World!\n");
    expect((await t.run("echo", [])).out).toBe("\n");
  });

  it("echo -n drops the newline", async () => {
    expect((await t.run("echo", ["-n", "a", "b"])).out).toBe("a b");
  });

  it("pwd prints the working directory", async () => {
    expect((await t.run("pwd", [], "/some/dir")).out).toBe("/some/dir\n");
  });

  it("true and false set the exit status", async () => {
    expect((await t.run("true", [])).status).toBe(0);
    expect((await t.run("false", [])).status).toBe(1);
  });
});

describe("cat", () => {
  it("prints files in order, resolving relative paths against cwd", async () => {
    t.fs.mkdir("/w");
    t.fs.writeFile("/w/a", "A");
    t.fs.writeFile("/b", "B");
    const r = await t.run("cat", ["a", "/b"], "/w");
    expect(r).toMatchObject({ status: 0, out: "AB" });
  });

  it("reports each failure and keeps going", async () => {
    t.fs.writeFile("/ok", "x");
    t.fs.mkdir("/d");
    const r = await t.run("cat", ["/missing", "/ok", "/d"]);
    expect(r.status).toBe(1);
    expect(r.out).toBe("x");
    expect(r.err).toContain("cat: /missing: No such file or directory");
    expect(r.err).toContain("cat: /d: Is a directory");
  });

  it("with no args and no stdin host, acts like reading an already-closed stdin", async () => {
    const r = await t.run("cat", []);
    expect(r).toMatchObject({ status: 0, out: "" });
  });

  it("with no args, streams stdin to stdout until it ends", async () => {
    const stdin = createFakeStdin();
    const done = t.run("cat", [], "/", stdin.host);
    stdin.push(new TextEncoder().encode("hello "));
    stdin.push(new TextEncoder().encode("world"));
    stdin.push(null);
    expect(await done).toMatchObject({ status: 0, out: "hello world" });
  });

  it("streams binary content unchanged", async () => {
    t.fs.writeFile("/bin", new Uint8Array([0, 1, 2, 255]));
    const chunks: Uint8Array[] = [];
    const status = await resolveProgram("cat")!({
      args: ["/bin"],
      cwd: "/",
      env: {},
      fs: t.fs,
      pid: 1,
      stdout: (d) => chunks.push(d as Uint8Array),
      stderr: () => {},
      sleep: async () => {},
    });
    expect(status).toBe(0);
    expect(Array.from(chunks[0])).toEqual([0, 1, 2, 255]);
  });
});

describe("ls", () => {
  beforeEach(() => {
    t.fs.mkdir("/d");
    t.fs.writeFile("/d/b", "");
    t.fs.writeFile("/d/a", "");
    t.fs.writeFile("/d/.hidden", "");
  });

  it("lists a directory sorted, hiding dotfiles unless -a", async () => {
    expect((await t.run("ls", ["/d"])).out).toBe("a\nb\n");
    expect((await t.run("ls", ["-a", "/d"])).out).toBe(".hidden\na\nb\n");
  });

  it("defaults to the working directory", async () => {
    expect((await t.run("ls", [], "/d")).out).toBe("a\nb\n");
  });

  it("prints a file operand as-is", async () => {
    expect((await t.run("ls", ["/d/a"])).out).toBe("/d/a\n");
  });

  it("labels each directory when given several", async () => {
    t.fs.mkdir("/e");
    t.fs.writeFile("/e/z", "");
    expect((await t.run("ls", ["/d", "/e"])).out).toBe("/d:\na\nb\n\n/e:\nz\n");
  });

  it("exits 2 for a missing path but still lists the rest", async () => {
    const r = await t.run("ls", ["/nope", "/d"]);
    expect(r.status).toBe(2);
    expect(r.err).toContain("ls: cannot access '/nope': No such file or directory");
    expect(r.out).toContain("a\nb\n");
  });
});

describe("mkdir", () => {
  it("creates directories; -p makes parents and tolerates existing", async () => {
    expect((await t.run("mkdir", ["/a"])).status).toBe(0);
    expect((await t.run("mkdir", ["-p", "/x/y/z", "/a"])).status).toBe(0);
    expect(t.vfs.exists("/x/y/z")).toBe(true);
  });

  it("fails clearly without -p", async () => {
    t.fs.mkdir("/a");
    const exists = await t.run("mkdir", ["/a"]);
    expect(exists.status).toBe(1);
    expect(exists.err).toBe("mkdir: cannot create directory '/a': File exists\n");
    expect((await t.run("mkdir", ["/p/q"])).err).toContain("No such file or directory");
    expect((await t.run("mkdir", [])).err).toBe("mkdir: missing operand\n");
  });

  it("resolves relative paths against cwd", async () => {
    t.fs.mkdir("/w");
    await t.run("mkdir", ["sub"], "/w");
    expect(t.vfs.exists("/w/sub")).toBe(true);
  });
});

describe("rm", () => {
  it("removes files; refuses directories without -r", async () => {
    t.fs.writeFile("/f", "");
    t.fs.mkdir("/d/e", { recursive: true });
    expect((await t.run("rm", ["/f"])).status).toBe(0);
    expect(t.vfs.exists("/f")).toBe(false);

    const r = await t.run("rm", ["/d"]);
    expect(r.status).toBe(1);
    expect(r.err).toBe("rm: cannot remove '/d': Is a directory\n");
    expect((await t.run("rm", ["-r", "/d"])).status).toBe(0);
    expect(t.vfs.exists("/d")).toBe(false);
  });

  it("-f ignores missing operands and a bare -f is fine; otherwise errors", async () => {
    expect((await t.run("rm", ["-f", "/nope"])).status).toBe(0);
    expect((await t.run("rm", ["-f"])).status).toBe(0);
    expect((await t.run("rm", ["/nope"])).err).toContain("No such file or directory");
    expect((await t.run("rm", [])).err).toBe("rm: missing operand\n");
  });

  it("accepts combined flags and refuses the root", async () => {
    t.fs.mkdir("/d");
    expect((await t.run("rm", ["-rf", "/d"])).status).toBe(0);
    const r = await t.run("rm", ["-rf", "/"]);
    expect(r.status).toBe(1);
    expect(r.err).toContain("Device or resource busy");
    expect(t.vfs.exists("/")).toBe(true);
  });

  it("-- ends flag parsing", async () => {
    t.fs.writeFile("/-r", "");
    expect((await t.run("rm", ["--", "/-r"])).status).toBe(0);
  });
});

describe("sleep", () => {
  it("waits the requested seconds via the injected timer", async () => {
    const r = await t.run("sleep", ["1.5"]);
    expect(r.status).toBe(0);
    expect(t.sleeps).toEqual([1500]);
  });

  it("rejects bad intervals", async () => {
    for (const args of [[], ["abc"], ["-1"], ["1", "2"]]) {
      const r = await t.run("sleep", args);
      expect(r.status).toBe(1);
      expect(r.err).toContain("invalid time interval");
    }
    expect(t.sleeps).toEqual([]);
  });
});


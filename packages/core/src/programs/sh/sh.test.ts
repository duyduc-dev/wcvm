import { beforeEach, describe, expect, it } from "vitest";
import { createLoopbackFs } from "../../testing/loopbackFs";
import type { IStdinHost } from "../../runtime/runtime";
import { sh } from "./sh";

const setup = () => {
  const { fs, vfs } = createLoopbackFs();
  const run = async (args: string[], cwd = "/", stdin?: IStdinHost) => {
    const out: string[] = [];
    const err: string[] = [];
    const status = await sh({
      args,
      cwd,
      env: {},
      fs,
      pid: 1,
      stdout: (d) => out.push(typeof d === "string" ? d : new TextDecoder().decode(d)),
      stderr: (d) => err.push(typeof d === "string" ? d : new TextDecoder().decode(d)),
      sleep: async () => {},
      stdin,
    });
    return { status, out: out.join(""), err: err.join("") };
  };
  const sh1 = (script: string, cwd = "/", stdin?: IStdinHost) => run(["-c", script], cwd, stdin);
  return { fs, vfs, run, sh: sh1 };
};

let t: ReturnType<typeof setup>;
beforeEach(() => {
  t = setup();
});

describe("sh -c", () => {
  it("runs a single built-in", async () => {
    expect(await t.sh("echo hello world")).toMatchObject({ status: 0, out: "hello world\n" });
  });

  it("sequences with ;, regardless of exit status", async () => {
    const r = await t.sh("false; echo a; echo b");
    expect(r).toMatchObject({ status: 0, out: "a\nb\n" });
  });

  it("&& only runs the next pipeline on success", async () => {
    expect(await t.sh("true && echo yes")).toMatchObject({ status: 0, out: "yes\n" });
    expect(await t.sh("false && echo yes")).toMatchObject({ status: 1, out: "" });
  });

  it("|| only runs the next pipeline on failure", async () => {
    expect(await t.sh("false || echo fallback")).toMatchObject({ status: 0, out: "fallback\n" });
    expect(await t.sh("true || echo fallback")).toMatchObject({ status: 0, out: "" });
  });

  it("chains && and || with short-circuiting, matching a real shell", async () => {
    expect(await t.sh("false && true || echo ok")).toMatchObject({ status: 0, out: "ok\n" });
  });

  it("the whole script's exit status is that of the last pipeline that actually ran", async () => {
    expect((await t.sh("true; false")).status).toBe(1);
    expect((await t.sh("false && echo skipped")).status).toBe(1);
  });

  it("pipes one command's stdout into the next's stdin", async () => {
    t.fs.writeFile("/a.txt", "hello world");
    const r = await t.sh("cat /a.txt | cat");
    expect(r).toMatchObject({ status: 0, out: "hello world" });
  });

  it("a three-stage pipeline threads data through every stage", async () => {
    t.fs.mkdir("/d");
    t.fs.writeFile("/d/one", "1");
    const r = await t.sh("ls /d | cat | cat");
    expect(r).toMatchObject({ status: 0, out: "one\n" });
  });

  it("> writes stdout to a file instead of the outer output; >> appends", async () => {
    const r1 = await t.sh("echo one > /out.txt");
    expect(r1).toMatchObject({ status: 0, out: "" });
    expect(new TextDecoder().decode(t.fs.readFile("/out.txt"))).toBe("one\n");

    await t.sh("echo two >> /out.txt");
    expect(new TextDecoder().decode(t.fs.readFile("/out.txt"))).toBe("one\ntwo\n");
  });

  it("< feeds a file's contents to the command as stdin", async () => {
    t.fs.writeFile("/in.txt", "piped in");
    const r = await t.sh("cat < /in.txt");
    expect(r).toMatchObject({ status: 0, out: "piped in" });
  });

  it("cd changes the shell's own cwd for the rest of the script", async () => {
    t.fs.mkdir("/w");
    t.fs.writeFile("/w/f", "x");
    const r = await t.sh("cd /w && ls");
    expect(r).toMatchObject({ status: 0, out: "f\n" });
  });

  it("cd to a missing or non-directory path fails without changing cwd", async () => {
    t.fs.writeFile("/file", "x");
    const r = await t.sh("cd /nope; cd /file; pwd");
    expect(r.status).toBe(0);
    expect(r.out).toBe("/\n");
    expect(r.err).toContain("cd: /nope:");
    expect(r.err).toContain("cd: /file:");
  });

  it("reports command not found as exit 127", async () => {
    const r = await t.sh("this-is-not-a-command");
    expect(r.status).toBe(127);
    expect(r.err).toContain("this-is-not-a-command: command not found");
  });

  it("a syntax error is reported and exits 2, without running anything", async () => {
    const r = await t.sh("echo a |");
    expect(r.status).toBe(2);
    expect(r.err).toContain("sh:");
  });

  it("sh can invoke itself", async () => {
    const r = await t.sh(`sh -c "echo nested"`);
    expect(r).toMatchObject({ status: 0, out: "nested\n" });
  });

  it("runs node as an ordinary command, sequenced and piped like any other", async () => {
    const r = await t.sh(`node -e "console.log(1 + 1)" && echo done | cat`);
    expect(r).toMatchObject({ status: 0, out: "2\ndone\n" });
  });
});

describe("sh <file>", () => {
  it("reads and runs a script file, resolved against cwd", async () => {
    t.fs.mkdir("/app");
    t.fs.writeFile("/app/build.sh", "echo building; echo done");
    const r = await t.run(["build.sh"], "/app");
    expect(r).toMatchObject({ status: 0, out: "building\ndone\n" });
  });

  it("a missing script file is exit 127", async () => {
    const r = await t.run(["/nope.sh"]);
    expect(r.status).toBe(127);
  });
});

describe("sh with no script", () => {
  it("refuses an interactive REPL", async () => {
    const r = await t.run([]);
    expect(r.status).toBe(2);
    expect(r.err).toContain("interactive REPL is not supported");
  });
});

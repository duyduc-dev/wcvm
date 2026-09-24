import { describe, expect, it } from "vitest";
import { createLoopbackFs } from "../../testing/loopbackFs";
import { runProcess } from "./run";

const run = async (
  command: string,
  args: string[] = [],
  options: { cwd?: string; fs?: ReturnType<typeof createLoopbackFs>["fs"] } = {},
) => {
  const loop = createLoopbackFs();
  const fs = options.fs ?? loop.fs;
  const out: string[] = [];
  const err: string[] = [];
  const code = await runProcess({
    command,
    args,
    cwd: options.cwd ?? "/",
    env: {},
    fs,
    write: (stream, chunk) =>
      (stream === "stdout" ? out : err).push(new TextDecoder().decode(chunk)),
    sleep: async () => {},
  });
  return { code, out: out.join(""), err: err.join("") };
};

describe("runProcess", () => {
  it("runs a built-in and returns its status", async () => {
    expect(await run("echo", ["hi"])).toEqual({ code: 0, out: "hi\n", err: "" });
    expect((await run("false")).code).toBe(1);
  });

  it("exits 127 with a message for an unknown command", async () => {
    expect(await run("nonesuch")).toEqual({
      code: 127,
      out: "",
      err: "wcvm: command not found: nonesuch\n",
    });
  });

  it("exits 1 when the working directory does not exist or is a file", async () => {
    const missing = await run("pwd", [], { cwd: "/nope" });
    expect(missing.code).toBe(1);
    expect(missing.err).toContain("cannot change directory to '/nope'");

    const { fs } = createLoopbackFs();
    fs.writeFile("/file", "");
    expect((await run("pwd", [], { cwd: "/file", fs })).code).toBe(1);
  });

  it("turns an unexpected throw into exit 1 instead of crashing the worker", async () => {
    const { fs } = createLoopbackFs();
    const err: string[] = [];
    const code = await runProcess({
      command: "echo",
      args: ["x"],
      cwd: "/",
      env: {},
      fs,
      write: (stream, chunk) => {
        if (stream === "stdout") throw new Error("pipe closed");
        err.push(new TextDecoder().decode(chunk));
      },
      sleep: async () => {},
    });
    expect(code).toBe(1);
    expect(err.join("")).toBe("echo: pipe closed\n");
  });

  it("sees files the host wrote before it started", async () => {
    const { fs } = createLoopbackFs();
    fs.writeFile("/note.txt", "from the host");
    expect((await run("cat", ["/note.txt"], { fs })).out).toBe("from the host");
  });
});

describe("the node command", () => {
  const runNode = async (args: string[], files: Record<string, string> = {}, cwd = "/") => {
    const { fs } = createLoopbackFs();
    for (const [path, contents] of Object.entries(files)) {
      fs.mkdir(path.slice(0, path.lastIndexOf("/")) || "/", { recursive: true });
      fs.writeFile(path, contents);
    }
    const out: string[] = [];
    const err: string[] = [];
    const code = await runProcess({
      command: "node",
      args,
      cwd,
      env: { HOME: "/home/u" },
      fs,
      pid: 7,
      write: (stream, chunk) =>
        (stream === "stdout" ? out : err).push(new TextDecoder().decode(chunk)),
      sleep: async () => {},
    });
    return { code, out: out.join(""), err: err.join("") };
  };

  it("runs a script relative to the cwd and passes arguments and pid through", async () => {
    const r = await runNode(["main.js", "a", "b"], {
      "/w/main.js": `console.log(process.argv.slice(2).join("+"), process.pid, process.env.HOME, process.cwd())`,
    }, "/w");
    expect(r).toEqual({ code: 0, out: "a+b 7 /home/u /w\n", err: "" });
  }, 20_000); // boots a whole Node runtime: ~2s alone, occasionally past 5s under full-suite load

  it("node -e runs source text and require resolves from the cwd", async () => {
    const r = await runNode(["-e", "console.log(require('./x'), __filename)"], { "/w/x.js": "module.exports = 'x!'" }, "/w");
    expect(r).toEqual({ code: 0, out: "x! [eval]\n", err: "" });
  });

  it("returns the script's exit code and prints uncaught errors", async () => {
    expect((await runNode(["-e", "process.exit(6)"])).code).toBe(6);
    const r = await runNode(["-e", "throw new Error('kaboom')"]);
    expect(r.code).toBe(1);
    expect(r.err).toContain("Error: kaboom");
  });

  it("fails cleanly for a missing script or a bad option", async () => {
    const missing = await runNode(["nope.js"]);
    expect(missing.code).toBe(1);
    expect(missing.err).toContain("Cannot find module");
    expect((await runNode(["--bogus"])).code).toBe(9);
    expect((await runNode(["-e"])).code).toBe(9);
  });

  it("with no arguments and no stdin, starts a REPL that exits cleanly on immediate EOF", async () => {
    expect(await runNode([])).toEqual({ code: 0, out: "> ", err: "" });
  });

  it("node --version prints the vendored Node version", async () => {
    expect(await runNode(["--version"])).toEqual({ code: 0, out: "v24.18.0\n", err: "" });
  });
});

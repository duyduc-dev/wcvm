import { describe, expect, it } from "vitest";
import type { ChildProcessEvent, IChildProcessHost } from "./bindings/childProcess";
import { runScript } from "./harness";

/** Simulates the kernel: reacts to spawn()/kill() by scheduling events on a microtask. */
const createFakeHost = () => {
  let handler: ((event: ChildProcessEvent) => void) | null = null;
  const spawns: Array<{ childPid: number; command: string; args: string[]; cwd: string | undefined; env: Record<string, string> | undefined }> = [];
  const kills: Array<{ childPid: number; signal: string | undefined }> = [];
  let onSpawn: ((childPid: number) => void) | undefined;
  let onKill: ((childPid: number, signal: string | undefined) => void) | undefined;

  const host: IChildProcessHost = {
    spawn: (childPid, command, args, cwd, env) => {
      spawns.push({ childPid, command, args, cwd, env });
      onSpawn?.(childPid);
    },
    kill: (childPid, signal) => {
      kills.push({ childPid, signal });
      onKill?.(childPid, signal);
    },
    onEvent: (h) => {
      handler = h;
    },
  };
  const emit = (event: ChildProcessEvent) => queueMicrotask(() => handler?.(event));
  return {
    host,
    spawns,
    kills,
    emit,
    onSpawn: (fn: (childPid: number) => void) => (onSpawn = fn),
    onKill: (fn: (childPid: number, signal: string | undefined) => void) => (onKill = fn),
  };
};

const run = (source: string, host: IChildProcessHost) =>
  runScript({ "/app/main.js": source }, "/app/main.js", { cwd: "/app", childProcess: host });

describe("child_process over a fake kernel host", () => {
  it("spawn() delivers stdout, stderr and a clean exit", async () => {
    const fake = createFakeHost();
    fake.onSpawn((childPid) => {
      fake.emit({ type: "data", childPid, stream: "stdout", chunk: new TextEncoder().encode("out\n") });
      fake.emit({ type: "data", childPid, stream: "stderr", chunk: new TextEncoder().encode("err\n") });
      fake.emit({ type: "exit", childPid, exitCode: 0 });
    });

    const r = await run(
      `
      const { spawn } = require("child_process");
      const child = spawn("echo", ["hi"]);
      let out = "", err = "";
      child.stdout.on("data", (c) => { out += c; });
      child.stderr.on("data", (c) => { err += c; });
      child.on("exit", (code, signal) => console.log(JSON.stringify({ code, signal, out, err, pid: typeof child.pid })));
      `,
      fake.host,
    );

    expect(fake.spawns).toEqual([{ childPid: fake.spawns[0].childPid, command: "echo", args: ["hi"], cwd: undefined, env: {} }]);
    expect(JSON.parse(r.stdout)).toEqual({ code: 0, signal: null, out: "out\n", err: "err\n", pid: "number" });
    expect(r.code).toBe(0);
  });

  it("routes command/args/cwd/env through to the host, argv0 stripped", async () => {
    const fake = createFakeHost();
    fake.onSpawn((childPid) => fake.emit({ type: "exit", childPid, exitCode: 0 }));

    await run(`require("child_process").spawn("node", ["-e", "1"], { cwd: "/app", env: { FOO: "bar" } });`, fake.host);

    expect(fake.spawns).toEqual([{ childPid: fake.spawns[0].childPid, command: "node", args: ["-e", "1"], cwd: "/app", env: { FOO: "bar" } }]);
  });

  it("child.kill() reaches the host and 'exit' reports the signal", async () => {
    const fake = createFakeHost();
    fake.onKill((childPid, signal) => fake.emit({ type: "exit", childPid, exitCode: 137, signal: signal as "SIGKILL" }));

    const r = await run(
      `
      const { spawn } = require("child_process");
      const child = spawn("sleep", ["9"]);
      child.on("exit", (code, signal) => console.log(code, signal));
      child.kill("SIGKILL");
      `,
      fake.host,
    );

    const childPid = fake.spawns[0].childPid;
    expect(fake.kills).toEqual([{ childPid, signal: "SIGKILL" }]);
    expect(r.stdout).toBe("null SIGKILL\n");
    expect(r.code).toBe(0);
  });

  it("writing to child.stdin fails loudly instead of silently dropping bytes", async () => {
    const fake = createFakeHost();
    fake.onSpawn((childPid) => fake.emit({ type: "exit", childPid, exitCode: 0 }));

    const r = await run(
      `
      const { spawn } = require("child_process");
      const child = spawn("cat", []);
      child.stdin.on("error", (e) => console.log("stdin error:", e.code));
      child.stdin.write("hello");
      `,
      fake.host,
    );
    expect(r.stdout).toContain("stdin error: ENOSYS");
  });
});

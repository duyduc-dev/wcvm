import { describe, expect, it } from "vitest";
import type { ChildProcessEvent, IChildProcessHost, IForkIpcHost } from "./bindings/childProcess";
import { runScript } from "./harness";

const encoder = new TextEncoder();
const decoder = new TextDecoder();

/** A "json" mode ipc frame is `JSON.stringify(message) + "\n"` - see
 *  internal/child_process/serialization.js's `json.writeChannelMessage`. */
const frame = (message: unknown) => encoder.encode(`${JSON.stringify(message)}\n`);

describe("fork() - parent side", () => {
  /** Simulates the kernel: reacts to spawn()/ipc writes, and can push data back as if from the child. */
  const createFakeHost = () => {
    let handler: ((event: ChildProcessEvent) => void) | null = null;
    const spawns: Array<{ childPid: number; command: string; args: string[]; ipc: boolean | undefined }> = [];
    const ipcWrites: Array<{ childPid: number; chunk: Uint8Array }> = [];
    const host: IChildProcessHost = {
      spawn: (childPid, command, args, _cwd, _env, ipc) => spawns.push({ childPid, command, args, ipc }),
      kill: () => {},
      writeStdin: () => {},
      endStdin: () => {},
      writeIpc: (childPid, chunk) => ipcWrites.push({ childPid, chunk }),
      endIpc: () => {},
      onEvent: (h) => {
        handler = h;
      },
    };
    const emit = (event: ChildProcessEvent) => queueMicrotask(() => handler?.(event));
    return { host, spawns, ipcWrites, emit };
  };

  const run = (source: string, host: IChildProcessHost) => runScript({ "/app/main.js": source }, "/app/main.js", { cwd: "/app", childProcess: host });

  it("fork() spawns node with the module path as an argument, and an ipc channel", async () => {
    const fake = createFakeHost();
    fake.host.spawn = (childPid, command, args, _cwd, _env, ipc) => {
      fake.spawns.push({ childPid, command, args, ipc });
      fake.emit({ type: "exit", childPid, exitCode: 0 }); // let the parent script finish
    };

    await run(`require("child_process").fork("/child.js", ["a"], { silent: true });`, fake.host);

    expect(fake.spawns).toEqual([{ childPid: fake.spawns[0].childPid, command: "/bin/node", args: ["/child.js", "a"], ipc: true }]);
  });

  it("child.send() writes a newline-framed JSON message to the ipc channel", async () => {
    const fake = createFakeHost();
    fake.host.spawn = (childPid, command, args, _cwd, _env, ipc) => {
      fake.spawns.push({ childPid, command, args, ipc });
      fake.emit({ type: "exit", childPid, exitCode: 0 }); // let the parent script finish
    };

    const r = await run(
      `
      const { fork } = require("child_process");
      const child = fork("/child.js", { silent: true });
      child.send({ hello: "world" });
      `,
      fake.host,
    );

    expect(r.code).toBe(0);
    expect(fake.ipcWrites).toHaveLength(1);
    expect(decoder.decode(fake.ipcWrites[0].chunk)).toBe('{"hello":"world"}\n');
  });

  it("an incoming ipc data event fires the child's 'message' event on the parent's ChildProcess", async () => {
    const fake = createFakeHost();
    fake.host.spawn = (childPid, ...rest) => {
      fake.spawns.push({ childPid, command: rest[0], args: rest[1], ipc: rest[4] });
      fake.emit({ type: "data", childPid, stream: "ipc", chunk: frame({ from: "child" }) });
      fake.emit({ type: "exit", childPid, exitCode: 0 });
    };

    const r = await run(
      `
      const child = require("child_process").fork("/child.js", { silent: true });
      child.on("message", (m) => console.log("got", JSON.stringify(m)));
      `,
      fake.host,
    );

    expect(r.stdout).toBe('got {"from":"child"}\n');
    expect(r.code).toBe(0);
  });
});

describe("fork() - child side (setupChannel wired directly by runtime.ts)", () => {
  const noopChildProcessHost: IChildProcessHost = {
    spawn: () => {},
    kill: () => {},
    writeStdin: () => {},
    endStdin: () => {},
    writeIpc: () => {},
    endIpc: () => {},
    onEvent: () => {},
  };

  const createFakeIpc = () => {
    let handler: ((chunk: Uint8Array | null) => void) | null = null;
    const sent: Uint8Array[] = [];
    let ended = false;
    const ipc: IForkIpcHost = {
      send: (chunk) => sent.push(chunk),
      end: () => {
        ended = true;
      },
      onData: (h) => {
        handler = h;
      },
    };
    return { ipc, sent, deliver: (chunk: Uint8Array | null) => handler?.(chunk), get ended() { return ended; } };
  };

  it("process.on('message') receives an incoming ipc message, and process.send() writes a framed reply", async () => {
    const fake = createFakeIpc();

    const r = await runScript(
      {
        "/app/main.js": `
        process.on("message", (m) => {
          console.log("child got", JSON.stringify(m));
          process.send({ echo: m });
        });
        `,
      },
      "/app/main.js",
      // A real (host) timer, not the sandboxed one: defers delivery past the script's own
      // synchronous top-level execution, so process.on("message", ...) is registered first -
      // exactly like a real incoming message, which can only ever arrive after that.
      { cwd: "/app", childProcess: noopChildProcessHost, ipc: fake.ipc, setup: () => setTimeout(() => fake.deliver(frame({ ping: 1 })), 0) },
    );

    expect(r.stdout).toBe('child got {"ping":1}\n');
    expect(fake.sent).toHaveLength(1);
    expect(decoder.decode(fake.sent[0])).toBe('{"echo":{"ping":1}}\n');
    expect(r.code).toBe(0);
  });

  it("without a message listener, the process still exits on its own (the channel doesn't unconditionally ref)", async () => {
    const fake = createFakeIpc();
    const r = await runScript({ "/app/main.js": `console.log("done");` }, "/app/main.js", {
      cwd: "/app",
      childProcess: noopChildProcessHost,
      ipc: fake.ipc,
    });
    expect(r).toMatchObject({ code: 0, stdout: "done\n" });
  });

  it("the parent disconnecting (EOF) fires 'disconnect' on the child's process", async () => {
    const fake = createFakeIpc();
    const r = await runScript(
      {
        "/app/main.js": `
        process.on("message", () => {});
        process.on("disconnect", () => console.log("disconnected"));
        `,
      },
      "/app/main.js",
      { cwd: "/app", childProcess: noopChildProcessHost, ipc: fake.ipc, setup: () => setTimeout(() => fake.deliver(null), 0) },
    );
    expect(r.stdout).toBe("disconnected\n");
  });
});

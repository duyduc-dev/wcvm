import { describe, expect, it } from "vitest";
import {
  OP_SPAWN_SYNC,
  SPAWN_SYNC_NO_STATUS,
  SyscallError,
  bytesToU32,
  decodeBytes,
  decodeRequest,
  encodeRequest,
  encodeString,
  u32ToBytes,
  type ISyscallClient,
} from "../protocols/syscall";
import type { IChildProcessHost } from "./bindings/childProcess";
import { runScript } from "./harness";

// require("child_process") always builds pipe_wrap/process_wrap's router at module load, which
// needs a childProcess host regardless of whether a script ever calls async spawn() - real
// process workers always wire one (workers/process/worker.ts), so tests need a (possibly
// never-exercised) fake too, exactly like production always has both capabilities available.
const noopChildProcessHost: IChildProcessHost = {
  spawn: () => {},
  kill: () => {},
  writeStdin: () => {},
  endStdin: () => {},
  onEvent: () => {},
};

interface IFakeSpawnSyncRequest {
  command: string;
  args: string[];
  cwd?: string;
  env?: Record<string, string>;
  input: Uint8Array;
  timeoutMs: number;
}

interface IFakeSpawnSyncResult {
  status: number | null;
  signal?: string;
  stdout?: Uint8Array;
  stderr?: Uint8Array;
  pid?: number;
}

/** Simulates the kernel's spawnSyncServer synchronously - no real worker/SAB needed to prove
 *  the binding's wire encoding and the vendored JS's consumption of it are correct end to end. */
const createFakeSpawnSync = (handler: (request: IFakeSpawnSyncRequest) => IFakeSpawnSyncResult): ISyscallClient => ({
  call: (opcode, request) => {
    if (opcode !== OP_SPAWN_SYNC) throw new SyscallError("ENOSYS");
    const { fields } = decodeRequest(request);
    const [commandBytes, argsBytes, cwdBytes, envBytes, input, timeoutBytes] = fields;
    const envJson = decodeBytes(envBytes);
    const result = handler({
      command: decodeBytes(commandBytes),
      args: JSON.parse(decodeBytes(argsBytes) || "[]"),
      cwd: decodeBytes(cwdBytes) || undefined,
      env: envJson ? JSON.parse(envJson) : undefined,
      input: input.slice(),
      timeoutMs: bytesToU32(timeoutBytes),
    });
    const status = result.status === null ? SPAWN_SYNC_NO_STATUS : result.status;
    return encodeRequest([
      u32ToBytes(result.pid ?? 1),
      u32ToBytes(status),
      encodeString(result.signal ?? ""),
      result.stdout ?? new Uint8Array(0),
      result.stderr ?? new Uint8Array(0),
    ]);
  },
});

const run = (source: string, spawnSync: ISyscallClient) =>
  runScript({ "/app/main.js": source }, "/app/main.js", { cwd: "/app", spawnSync, childProcess: noopChildProcessHost });

describe("child_process.spawnSync / execSync over a fake kernel", () => {
  it("spawnSync returns pid, status, and the child's buffered output", async () => {
    const encoder = new TextEncoder();
    const fake = createFakeSpawnSync(() => ({ status: 0, pid: 42, stdout: encoder.encode("hi\n"), stderr: new Uint8Array(0) }));

    const r = await run(
      `
      const { spawnSync } = require("child_process");
      const result = spawnSync("echo", ["hi"]);
      console.log(JSON.stringify({
        status: result.status, signal: result.signal, pid: result.pid,
        stdout: result.stdout.toString(), stderr: result.stderr.toString(),
      }));
      `,
      fake,
    );

    expect(r.code).toBe(0);
    expect(JSON.parse(r.stdout)).toEqual({ status: 0, signal: null, pid: 42, stdout: "hi\n", stderr: "" });
  });

  it("passes command, args, cwd and env through to the kernel", async () => {
    const requests: IFakeSpawnSyncRequest[] = [];
    const fake = createFakeSpawnSync((request) => {
      requests.push(request);
      return { status: 0 };
    });

    await run(
      `require("child_process").spawnSync("echo", ["a", "b"], { cwd: "/tmp", env: { FOO: "bar" } });`,
      fake,
    );

    expect(requests).toEqual([{ command: "echo", args: ["a", "b"], cwd: "/tmp", env: { FOO: "bar" }, input: new Uint8Array(0), timeoutMs: 0 }]);
  });

  it("delivers the `input` option as the child's stdin", async () => {
    const requests: IFakeSpawnSyncRequest[] = [];
    const fake = createFakeSpawnSync((request) => {
      requests.push(request);
      return { status: 0 };
    });

    await run(`require("child_process").spawnSync("cat", [], { input: "fed in" });`, fake);

    expect(decodeBytes(requests[0].input)).toBe("fed in");
  });

  it("reports status: null and the signal name for a killed child", async () => {
    const fake = createFakeSpawnSync(() => ({ status: null, signal: "SIGTERM" }));

    const r = await run(
      `
      const result = require("child_process").spawnSync("sleep", ["99"]);
      console.log(JSON.stringify({ status: result.status, signal: result.signal }));
      `,
      fake,
    );

    expect(JSON.parse(r.stdout)).toEqual({ status: null, signal: "SIGTERM" });
  });

  it("execSync returns the child's stdout directly", async () => {
    const fake = createFakeSpawnSync(() => ({ status: 0, stdout: new TextEncoder().encode("hello\n") }));

    const r = await run(
      `console.log(require("child_process").execSync("echo hello", { encoding: "utf8" }));`,
      fake,
    );

    expect(r.stdout).toBe("hello\n\n"); // execSync's own output, plus console.log's trailing newline
  });

  it("execSync throws on a nonzero exit, with stderr in the message", async () => {
    const fake = createFakeSpawnSync(() => ({ status: 1, stderr: new TextEncoder().encode("boom") }));

    const r = await run(
      `require("child_process").execSync("false");`,
      fake,
    );

    expect(r.code).toBe(1);
    expect(r.stderr).toContain("Command failed");
    expect(r.stderr).toContain("boom");
  });

  it("without a spawnSync capability wired up, spawnSync throws ENOSYS", async () => {
    const r = await runScript({ "/app/main.js": `require("child_process").spawnSync("echo");` }, "/app/main.js", {
      cwd: "/app",
      childProcess: noopChildProcessHost,
    });
    expect(r.code).toBe(1);
    expect(r.stderr).toContain("ENOSYS");
  });
});

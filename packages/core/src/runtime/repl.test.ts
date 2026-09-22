import { describe, expect, it, vi } from "vitest";
import { createTestLoader } from "./testing";
import { startRepl } from "./repl";

/**
 * Fakes only `process.exit`/`evaluate` (test doubles); everything else - readline,
 * internal/util/inspect, the Readable/Writable behind stdin/stdout - is the real vendored
 * code, same pattern node.test.ts's "vendored readline" suite already uses. `evaluate` never
 * touches a real global object here, unlike production's indirect eval (see runtime.ts's
 * runRepl) - that persistence behavior is proven in the Chromium e2e suite instead.
 */
const setup = () => {
  const out: string[] = [];
  const { require } = createTestLoader();
  const { Readable, Writable } = require("stream");
  const stdin = new Readable({ read() {} });
  const stdout = new Writable({
    write(chunk: Uint8Array, _enc: string, cb: () => void) {
      out.push(Buffer.from(chunk).toString());
      cb();
    },
  });

  let resolveExited: (code: number) => void;
  const exited = new Promise<number>((resolve) => (resolveExited = resolve));
  const process = {
    stdin,
    stdout,
    exitCode: undefined as number | undefined,
    exit: vi.fn((code?: number) => resolveExited(code ?? 0)),
    nextTick: (fn: () => void) => queueMicrotask(fn),
  };

  return {
    process,
    exited,
    out: () => out.join(""),
    requireBuiltin: require,
    push: (chunk: string | null) => stdin.push(chunk === null ? null : Buffer.from(chunk)),
  };
};

describe("startRepl", () => {
  it("writes the prompt on start", () => {
    const t = setup();
    startRepl({ process: t.process, requireBuiltin: t.requireBuiltin, evaluate: () => undefined, prompt: "> " });
    expect(t.out()).toBe("> ");
  });

  it("evaluates a line and prints the inspected result", async () => {
    const t = setup();
    const evaluate = vi.fn((code: string) => code.length);
    startRepl({ process: t.process, requireBuiltin: t.requireBuiltin, evaluate, prompt: "> " });
    t.push("abc\n");
    t.push(null);
    await t.exited;
    expect(evaluate).toHaveBeenCalledWith("abc");
    expect(t.out()).toBe("> 3\n> ");
  });

  it("prints Uncaught for a thrown error and keeps the session going", async () => {
    const t = setup();
    const evaluate = () => {
      throw new Error("boom");
    };
    startRepl({ process: t.process, requireBuiltin: t.requireBuiltin, evaluate, prompt: "> " });
    t.push("x\n");
    t.push("1\n");
    t.push(null);
    await t.exited;
    expect(t.out()).toContain("Uncaught");
    expect(t.out()).toContain("boom");
  });

  it("does not evaluate a blank line, just reprompts", async () => {
    const t = setup();
    const evaluate = vi.fn();
    startRepl({ process: t.process, requireBuiltin: t.requireBuiltin, evaluate, prompt: "> " });
    t.push("\n");
    t.push(null);
    await t.exited;
    expect(evaluate).not.toHaveBeenCalled();
    expect(t.out()).toBe("> > ");
  });

  it(".exit calls process.exit without evaluating", async () => {
    const t = setup();
    const evaluate = vi.fn();
    startRepl({ process: t.process, requireBuiltin: t.requireBuiltin, evaluate, prompt: "> " });
    t.push(".exit\n");
    await t.exited;
    expect(evaluate).not.toHaveBeenCalled();
    expect(t.process.exit).toHaveBeenCalledWith();
  });

  it("EOF (stdin close) calls process.exit with the current exitCode", async () => {
    const t = setup();
    startRepl({ process: t.process, requireBuiltin: t.requireBuiltin, evaluate: () => undefined, prompt: "> " });
    t.push(null);
    const code = await t.exited;
    expect(code).toBe(0);
  });
});

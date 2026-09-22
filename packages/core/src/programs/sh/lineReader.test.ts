import { describe, expect, it } from "vitest";
import type { IStdinHost } from "../../runtime/runtime";
import { createLineReader } from "./lineReader";

// Mirrors workers/process/worker.ts's real IStdinHost contract closely enough to matter here:
// once ended, a handler that registers later (createLineReader's own reattach()) still sees
// the null right away, instead of waiting forever for input that already stopped for good.
const makeStdin = () => {
  let handler: ((chunk: Uint8Array | null) => void) | undefined;
  let ended = false;
  const stdin: IStdinHost = {
    onData: (h) => {
      handler = h;
      if (ended) h(null);
    },
  };
  const encoder = new TextEncoder();
  return {
    stdin,
    write: (text: string) => handler!(encoder.encode(text)),
    end: () => {
      ended = true;
      handler!(null);
    },
  };
};

describe("createLineReader", () => {
  it("yields a line delivered in one chunk", async () => {
    const io = makeStdin();
    const reader = createLineReader(io.stdin);
    const next = reader.nextLine();
    io.write("hello\n");
    expect(await next).toBe("hello");
  });

  it("splits multiple lines out of one chunk", async () => {
    const io = makeStdin();
    const reader = createLineReader(io.stdin);
    io.write("one\ntwo\nthree\n");
    expect(await reader.nextLine()).toBe("one");
    expect(await reader.nextLine()).toBe("two");
    expect(await reader.nextLine()).toBe("three");
  });

  it("joins a line split across chunks", async () => {
    const io = makeStdin();
    const reader = createLineReader(io.stdin);
    const next = reader.nextLine();
    io.write("hel");
    io.write("lo\n");
    expect(await next).toBe("hello");
  });

  it("yields a final unterminated line at EOF", async () => {
    const io = makeStdin();
    const reader = createLineReader(io.stdin);
    const next = reader.nextLine();
    io.write("trailing");
    io.end();
    expect(await next).toBe("trailing");
    expect(await reader.nextLine()).toBeNull();
  });

  it("resolves null immediately once EOF is reached with nothing pending", async () => {
    const io = makeStdin();
    const reader = createLineReader(io.stdin);
    const next = reader.nextLine();
    io.end();
    expect(await next).toBeNull();
    expect(await reader.nextLine()).toBeNull();
  });

  it("queues lines that arrive before nextLine is called", async () => {
    const io = makeStdin();
    const reader = createLineReader(io.stdin);
    io.write("a\nb\n");
    io.end();
    expect(await reader.nextLine()).toBe("a");
    expect(await reader.nextLine()).toBe("b");
    expect(await reader.nextLine()).toBeNull();
  });

  it("reattach() reclaims the handler once something else has registered on the same stdin", async () => {
    const io = makeStdin();
    const reader = createLineReader(io.stdin);

    // A program the REPL runs in-process (cat, node, a nested sh) registers its own handler
    // on this same IStdinHost, exactly as sh.ts's runPipeline hands ctx.stdin straight through.
    let stolen: Uint8Array | undefined;
    io.stdin.onData((chunk) => {
      stolen = chunk ?? undefined;
    });
    io.write("taken by the nested program\n");
    expect(stolen).toBeDefined();

    // Once that program exits, the REPL reclaims its slot and sees further input again.
    reader.reattach();
    io.write("back to the repl\n");
    expect(await reader.nextLine()).toBe("back to the repl");
  });

  it("a handler that reattaches after real EOF still sees it, instead of waiting forever", async () => {
    const io = makeStdin();
    const reader = createLineReader(io.stdin);

    io.stdin.onData(() => {}); // a nested program takes over stdin...
    io.end(); // ...and the whole process's stdin ends while it's still the active handler

    reader.reattach(); // the REPL reclaims its slot after EOF already happened
    expect(await reader.nextLine()).toBeNull();
  });
});

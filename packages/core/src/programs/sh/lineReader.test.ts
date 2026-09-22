import { describe, expect, it } from "vitest";
import type { IStdinHost } from "../../runtime/runtime";
import { createLineReader } from "./lineReader";

const makeStdin = () => {
  let handler: ((chunk: Uint8Array | null) => void) | undefined;
  const stdin: IStdinHost = { onData: (h) => (handler = h) };
  const encoder = new TextEncoder();
  return {
    stdin,
    write: (text: string) => handler!(encoder.encode(text)),
    end: () => handler!(null),
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
});

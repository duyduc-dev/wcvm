import { describe, expect, it } from "vitest";
import { createTestLoader } from "./testing";

const load = (id: string) => createTestLoader().require(id);

describe("vendored path", () => {
  it("resolves, joins and parses like Node", () => {
    const path = load("path");
    expect(path.resolve("/a/b", "../c", "./d")).toBe("/a/c/d");
    expect(path.relative("/a/b/c", "/a/d")).toBe("../../d");
    expect(path.parse("/home/u/file.tar.gz")).toEqual({
      root: "/",
      dir: "/home/u",
      base: "file.tar.gz",
      ext: ".gz",
      name: "file.tar",
    });
    expect(path.format({ dir: "/x", name: "y", ext: ".z" })).toBe("/x/y.z");
    expect(path.normalize("/a//b/../c/.")).toBe("/a/c");
    expect(path.isAbsolute("a")).toBe(false);
    expect(() => path.join(1)).toThrow(/ERR_INVALID_ARG_TYPE|must be of type string/);
  });
});

describe("vendored events", () => {
  it("emits, orders listeners, and supports once/off/prepend", () => {
    const EventEmitter = load("events");
    const e = new EventEmitter();
    const seen: string[] = [];
    e.on("x", (v: string) => seen.push(`a${v}`));
    e.prependListener("x", (v: string) => seen.push(`first${v}`));
    e.once("x", (v: string) => seen.push(`once${v}`));
    expect(e.emit("x", "1")).toBe(true);
    e.emit("x", "2");
    expect(seen).toEqual(["first1", "a1", "once1", "first2", "a2"]);
    expect(e.listenerCount("x")).toBe(2);
    expect(e.emit("nothing")).toBe(false);
  });

  it("throws an unhandled 'error' event", () => {
    const EventEmitter = load("events");
    expect(() => new EventEmitter().emit("error", new Error("boom"))).toThrow("boom");
    const e = new EventEmitter();
    e.on("error", () => {});
    expect(e.emit("error", new Error("handled"))).toBe(true);
  });

  it("events.once resolves with the emitted arguments", async () => {
    const EventEmitter = load("events");
    const e = new EventEmitter();
    const pending = EventEmitter.once(e, "ready");
    e.emit("ready", 1, 2);
    expect(await pending).toEqual([1, 2]);
  });
});

describe("vendored buffer", () => {
  const { Buffer } = load("buffer");

  it("round-trips every encoding", () => {
    const b = Buffer.from("héllo wörld ✓", "utf8");
    expect(b.toString("utf8")).toBe("héllo wörld ✓");
    expect(Buffer.from("68656c6c6f", "hex").toString()).toBe("hello");
    expect(Buffer.from("hello").toString("hex")).toBe("68656c6c6f");
    expect(Buffer.from("aGVsbG8=", "base64").toString()).toBe("hello");
    expect(Buffer.from("hello").toString("base64")).toBe("aGVsbG8=");
    expect(Buffer.from([0xfb, 0xff]).toString("base64url")).toBe("-_8");
    expect(Buffer.from("hi", "utf16le")).toEqual(Buffer.from([0x68, 0, 0x69, 0]));
    expect(Buffer.from("café", "latin1").length).toBe(4);
    expect(Buffer.byteLength("✓")).toBe(3);
  });

  it("allocates, fills, concatenates, slices and compares", () => {
    expect(Buffer.alloc(4, "ab").toString()).toBe("abab");
    expect(Buffer.concat([Buffer.from("a"), Buffer.from("bc")]).toString()).toBe("abc");
    const b = Buffer.from("abcdef");
    expect(b.subarray(1, 3).toString()).toBe("bc");
    expect(Buffer.compare(Buffer.from("a"), Buffer.from("b"))).toBe(-1);
    expect(b.equals(Buffer.from("abcdef"))).toBe(true);
    const target = Buffer.alloc(3);
    b.copy(target, 0, 2, 5);
    expect(target.toString()).toBe("cde");
  });

  it("searches forwards and backwards", () => {
    const b = Buffer.from("abcabc");
    expect(b.indexOf("c")).toBe(2);
    expect(b.lastIndexOf("c")).toBe(5);
    expect(b.indexOf(Buffer.from("ca"))).toBe(2);
    expect(b.indexOf(0x62, 2)).toBe(4);
    expect(b.includes("zzz")).toBe(false);
    expect(b.indexOf("abc", -3)).toBe(3);
  });

  it("reads and writes numbers", () => {
    const b = Buffer.alloc(8);
    b.writeUInt32BE(0xdeadbeef, 0);
    b.writeInt16LE(-2, 4);
    expect(b.readUInt32BE(0)).toBe(0xdeadbeef);
    expect(b.readInt16LE(4)).toBe(-2);
    b.writeDoubleLE(1.5, 0);
    expect(b.readDoubleLE(0)).toBe(1.5);
    expect(() => b.readUInt8(99)).toThrow(/out of range|ERR_OUT_OF_RANGE/i);
  });

  it("swaps bytes and validates encodings", () => {
    expect(Buffer.from([1, 2, 3, 4]).swap16()).toEqual(Buffer.from([2, 1, 4, 3]));
    expect(() => Buffer.from("x", "nope")).toThrow(/Unknown encoding/);
    expect(Buffer.isBuffer(Buffer.alloc(1))).toBe(true);
  });

  it("btoa/atob follow the platform rules", () => {
    const { btoa, atob } = load("buffer");
    expect(btoa("hello")).toBe("aGVsbG8=");
    expect(atob("aGVsbG8=")).toBe("hello");
    expect(() => btoa("✓")).toThrow();
    expect(() => atob("a")).toThrow();
  });
});

describe("vendored util", () => {
  const util = load("util");

  it("formats printf-style", () => {
    expect(util.format("%s:%d:%i:%f:%j:%%", "a", 1.5, 2.9, "3.5", { x: 1 })).toBe(
      'a:1.5:2:3.5:{"x":1}:%',
    );
    expect(util.format("no args", "extra", 1)).toBe("no args extra 1");
    expect(util.format("%o", [1])).toContain("[ 1");
  });

  it("inspects nested values, cycles and special objects", () => {
    expect(util.inspect({ a: [1, { b: 2 }], s: "x" })).toBe("{ a: [ 1, { b: 2 } ], s: 'x' }");
    const cyclic: any = { name: "c" };
    cyclic.self = cyclic;
    expect(util.inspect(cyclic)).toContain("<ref *1>");
    expect(util.inspect(new Map([[1, { a: 1 }]]))).toBe("Map(1) { 1 => { a: 1 } }");
    expect(util.inspect(new Set([1, 2]))).toBe("Set(2) { 1, 2 }");
    expect(util.inspect(Buffer.from("hi"))).toBe("<Buffer 68 69>");
    expect(util.inspect(new Date(0))).toBe("1970-01-01T00:00:00.000Z");
    expect(util.inspect(Symbol("s"))).toBe("Symbol(s)");
    expect(util.inspect(123n)).toBe("123n");
    expect(util.inspect(() => {})).toMatch(/^\[Function/);
    expect(util.inspect(class Foo {})).toBe("[class Foo]");
    expect(util.inspect({ depth: { a: { b: { c: {} } } } }, { depth: 0 })).toBe("{ depth: [Object] }");
    expect(util.inspect("a'b")).toBe('"a\'b"');
  });

  it("inspects errors with their message", () => {
    const text = util.inspect(new TypeError("bad thing"));
    expect(text).toContain("TypeError: bad thing");
  });

  it("promisify, inherits, deprecate, types, isDeepStrictEqual", async () => {
    const wait = util.promisify((ms: number, cb: (e: null, v: string) => void) =>
      setTimeout(() => cb(null, `waited ${ms}`), 1),
    );
    expect(await wait(5)).toBe("waited 5");

    function A() {}
    function B() {}
    util.inherits(B, A);
    expect(new (B as any)() instanceof A).toBe(true);

    expect(util.types.isDate(new Date())).toBe(true);
    expect(util.types.isRegExp(/x/)).toBe(true);
    expect(util.types.isMap(new Map())).toBe(true);
    expect(util.types.isPromise(Promise.resolve())).toBe(true);
    expect(util.types.isUint8Array(new Uint8Array())).toBe(true);
    expect(util.types.isAsyncFunction(async () => {})).toBe(true);
    expect(util.types.isMap({})).toBe(false);

    expect(util.isDeepStrictEqual({ a: [1, 2] }, { a: [1, 2] })).toBe(true);
    expect(util.isDeepStrictEqual({ a: 1 }, { a: "1" })).toBe(false);
  });

  it("TextEncoder/Decoder and stripVTControlCharacters are available", () => {
    expect(util.stripVTControlCharacters("\u001b[31mred\u001b[0m")).toBe("red");
    expect(new util.TextDecoder().decode(new util.TextEncoder().encode("ok"))).toBe("ok");
  });
});

describe("vendored assert", () => {
  const assert = load("assert");

  it("ok/strictEqual/deepStrictEqual pass and fail correctly", () => {
    expect(() => assert.ok(true)).not.toThrow();
    expect(() => assert.ok(false)).toThrow(assert.AssertionError);
    expect(() => assert.strictEqual(1, 1)).not.toThrow();
    expect(() => assert.strictEqual(1, "1" as unknown as number)).toThrow(assert.AssertionError);
    expect(() => assert.deepStrictEqual({ a: [1, 2] }, { a: [1, 2] })).not.toThrow();
    expect(() => assert.deepStrictEqual({ a: 1 }, { a: "1" })).toThrow(assert.AssertionError);
  });

  it("throws/doesNotThrow/rejects/doesNotReject", async () => {
    expect(() =>
      assert.throws(() => {
        throw new TypeError("bad");
      }, TypeError),
    ).not.toThrow();
    expect(() => assert.doesNotThrow(() => {})).not.toThrow();
    await expect(assert.rejects(Promise.reject(new Error("x")))).resolves.toBeUndefined();
    await expect(assert.doesNotReject(Promise.resolve(1))).resolves.toBeUndefined();
  });

  it("AssertionError carries actual/expected/operator/code", () => {
    try {
      assert.strictEqual(1, 2);
      throw new Error("should have thrown");
    } catch (error) {
      expect(error).toBeInstanceOf(assert.AssertionError);
      expect((error as any).code).toBe("ERR_ASSERTION");
      expect((error as any).actual).toBe(1);
      expect((error as any).expected).toBe(2);
      expect((error as any).operator).toBe("strictEqual");
    }
  });
});

describe("vendored readline", () => {
  const { Readable, Writable } = load("stream");
  const sink = () =>
    new Writable({
      write(_chunk: unknown, _encoding: string, callback: () => void) {
        callback();
      },
    });

  it("emits 'line' for each newline-terminated chunk and closes on input end", async () => {
    const readline = load("readline");
    const input = new Readable({ read() {} });
    const rl = readline.createInterface({ input, output: sink(), terminal: false });
    const lines: string[] = [];
    rl.on("line", (line: string) => lines.push(line));
    const closed = new Promise((resolve) => rl.on("close", resolve));

    input.push("hello\nworld\n");
    input.push(null);
    await closed;

    expect(lines).toEqual(["hello", "world"]);
  });

  it("readline/promises resolves a question and closes cleanly", async () => {
    const promises = load("readline/promises");
    const input = new Readable({ read() {} });
    const rl = promises.createInterface({ input, output: sink(), terminal: false });

    const answer = rl.question("answer? ");
    input.push("42\n");
    expect(await answer).toBe("42");
    rl.close();
  });
});

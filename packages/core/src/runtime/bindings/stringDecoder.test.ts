import { describe, expect, it } from "vitest";
import { createTestLoader } from "../testing";

// Real Node is the oracle for every expectation here: the same chunks were fed to
// `new StringDecoder(encoding)` in Node 24 to get these strings.
const { StringDecoder } = createTestLoader().require("string_decoder");
const bytes = (...b: number[]) => Buffer.from(b);

describe("StringDecoder (native core)", () => {
  it("holds back a UTF-8 character split across chunks", () => {
    const d = new StringDecoder("utf8");
    expect(d.write(bytes(0xe2, 0x82))).toBe("");
    expect(d.write(bytes(0xac))).toBe("€");
    expect(d.write(Buffer.from("ok"))).toBe("ok");
    // 4-byte emoji, one byte at a time
    const emoji = Buffer.from("😀");
    expect([...emoji].map((b) => d.write(bytes(b))).join("")).toBe("😀");
  });

  it("emits complete text before a trailing partial character", () => {
    const d = new StringDecoder("utf8");
    expect(d.write(Buffer.concat([Buffer.from("ab"), bytes(0xe2)]))).toBe("ab");
    expect(d.write(bytes(0x82, 0xac))).toBe("€");
    expect(d.lastNeed).toBe(0);
  });

  it("reports what is still missing", () => {
    const d = new StringDecoder("utf8");
    d.write(bytes(0xe2));
    expect(d.lastNeed).toBe(2);
    expect(d.lastTotal).toBe(3);
    expect([...d.lastChar.subarray(0, 1)]).toEqual([0xe2]);
  });

  it("flushes an incomplete sequence as a replacement character", () => {
    const d = new StringDecoder("utf8");
    d.write(bytes(0xe2, 0x82));
    expect(d.end()).toBe("�");
    expect(d.end()).toBe("");
  });

  it("replaces invalid bytes and recovers", () => {
    const d = new StringDecoder("utf8");
    expect(d.write(bytes(0xff, 0x61))).toBe("�a");
    expect(d.write(bytes(0xe2))).toBe("");
    expect(d.write(bytes(0x61))).toBe("�a");
  });

  it("handles UTF-16LE odd bytes and split surrogate pairs", () => {
    const d = new StringDecoder("utf16le");
    const pair = Buffer.from("😀", "utf16le"); // 4 bytes: high, low
    expect(d.write(pair.subarray(0, 1))).toBe("");
    expect(d.write(pair.subarray(1, 3))).toBe("");
    expect(d.write(pair.subarray(3))).toBe("😀");
    expect(d.write(Buffer.from("hi", "utf16le"))).toBe("hi");
    d.write(bytes(0x61));
    expect(d.end()).toBe("");
  });

  it("base64 emits only whole triples until flushed", () => {
    const d = new StringDecoder("base64");
    expect(d.write(Buffer.from("ab"))).toBe("");
    expect(d.write(Buffer.from("cde"))).toBe("YWJjZA==".slice(0, 4)); // "abc" -> YWJj
    expect(d.end()).toBe("ZGU=");
    const u = new StringDecoder("base64url");
    u.write(Buffer.from("a"));
    expect(u.end()).toBe("YQ");
  });

  it("hex, latin1 and ascii decode immediately", () => {
    expect(new StringDecoder("hex").write(bytes(0xde, 0xad))).toBe("dead");
    expect(new StringDecoder("latin1").write(bytes(0xe9))).toBe("é");
    expect(new StringDecoder("ascii").write(bytes(0xe9, 0x41))).toBe("iA");
  });

  it("many small chunks of a long string reassemble exactly", () => {
    const text = "héllo wörld — ✓ 😀 ".repeat(50);
    const data = Buffer.from(text);
    for (const size of [1, 2, 3, 5, 7]) {
      const d = new StringDecoder("utf8");
      let out = "";
      for (let i = 0; i < data.length; i += size) out += d.write(data.subarray(i, i + size));
      expect(out + d.end()).toBe(text);
    }
  });
});

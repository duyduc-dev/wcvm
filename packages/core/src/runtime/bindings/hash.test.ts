import nodeCrypto from "node:crypto";
import { describe, expect, it } from "vitest";
import { HASH_ALGORITHMS, createHasher } from "./hash";

const hex = (bytes: Uint8Array) => Buffer.from(bytes).toString("hex");
const node = (algorithm: string, data: Uint8Array) => nodeCrypto.createHash(algorithm).update(data).digest("hex");
const ours = (algorithm: string, data: Uint8Array) => {
  const hasher = createHasher(algorithm)!;
  hasher.update(data);
  return hex(hasher.digest());
};

// Every padding edge: empty, one short of a block, exactly a block, one past, and the lengths
// where the 8/16-byte length field only just does or doesn't fit in the final block.
const LENGTHS = [0, 1, 3, 55, 56, 57, 63, 64, 65, 111, 112, 113, 127, 128, 129, 1000, 4096, 100_003];

describe("pure-JS hashes (checked against Node's own crypto)", () => {
  it.each(HASH_ALGORITHMS)("%s matches Node's digest for every length class", (algorithm) => {
    for (const length of LENGTHS) {
      const data = nodeCrypto.randomBytes(length);
      expect(ours(algorithm, data), `${algorithm} of ${length} bytes`).toBe(node(algorithm, data));
    }
  });

  it.each(HASH_ALGORITHMS)("%s gives the same digest however the input is split into update() calls", (algorithm) => {
    const data = nodeCrypto.randomBytes(5000);
    const hasher = createHasher(algorithm)!;
    for (let offset = 0, step = 1; offset < data.length; offset += step, step = (step * 7 + 3) % 331) {
      hasher.update(data.subarray(offset, offset + step));
    }
    expect(hex(hasher.digest())).toBe(node(algorithm, data));
  });

  it("copy() forks the running state", () => {
    const hasher = createHasher("sha256")!;
    hasher.update(Buffer.from("hello "));
    const fork = hasher.copy();
    hasher.update(Buffer.from("world"));
    fork.update(Buffer.from("there"));
    expect(hex(hasher.digest())).toBe(node("sha256", Buffer.from("hello world")));
    expect(hex(fork.digest())).toBe(node("sha256", Buffer.from("hello there")));
  });

  it("hashes a multi-megabyte input - no size limit, unlike the old kernel round trip", () => {
    const data = nodeCrypto.randomBytes(3 * 1024 * 1024);
    expect(ours("sha1", data)).toBe(node("sha1", data));
  });

  it("accepts Node's spellings case-insensitively, and WebCrypto's SHA-256 style; rejects unknown ones", () => {
    expect(ours("SHA256", Buffer.from("x"))).toBe(node("sha256", Buffer.from("x")));
    expect(ours("SHA-512", Buffer.from("x"))).toBe(node("sha512", Buffer.from("x")));
    expect(createHasher("md4")).toBeUndefined();
    expect(createHasher("sha3-256")).toBeUndefined();
  });
});

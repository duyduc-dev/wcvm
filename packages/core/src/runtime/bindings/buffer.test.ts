import { describe, expect, it, vi } from "vitest";
import { createTestLoader } from "../testing";
import { copyBytes, createBufferBinding } from "./buffer";

describe("buffer binding and shared memory", () => {
  it("copyBytes copies even for a Buffer, whose own slice() returns a view", () => {
    const { Buffer } = createTestLoader().require("buffer");
    const original = Buffer.from([1, 2, 3]);
    const copy = copyBytes(original);
    original[0] = 99;
    expect(copy[0]).toBe(1);
    expect(copy.buffer).not.toBe(original.buffer);
  });

  it("decodes a Buffer that lives in a SharedArrayBuffer without handing TextDecoder shared memory", () => {
    const { Buffer } = createTestLoader().require("buffer");
    const shared = Buffer.from(new SharedArrayBuffer(3));
    shared.set([0xe2, 0x82, 0xac]);

    const realDecode = TextDecoder.prototype.decode;
    const spy = vi.spyOn(TextDecoder.prototype, "decode").mockImplementation(function (
      this: TextDecoder,
      input?: AllowSharedBufferSource,
    ) {
      if ((input as ArrayBufferView).buffer instanceof SharedArrayBuffer) {
        throw new TypeError("The provided ArrayBufferView value must not be shared.");
      }
      return realDecode.call(this, input);
    });
    try {
      const binding = createBufferBinding();
      expect(binding.utf8Slice(shared, 0, 3)).toBe("€");
      expect(binding.isUtf8(shared)).toBe(true);
    } finally {
      spy.mockRestore();
    }
  });
});

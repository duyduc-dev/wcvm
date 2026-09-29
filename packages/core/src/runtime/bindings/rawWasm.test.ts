import { describe, expect, it, vi } from "vitest";
import { installRawWasm } from "./rawWasm";

// The smallest valid wasm module: the magic number + version, no sections at all.
const EMPTY_MODULE = Uint8Array.of(0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00);

describe("installRawWasm", () => {
  it("refs the loop across a real compile() and releases once it resolves", async () => {
    const release = vi.fn();
    const ref = vi.fn(() => release);
    const globalObject: Record<string, unknown> = { WebAssembly };
    installRawWasm({ ref, globalObject });

    const wrapped = globalObject.WebAssembly as typeof WebAssembly;
    const promise = wrapped.compile(EMPTY_MODULE);
    expect(ref).toHaveBeenCalledTimes(1);
    expect(release).not.toHaveBeenCalled();

    const module = await promise;
    expect(module).toBeInstanceOf(WebAssembly.Module);
    expect(release).toHaveBeenCalledTimes(1);
  });

  it("still releases the ref when compile() rejects (malformed input)", async () => {
    const release = vi.fn();
    const ref = vi.fn(() => release);
    const globalObject: Record<string, unknown> = { WebAssembly };
    installRawWasm({ ref, globalObject });

    const wrapped = globalObject.WebAssembly as typeof WebAssembly;
    await expect(wrapped.compile(new Uint8Array([1, 2, 3]))).rejects.toThrow();
    expect(release).toHaveBeenCalledTimes(1);
  });

  it("refs across instantiate() too, and the result still works", async () => {
    const release = vi.fn();
    const ref = vi.fn(() => release);
    const globalObject: Record<string, unknown> = { WebAssembly };
    installRawWasm({ ref, globalObject });

    const wrapped = globalObject.WebAssembly as typeof WebAssembly;
    const result = await wrapped.instantiate(EMPTY_MODULE);
    expect(result.instance).toBeInstanceOf(WebAssembly.Instance);
    expect(ref).toHaveBeenCalledTimes(1);
    expect(release).toHaveBeenCalledTimes(1);
  });

  it("leaves every other WebAssembly member (Module, validate, error classes, ...) reachable, unwrapped", () => {
    const globalObject: Record<string, unknown> = { WebAssembly };
    installRawWasm({ ref: () => () => {}, globalObject });

    const wrapped = globalObject.WebAssembly as typeof WebAssembly;
    expect(wrapped.Module).toBe(WebAssembly.Module);
    expect(wrapped.validate(EMPTY_MODULE)).toBe(true);
    expect(wrapped.CompileError).toBe(WebAssembly.CompileError);
  });

  it("is a no-op when there's no real WebAssembly in this realm", () => {
    const globalObject: Record<string, unknown> = {};
    installRawWasm({ ref: () => () => {}, globalObject });
    expect(globalObject.WebAssembly).toBeUndefined();
  });
});

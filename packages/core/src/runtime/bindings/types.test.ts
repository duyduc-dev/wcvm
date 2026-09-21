import { describe, expect, it } from "vitest";
import { createTypesBinding } from "./types";

const t = createTypesBinding();

// Every check must say yes to its own kind and no to all the others: a brand
// check that accepts the wrong kind sends util.inspect down the wrong branch.
const samples: Record<string, unknown> = {
  isDate: new Date(),
  isRegExp: /x/g,
  isMap: new Map(),
  isSet: new Set(),
  isWeakMap: new WeakMap(),
  isWeakSet: new WeakSet(),
  isArrayBuffer: new ArrayBuffer(1),
  isSharedArrayBuffer: new SharedArrayBuffer(1),
  isDataView: new DataView(new ArrayBuffer(1)),
  isPromise: Promise.resolve(),
  isNativeError: new TypeError("x"),
  isNumberObject: new Number(1),
  isStringObject: new String("s"),
  isBooleanObject: new Boolean(true),
  isBigIntObject: Object(1n),
  isSymbolObject: Object(Symbol("s")),
  isMapIterator: new Map().entries(),
  isSetIterator: new Set().values(),
};

describe("types binding", () => {
  for (const [name, sample] of Object.entries(samples)) {
    it(`${name} accepts its own kind and rejects every other`, () => {
      const check = (t as Record<string, (v: unknown) => boolean>)[name];
      expect(check(sample)).toBe(true);
      for (const [other, value] of Object.entries(samples)) {
        if (other === name) continue;
        // isBoxedPrimitive-style overlap does not exist between these kinds.
        expect(check(value), `${name}(${other} sample)`).toBe(false);
      }
      for (const primitive of [null, undefined, 0, "", true, {}, [], () => {}]) {
        expect(check(primitive), `${name}(${String(primitive)})`).toBe(false);
      }
    });
  }

  it("isAnyArrayBuffer covers both buffer kinds", () => {
    expect(t.isAnyArrayBuffer(new ArrayBuffer(1))).toBe(true);
    expect(t.isAnyArrayBuffer(new SharedArrayBuffer(1))).toBe(true);
    expect(t.isAnyArrayBuffer(new Uint8Array(1))).toBe(false);
  });

  it("isBoxedPrimitive is true only for wrapper objects", () => {
    expect(t.isBoxedPrimitive(new Number(1))).toBe(true);
    expect(t.isBoxedPrimitive(Object(1n))).toBe(true);
    expect(t.isBoxedPrimitive(1)).toBe(false);
    expect(t.isBoxedPrimitive(new Date())).toBe(false);
  });

  it("recognises function kinds and arguments objects", () => {
    expect(t.isAsyncFunction(async () => {})).toBe(true);
    expect(t.isAsyncFunction(() => {})).toBe(false);
    expect(t.isGeneratorFunction(function* () {})).toBe(true);
    expect(t.isGeneratorObject((function* () {})())).toBe(true);
    expect(t.isArgumentsObject((function (..._a: unknown[]) { return arguments; })())).toBe(true);
  });

  it("cannot see proxies or externals, and says so", () => {
    expect(t.isProxy(new Proxy({}, {}))).toBe(false);
    expect(t.isExternal({})).toBe(false);
  });
});

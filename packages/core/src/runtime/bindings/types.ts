// internalBinding('types'): brand checks that V8 answers from internal slots.
//
// JS cannot see every slot. Where a real brand check exists (calling a method
// that throws for other receivers) it is used. Where none does, the answer comes
// from Object.prototype.toString's tag, which a class could spoof with
// Symbol.toStringTag - a known, accepted difference from Node. isProxy and
// isExternal cannot be detected from JS at all and always answer false.

const tag = (value: unknown): string => Object.prototype.toString.call(value);
const isObject = (value: unknown): value is object =>
  (typeof value === "object" && value !== null) || typeof value === "function";

const brand = (fn: (value: any) => unknown) => (value: unknown): boolean => {
  if (!isObject(value)) return false;
  try {
    fn(value);
    return true;
  } catch {
    return false;
  }
};

const isBoxed = (valueOf: (v: any) => unknown) => (value: unknown): boolean =>
  typeof value === "object" && value !== null && brand(valueOf)(value);

const isMap = brand((v) => Map.prototype.has.call(v, 0));
const isSet = brand((v) => Set.prototype.has.call(v, 0));
const isWeakMap = brand((v) => WeakMap.prototype.has.call(v, {}));
const isWeakSet = brand((v) => WeakSet.prototype.has.call(v, {}));
const isDate = brand((v) => Date.prototype.getTime.call(v));
const isArrayBuffer = brand((v) => Object.getOwnPropertyDescriptor(ArrayBuffer.prototype, "byteLength")!.get!.call(v));
const isSharedArrayBuffer = (value: unknown): boolean =>
  typeof SharedArrayBuffer !== "undefined" &&
  brand((v) => Object.getOwnPropertyDescriptor(SharedArrayBuffer.prototype, "byteLength")!.get!.call(v))(value);
const isDataView = brand((v) => Object.getOwnPropertyDescriptor(DataView.prototype, "byteLength")!.get!.call(v));
// The `global` getter throws for anything without a RegExp's internal slots
// (unlike `flags`, which is generic and would accept any object), and unlike
// exec() it has no side effect on lastIndex.
const isRegExp = brand((v) => Object.getOwnPropertyDescriptor(RegExp.prototype, "global")!.get!.call(v));

const createTypesBinding = () => ({
  isExternal: (_value: unknown) => false,
  isProxy: (_value: unknown) => false,
  isDate,
  isMap,
  isSet,
  isWeakMap,
  isWeakSet,
  isRegExp,
  isArrayBuffer,
  isSharedArrayBuffer,
  isAnyArrayBuffer: (v: unknown) => isArrayBuffer(v) || isSharedArrayBuffer(v),
  isDataView,
  isPromise: (v: unknown) => isObject(v) && tag(v) === "[object Promise]",
  isNativeError: (v: unknown) => isObject(v) && tag(v) === "[object Error]",
  isArgumentsObject: (v: unknown) => isObject(v) && tag(v) === "[object Arguments]",
  isAsyncFunction: (v: unknown) =>
    typeof v === "function" && /^\[object Async(Generator)?Function\]$/.test(tag(v)),
  isGeneratorFunction: (v: unknown) =>
    typeof v === "function" && /^\[object (Async)?GeneratorFunction\]$/.test(tag(v)),
  isGeneratorObject: (v: unknown) => isObject(v) && tag(v) === "[object Generator]",
  isMapIterator: (v: unknown) => isObject(v) && tag(v) === "[object Map Iterator]",
  isSetIterator: (v: unknown) => isObject(v) && tag(v) === "[object Set Iterator]",
  isModuleNamespaceObject: (v: unknown) => isObject(v) && tag(v) === "[object Module]",
  isNumberObject: isBoxed((v) => Number.prototype.valueOf.call(v)),
  isStringObject: isBoxed((v) => String.prototype.valueOf.call(v)),
  isBooleanObject: isBoxed((v) => Boolean.prototype.valueOf.call(v)),
  isBigIntObject: isBoxed((v) => BigInt.prototype.valueOf.call(v)),
  isSymbolObject: isBoxed((v) => Symbol.prototype.valueOf.call(v)),
  isBoxedPrimitive: (v: unknown) =>
    typeof v === "object" &&
    v !== null &&
    [Number, String, Boolean, BigInt, Symbol].some((C) => brand((x) => (C.prototype as any).valueOf.call(x))(v)),
});

export { createTypesBinding };

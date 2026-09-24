// internalBinding('util') and friends. Some of V8's introspection has no JS
// equivalent; those are documented where they are stubbed:
//   getPromiseDetails  - always "pending" (a promise's state is not readable), so
//                        util.inspect prints Promise { <pending> } for every promise.
//   getProxyDetails    - always undefined (a Proxy cannot be detected).
//   previewEntries     - works for Map/Set, not for their live iterators.

export interface IUtilContext {
  requireBuiltin(id: string): any;
}

const K_PENDING = 0;
const K_FULFILLED = 1;
const K_REJECTED = 2;
const ALL_PROPERTIES = 0;
const ONLY_WRITABLE = 1;
const ONLY_ENUMERABLE = 2;
const ONLY_CONFIGURABLE = 4;
const SKIP_STRINGS = 8;
const SKIP_SYMBOLS = 16;

const isIndex = (key: string) => /^(?:0|[1-9]\d*)$/.test(key) && Number(key) < 2 ** 32 - 1;

const getOwnNonIndexProperties = (object: object, filter: number) => {
  const keep = (d: PropertyDescriptor | undefined) =>
    d !== undefined &&
    (!(filter & ONLY_ENUMERABLE) || d.enumerable) &&
    (!(filter & ONLY_WRITABLE) || d.writable) &&
    (!(filter & ONLY_CONFIGURABLE) || d.configurable);
  const out: Array<string | symbol> = [];
  if (!(filter & SKIP_STRINGS)) {
    for (const key of Object.getOwnPropertyNames(object)) {
      if (!isIndex(key) && keep(Object.getOwnPropertyDescriptor(object, key))) out.push(key);
    }
  }
  if (!(filter & SKIP_SYMBOLS)) {
    for (const key of Object.getOwnPropertySymbols(object)) {
      if (keep(Object.getOwnPropertyDescriptor(object, key))) out.push(key);
    }
  }
  return out;
};

const getConstructorName = (object: object): string => {
  for (let o: any = object; o !== null && o !== undefined; o = Object.getPrototypeOf(o)) {
    const d = Object.getOwnPropertyDescriptor(o, "constructor");
    const name = typeof d?.value === "function" ? d.value.name : "";
    if (name) return name;
  }
  return "";
};

const previewEntries = (object: any, isIterator?: boolean): any => {
  let entries: unknown[] = [];
  let keyValue = false;
  if (object instanceof Map) {
    keyValue = true;
    for (const [k, v] of object) entries.push(k, v);
  } else if (object instanceof Set) {
    entries = [...object];
  }
  return isIterator ? [entries, keyValue] : entries;
};

/** A Symbol per name, created on first use: Node's private/per-isolate symbol tables. */
const symbolTable = (prefix = "") =>
  new Proxy({} as Record<string, symbol>, {
    get(target, name) {
      if (typeof name !== "string") return undefined;
      return (target[name] ??= Symbol(prefix + name));
    },
  });

class WeakReference {
  #ref: WeakRef<object>;
  #strong: object | undefined;
  #count = 0;
  constructor(object: object) {
    this.#ref = new WeakRef(object);
  }
  get() {
    return this.#ref.deref();
  }
  incRef() {
    if (this.#count++ === 0) this.#strong = this.#ref.deref();
  }
  decRef() {
    if (--this.#count === 0) this.#strong = undefined;
  }
}

const createUtilBinding = (ctx: IUtilContext) => ({
  constants: {
    kPending: K_PENDING,
    kFulfilled: K_FULFILLED,
    kRejected: K_REJECTED,
    kExiting: 0,
    kExitCode: 1,
    kHasExitCode: 2,
    ALL_PROPERTIES,
    ONLY_WRITABLE,
    ONLY_ENUMERABLE,
    ONLY_CONFIGURABLE,
    SKIP_STRINGS,
    SKIP_SYMBOLS,
    kDisallowCloneAndTransfer: 0,
    kTransferable: 1,
    kCloneable: 2,
  },
  privateSymbols: symbolTable(),
  shouldAbortOnUncaughtToggle: new Uint32Array(1),
  WeakReference,
  // A real, native SharedArrayBuffer - this sandbox's whole sync-syscall bridge is already built
  // on real ones, so there's nothing to construct beyond the platform constructor itself.
  constructSharedArrayBuffer: (byteLength: number) => new SharedArrayBuffer(byteLength),
  getPromiseDetails: () => [K_PENDING, undefined],
  getProxyDetails: () => undefined,
  getCallerLocation: () => undefined,
  getExternalValue: () => 0n,
  previewEntries,
  getOwnNonIndexProperties,
  getConstructorName,
  isInsideNodeModules: () => false,
  isConstructor: (fn: unknown) => {
    if (typeof fn !== "function") return false;
    try {
      Reflect.construct(String, [], fn as new () => unknown);
      return true;
    } catch {
      return false;
    }
  },
  arrayBufferViewHasBuffer: () => true,
  guessHandleType: (fd: number) => (fd <= 2 ? "PIPE" : "FILE"),
  toUSVString: (value: string) => {
    const text = String(value) as string & { toWellFormed?: () => string };
    return text.toWellFormed ? text.toWellFormed() : text.replace(/[\ud800-\udfff]/g, "\ufffd");
  },
  sleep: (ms: number) => {
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
  },
  defineLazyProperties: (target: any, id: string, keys: string[], enumerable = true) => {
    for (const key of keys) {
      let value: unknown;
      let loaded = false;
      Object.defineProperty(target, key, {
        __proto__: null,
        enumerable,
        configurable: true,
        get() {
          if (!loaded) {
            value = ctx.requireBuiltin(id)[key];
            loaded = true;
          }
          return value;
        },
        set(next: unknown) {
          value = next;
          loaded = true;
        },
      } as PropertyDescriptor);
    }
  },
  getCallSites: () => [],
  parseEnv: (content: string) => {
    const out: Record<string, string> = {};
    for (const line of content.split(/\r?\n/)) {
      const m = /^\s*(?:export\s+)?([\w.-]+)\s*=\s*(.*?)\s*$/.exec(line);
      if (m) out[m[1]] = m[2].replace(/^(['"`])(.*)\1$/, "$2");
    }
    return out;
  },
});

const createSymbolsBinding = () => symbolTable();

export { createSymbolsBinding, createUtilBinding, symbolTable };

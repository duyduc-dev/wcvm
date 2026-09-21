// internalBinding('buffer'): the native half of Node's lib/buffer.js, in JS.
//
// Node's lib/buffer.js and lib/internal/buffer.js are vendored verbatim and call
// these functions for everything that needs speed or byte-level work. Signatures
// and return codes follow node_buffer.cc (v24): every slice/write takes the
// target buffer as its FIRST argument, and `fill` / `atob` report failure with
// negative numbers instead of throwing.

type Bytes = Uint8Array;

// enum encoding in node.h; the index is what string_decoder.encodings maps.
export const ENCODINGS = [
  "ascii",
  "utf8",
  "base64",
  "utf16le",
  "latin1",
  "hex",
  "buffer",
  "base64url",
] as const;
const ASCII = 0;
const UTF8 = 1;
const BASE64 = 2;
const UCS2 = 3;
const LATIN1 = 4;
const HEX = 5;
const BASE64URL = 7;

const K_MAX_LENGTH = 2 ** 32;
const K_STRING_MAX_LENGTH = (1 << 29) - 24;

const encoder = new TextEncoder();
const utf8Decoder = new TextDecoder("utf-8", { ignoreBOM: true });
const strictUtf8 = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });

/**
 * A real copy. `bytes.slice()` is not: on a Node Buffer (which callers here often
 * pass) slice() returns a VIEW of the same memory, Buffer overriding the
 * Uint8Array behaviour, so go through the prototype explicitly.
 */
export const copyBytes = (bytes: Bytes): Bytes => Uint8Array.prototype.slice.call(bytes);

// Browsers reject TextDecoder on views over SharedArrayBuffer.
const unshared = (bytes: Bytes): Bytes =>
  bytes.buffer instanceof SharedArrayBuffer ? copyBytes(bytes) : bytes;

const CHUNK = 8192;
const fromCharCodes = (codes: ArrayLike<number>): string => {
  let out = "";
  for (let i = 0; i < codes.length; i += CHUNK) {
    out += String.fromCharCode.apply(
      null,
      Array.prototype.slice.call(codes, i, i + CHUNK) as number[],
    );
  }
  return out;
};

const B64 = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
const B64URL = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
const B64_LOOKUP = new Int16Array(256).fill(-1);
for (let i = 0; i < 64; i++) {
  B64_LOOKUP[B64.charCodeAt(i)] = i;
  B64_LOOKUP[B64URL.charCodeAt(i)] = i;
}

const toBase64 = (bytes: Bytes, alphabet: string, pad: boolean): string => {
  let out = "";
  let i = 0;
  for (; i + 2 < bytes.length; i += 3) {
    const n = (bytes[i] << 16) | (bytes[i + 1] << 8) | bytes[i + 2];
    out += alphabet[n >> 18] + alphabet[(n >> 12) & 63] + alphabet[(n >> 6) & 63] + alphabet[n & 63];
  }
  const rest = bytes.length - i;
  if (rest === 1) {
    const n = bytes[i] << 16;
    out += alphabet[n >> 18] + alphabet[(n >> 12) & 63] + (pad ? "==" : "");
  } else if (rest === 2) {
    const n = (bytes[i] << 16) | (bytes[i + 1] << 8);
    out += alphabet[n >> 18] + alphabet[(n >> 12) & 63] + alphabet[(n >> 6) & 63] + (pad ? "=" : "");
  }
  return out;
};

/** Lenient decode like Node: either alphabet, skips junk, stops at '='. */
const fromBase64 = (text: string): Bytes => {
  const out = new Uint8Array(Math.ceil((text.length * 3) / 4));
  let bits = 0;
  let acc = 0;
  let n = 0;
  for (let i = 0; i < text.length; i++) {
    const code = text.charCodeAt(i);
    if (code === 61 /* = */) break;
    const v = code < 256 ? B64_LOOKUP[code] : -1;
    if (v < 0) continue;
    acc = (acc << 6) | v;
    bits += 6;
    if (bits >= 8) {
      bits -= 8;
      out[n++] = (acc >> bits) & 0xff;
      acc &= (1 << bits) - 1;
    }
  }
  return out.subarray(0, n);
};

const HEX_CHARS = "0123456789abcdef";
const hexDigit = (code: number): number => {
  if (code >= 48 && code <= 57) return code - 48;
  if (code >= 97 && code <= 102) return code - 87;
  if (code >= 65 && code <= 70) return code - 55;
  return -1;
};

const clampRange = (buf: Bytes, start?: number, end?: number): [number, number] => {
  const s = Math.max(0, Math.min(start ?? 0, buf.length));
  const e = Math.max(s, Math.min(end ?? buf.length, buf.length));
  return [s, e];
};

// ---- slices: (buf, start, end) -> string ------------------------------------

const utf8Slice = (buf: Bytes, start?: number, end?: number) => {
  const [s, e] = clampRange(buf, start, end);
  return utf8Decoder.decode(unshared(buf.subarray(s, e)));
};
const latin1Slice = (buf: Bytes, start?: number, end?: number) => {
  const [s, e] = clampRange(buf, start, end);
  return fromCharCodes(buf.subarray(s, e));
};
const asciiSlice = (buf: Bytes, start?: number, end?: number) => {
  const [s, e] = clampRange(buf, start, end);
  const codes = new Uint8Array(e - s);
  for (let i = s; i < e; i++) codes[i - s] = buf[i] & 0x7f;
  return fromCharCodes(codes);
};
const ucs2Slice = (buf: Bytes, start?: number, end?: number) => {
  const [s, e] = clampRange(buf, start, end);
  const units = new Uint16Array((e - s) >> 1);
  for (let i = 0; i < units.length; i++) units[i] = buf[s + 2 * i] | (buf[s + 2 * i + 1] << 8);
  return fromCharCodes(units);
};
const hexSlice = (buf: Bytes, start?: number, end?: number) => {
  const [s, e] = clampRange(buf, start, end);
  let out = "";
  for (let i = s; i < e; i++) out += HEX_CHARS[buf[i] >> 4] + HEX_CHARS[buf[i] & 15];
  return out;
};
const base64Slice = (buf: Bytes, start?: number, end?: number) => {
  const [s, e] = clampRange(buf, start, end);
  return toBase64(buf.subarray(s, e), B64, true);
};
const base64urlSlice = (buf: Bytes, start?: number, end?: number) => {
  const [s, e] = clampRange(buf, start, end);
  return toBase64(buf.subarray(s, e), B64URL, false);
};

// ---- writes: (buf, string, offset, length) -> bytes written -------------------

const window = (buf: Bytes, offset?: number, length?: number): Bytes => {
  const start = Math.max(0, Math.min(offset ?? 0, buf.length));
  const max = buf.length - start;
  const len = length === undefined ? max : Math.max(0, Math.min(length, max));
  return buf.subarray(start, start + len);
};

const utf8Write = (buf: Bytes, string: string, offset?: number, length?: number) =>
  encoder.encodeInto(string, window(buf, offset, length)).written;

const latin1Write = (buf: Bytes, string: string, offset?: number, length?: number) => {
  const target = window(buf, offset, length);
  const n = Math.min(string.length, target.length);
  for (let i = 0; i < n; i++) target[i] = string.charCodeAt(i) & 0xff;
  return n;
};

const ucs2Write = (buf: Bytes, string: string, offset?: number, length?: number) => {
  const target = window(buf, offset, length);
  const n = Math.min(string.length, target.length >> 1);
  for (let i = 0; i < n; i++) {
    const c = string.charCodeAt(i);
    target[2 * i] = c & 0xff;
    target[2 * i + 1] = c >> 8;
  }
  return n * 2;
};

const hexWrite = (buf: Bytes, string: string, offset?: number, length?: number) => {
  const target = window(buf, offset, length);
  const pairs = Math.min(string.length >> 1, target.length);
  let n = 0;
  for (; n < pairs; n++) {
    const hi = hexDigit(string.charCodeAt(2 * n));
    const lo = hexDigit(string.charCodeAt(2 * n + 1));
    if (hi < 0 || lo < 0) break;
    target[n] = (hi << 4) | lo;
  }
  return n;
};

const base64Write = (buf: Bytes, string: string, offset?: number, length?: number) => {
  const target = window(buf, offset, length);
  const bytes = fromBase64(string);
  const n = Math.min(bytes.length, target.length);
  target.set(bytes.subarray(0, n));
  return n;
};

// ---- encoding strings to bytes (for fill / indexOf) --------------------------

const encodeString = (string: string, encoding: number): Bytes => {
  switch (encoding) {
    case UCS2: {
      const out = new Uint8Array(string.length * 2);
      ucs2Write(out, string);
      return out;
    }
    case LATIN1:
    case ASCII: {
      const out = new Uint8Array(string.length);
      latin1Write(out, string);
      return out;
    }
    case HEX: {
      const out = new Uint8Array(string.length >> 1);
      return out.subarray(0, hexWrite(out, string));
    }
    case BASE64:
    case BASE64URL:
      return fromBase64(string);
    case UTF8:
    default:
      return encoder.encode(string);
  }
};

// ---- searching --------------------------------------------------------------

/** Mirrors node_buffer.cc IndexOfOffset. Returns -1 when the search cannot start. */
const searchStart = (length: number, offset: number, needleLength: number, forward: boolean): number => {
  if (offset < 0) {
    if (offset + length >= 0) return length + offset;
    return forward || needleLength === 0 ? 0 : -1;
  }
  if (offset + needleLength <= length) return offset;
  if (needleLength === 0) return length;
  return forward ? -1 : length - 1;
};

const indexOfBytes = (hay: Bytes, needle: Bytes, offset: number, forward: boolean, step = 1): number => {
  if (hay.length === 0) return -1;
  const start = searchStart(hay.length, offset, needle.length, forward);
  if (start === -1) return -1;
  if (needle.length === 0) return start;
  if (needle.length > hay.length) return -1;

  const matches = (at: number) => {
    for (let j = 0; j < needle.length; j++) if (hay[at + j] !== needle[j]) return false;
    return true;
  };
  const last = hay.length - needle.length;
  if (forward) {
    for (let i = start; i <= last; i++) if (i % step === 0 && matches(i)) return i;
  } else {
    for (let i = Math.min(start, last); i >= 0; i--) if (i % step === 0 && matches(i)) return i;
  }
  return -1;
};

const indexOfString = (buf: Bytes, value: string, offset: number, encoding: number, forward: boolean) =>
  indexOfBytes(buf, encodeString(value, encoding), offset, forward, encoding === UCS2 ? 2 : 1);

const indexOfBuffer = (buf: Bytes, value: Bytes, offset: number, encoding: number, forward: boolean) =>
  indexOfBytes(buf, value, offset, forward, encoding === UCS2 ? 2 : 1);

const indexOfNumber = (buf: Bytes, value: number, offset: number, forward: boolean) =>
  indexOfBytes(buf, Uint8Array.of(value & 0xff), offset, forward);

// ---- the rest -----------------------------------------------------------------

const compare = (a: Bytes, b: Bytes): number => {
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) if (a[i] !== b[i]) return a[i] < b[i] ? -1 : 1;
  return a.length === b.length ? 0 : a.length < b.length ? -1 : 1;
};

const compareOffset = (
  source: Bytes,
  target: Bytes,
  targetStart: number,
  sourceStart: number,
  targetEnd: number,
  sourceEnd: number,
): number =>
  compare(
    source.subarray(sourceStart, Math.min(sourceEnd, source.length)),
    target.subarray(targetStart, Math.min(targetEnd, target.length)),
  );

const copy = (source: Bytes, target: Bytes, targetStart: number, sourceStart: number, nb: number) => {
  target.set(source.subarray(sourceStart, sourceStart + nb), targetStart);
  return nb;
};

/** Returns undefined on success, -1 for an unusable fill value, -2 for a bad range. */
const fill = (buf: Bytes, value: string | Bytes | number, offset: number, end: number, encoding?: string) => {
  if (offset < 0 || end > buf.length) return -2;
  if (offset >= end) return undefined;

  let pattern: Bytes;
  if (typeof value === "string") {
    const index = ENCODINGS.indexOf((encoding ?? "utf8") as (typeof ENCODINGS)[number]);
    pattern = encodeString(value, index === -1 ? UTF8 : index);
  } else if (typeof value === "number") {
    pattern = Uint8Array.of(value & 0xff);
  } else {
    pattern = value;
  }
  if (pattern.length === 0) return -1;

  const target = buf.subarray(offset, end);
  for (let i = 0; i < target.length; i++) target[i] = pattern[i % pattern.length];
  return undefined;
};

const swap = (width: number) => (buf: Bytes) => {
  for (let i = 0; i + width <= buf.length; i += width) {
    for (let a = i, b = i + width - 1; a < b; a++, b--) {
      const t = buf[a];
      buf[a] = buf[b];
      buf[b] = t;
    }
  }
  return buf;
};

const byteLengthUtf8 = (string: string): number => {
  let bytes = 0;
  for (let i = 0; i < string.length; i++) {
    const c = string.charCodeAt(i);
    if (c < 0x80) bytes += 1;
    else if (c < 0x800) bytes += 2;
    else if (c >= 0xd800 && c <= 0xdbff && i + 1 < string.length &&
             (string.charCodeAt(i + 1) & 0xfc00) === 0xdc00) {
      bytes += 4;
      i++;
    } else bytes += 3;
  }
  return bytes;
};

const isUtf8 = (input: Bytes | ArrayBuffer): boolean => {
  try {
    strictUtf8.decode(unshared(input instanceof ArrayBuffer ? new Uint8Array(input) : input));
    return true;
  } catch {
    return false;
  }
};
const isAscii = (input: Bytes | ArrayBuffer): boolean => {
  const bytes = input instanceof ArrayBuffer ? new Uint8Array(input) : input;
  for (let i = 0; i < bytes.length; i++) if (bytes[i] > 0x7f) return false;
  return true;
};

/** WHATWG forgiving-base64 decode to a binary string; -1/-2/-3 like node_buffer.cc. */
const atob = (input: string): string | number => {
  const text = input.replace(/[\t\n\f\r ]/g, "");
  let s = text;
  if (s.length % 4 === 0) s = s.replace(/={1,2}$/, "");
  if (s.length % 4 === 1) return -1;
  if (/[^A-Za-z0-9+/]/.test(s)) return -2;
  return fromCharCodes(fromBase64(s));
};

const btoa = (input: string): string | number => {
  const bytes = new Uint8Array(input.length);
  for (let i = 0; i < input.length; i++) {
    const c = input.charCodeAt(i);
    if (c > 255) return -1;
    bytes[i] = c;
  }
  return toBase64(bytes, B64, true);
};

const createBufferBinding = () => ({
  kMaxLength: K_MAX_LENGTH,
  kStringMaxLength: K_STRING_MAX_LENGTH,
  atob,
  btoa,
  asciiSlice,
  base64Slice,
  base64urlSlice,
  latin1Slice,
  hexSlice,
  ucs2Slice,
  utf8Slice,
  asciiWriteStatic: latin1Write,
  latin1WriteStatic: latin1Write,
  utf8WriteStatic: utf8Write,
  base64Write,
  base64urlWrite: base64Write,
  hexWrite,
  ucs2Write,
  byteLengthUtf8,
  compare,
  compareOffset,
  copy,
  fill,
  indexOfBuffer,
  indexOfNumber,
  indexOfString,
  isAscii,
  isUtf8,
  swap16: swap(2),
  swap32: swap(4),
  swap64: swap(8),
  createUnsafeArrayBuffer: (size: number) => new ArrayBuffer(size),
  setDetachKey: () => {},
});

export { createBufferBinding };

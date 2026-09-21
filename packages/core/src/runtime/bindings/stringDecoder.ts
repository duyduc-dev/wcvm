// internalBinding('string_decoder'): the native StringDecoder core.
//
// Node keeps the decoder's state in a small Buffer that C++ manipulates:
//   [0..3] bytes of an incomplete character   [4] bytes still missing
//   [5]    bytes currently buffered           [6] encoding (enum)
// lib/string_decoder.js only reads those fields and calls decode()/flush(), so
// this follows string_decoder.cc: hold back a trailing partial character, decode
// the rest, and complete it when more bytes arrive.

import { copyBytes, createBufferBinding, ENCODINGS } from "./buffer";

const K_INCOMPLETE_START = 0;
const K_INCOMPLETE_END = 4;
const K_MISSING_BYTES = 4;
const K_BUFFERED_BYTES = 5;
const K_ENCODING_FIELD = 6;
const K_NUM_FIELDS = 7;

const UTF8 = 1;
const BASE64 = 2;
const UCS2 = 3;
const BASE64URL = 7;

const utf8Decoder = new TextDecoder("utf-8", { ignoreBOM: true });

const createStringDecoderBinding = () => {
  const codec = createBufferBinding();

  const slice = (encoding: number, bytes: Uint8Array): string => {
    switch (ENCODINGS[encoding]) {
      case "utf8":
        return utf8Decoder.decode(bytes);
      case "utf16le":
        return codec.ucs2Slice(bytes);
      case "base64":
        return codec.base64Slice(bytes);
      case "base64url":
        return codec.base64urlSlice(bytes);
      case "hex":
        return codec.hexSlice(bytes);
      case "ascii":
        return codec.asciiSlice(bytes);
      default:
        return codec.latin1Slice(bytes);
    }
  };

  /** Length of a trailing UTF-8 sequence that is a valid but unfinished prefix, and how many bytes it still needs. */
  const utf8Tail = (data: Uint8Array): { length: number; missing: number } => {
    for (let k = 1; k <= Math.min(3, data.length); k++) {
      const byte = data[data.length - k];
      if ((byte & 0xc0) === 0x80) continue; // continuation byte: keep looking back
      if (byte < 0xc0) break; // ASCII
      const expected = byte >= 0xf0 ? 4 : byte >= 0xe0 ? 3 : 2;
      return k < expected ? { length: k, missing: expected - k } : { length: 0, missing: 0 };
    }
    return { length: 0, missing: 0 };
  };

  const split = (encoding: number, data: Uint8Array): { keep: number; missing: number } => {
    if (encoding === UTF8) {
      const { length, missing } = utf8Tail(data);
      return { keep: length, missing };
    }
    if (encoding === UCS2) {
      let keep = data.length % 2;
      const complete = data.length - keep;
      // A high surrogate at the end must wait for its low half.
      if (complete >= 2) {
        const unit = data[complete - 2] | (data[complete - 1] << 8);
        if (unit >= 0xd800 && unit <= 0xdbff) keep += 2;
      }
      return { keep, missing: keep === 0 ? 0 : keep % 2 === 1 ? 1 : 2 };
    }
    if (encoding === BASE64 || encoding === BASE64URL) {
      const keep = data.length % 3;
      return { keep, missing: keep === 0 ? 0 : 3 - keep };
    }
    return { keep: 0, missing: 0 };
  };

  const decode = (state: Uint8Array, input: ArrayBufferView): string => {
    const encoding = state[K_ENCODING_FIELD];
    const chunk = new Uint8Array(input.buffer, input.byteOffset, input.byteLength);
    const buffered = state[K_BUFFERED_BYTES];

    let data = chunk;
    if (buffered > 0) {
      data = new Uint8Array(buffered + chunk.length);
      data.set(state.subarray(K_INCOMPLETE_START, K_INCOMPLETE_START + buffered), 0);
      data.set(chunk, buffered);
    }

    const { keep, missing } = split(encoding, data);
    const body = data.subarray(0, data.length - keep);
    state.fill(0, K_INCOMPLETE_START, K_INCOMPLETE_END);
    state.set(data.subarray(data.length - keep), K_INCOMPLETE_START);
    state[K_BUFFERED_BYTES] = keep;
    state[K_MISSING_BYTES] = missing;
    return slice(encoding, body);
  };

  const flush = (state: Uint8Array): string => {
    const encoding = state[K_ENCODING_FIELD];
    let buffered = state[K_BUFFERED_BYTES];
    // Like the JS decoder, a single dangling byte of UTF-16 is dropped.
    if (encoding === UCS2 && buffered % 2 === 1) buffered--;
    // `state` is a Buffer: copy explicitly, or zeroing it below would zero the tail too.
    const tail = copyBytes(state.subarray(K_INCOMPLETE_START, K_INCOMPLETE_START + buffered));
    state[K_MISSING_BYTES] = 0;
    state[K_BUFFERED_BYTES] = 0;
    state.fill(0, K_INCOMPLETE_START, K_INCOMPLETE_END);
    return tail.length === 0 ? "" : slice(encoding, tail);
  };

  return {
    encodings: [...ENCODINGS],
    kIncompleteCharactersStart: K_INCOMPLETE_START,
    kIncompleteCharactersEnd: K_INCOMPLETE_END,
    kMissingBytes: K_MISSING_BYTES,
    kBufferedBytes: K_BUFFERED_BYTES,
    kEncodingField: K_ENCODING_FIELD,
    kNumFields: K_NUM_FIELDS,
    kSize: K_NUM_FIELDS,
    decode,
    flush,
  };
};

export { createStringDecoderBinding };

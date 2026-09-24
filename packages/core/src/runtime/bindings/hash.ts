// `crypto.createHash()`'s digests, in plain JS, synchronously, in the process's own thread. The Web
// Crypto API can't back them: `SubtleCrypto.digest()` is async-only and one-shot (no incremental
// update(), so the whole input had to be shipped to the kernel in one piece - over the 1 MiB
// sync-call window, which a 1 MiB+ file Vite etags simply didn't fit). These are the standard
// Merkle-Damgard algorithms, checked against Node's own crypto on random inputs of every length
// class (bindings/hash.test.ts).
//
// The SHA-2 round constants and initial values are DERIVED from their definitions - the first 32
// or 64 bits of the fractional parts of the square/cube roots of the first primes (FIPS 180-4
// 4.2.2/4.2.3, 5.3) - computed exactly with BigInt once at load, instead of transcribing ~200 hex
// constants by hand.

export interface IHasher {
  update(data: Uint8Array): void;
  /** Finishes and returns the digest; the hasher is spent afterwards. */
  digest(): Uint8Array;
  copy(): IHasher;
}

const PRIMES = (() => {
  const primes: number[] = [];
  for (let n = 2; primes.length < 80; n++) if (primes.every((p) => n % p !== 0)) primes.push(n);
  return primes.map(BigInt);
})();

/** floor(value^(1/k)) for a BigInt, by Newton's method. */
const integerRoot = (value: bigint, k: bigint): bigint => {
  let x = 1n << (BigInt(value.toString(2).length) / k + 1n);
  for (;;) {
    const next = ((k - 1n) * x + value / x ** (k - 1n)) / k;
    if (next >= x) return x;
    x = next;
  }
};

/** The first `bits` bits of the fractional part of p^(1/k). */
const fractionBits = (p: bigint, k: bigint, bits: bigint): bigint => {
  const scaled = integerRoot(p << (bits * k), k); // floor(p^(1/k) * 2^bits)
  return scaled - (integerRoot(p, k) << bits);
};

const MASK32 = (1n << 32n) - 1n;
const words64 = (values: bigint[]): Int32Array => {
  const out = new Int32Array(values.length * 2);
  values.forEach((v, i) => {
    out[2 * i] = Number((v >> 32n) & MASK32) | 0;
    out[2 * i + 1] = Number(v & MASK32) | 0;
  });
  return out;
};

const K512 = words64(PRIMES.slice(0, 80).map((p) => fractionBits(p, 3n, 64n)));
const K256 = Int32Array.from(PRIMES.slice(0, 64).map((p) => Number(fractionBits(p, 3n, 32n)) | 0));
const IV512 = words64(PRIMES.slice(0, 8).map((p) => fractionBits(p, 2n, 64n)));
const IV384 = words64(PRIMES.slice(8, 16).map((p) => fractionBits(p, 2n, 64n)));
const IV256 = Int32Array.from(PRIMES.slice(0, 8).map((p) => Number(fractionBits(p, 2n, 32n)) | 0));
// SHA-224's are the LOW 32 bits of the same roots SHA-384 takes 64 bits of (FIPS 180-4 5.3.2).
const IV224 = Int32Array.from(PRIMES.slice(8, 16).map((p) => Number(fractionBits(p, 2n, 64n) & MASK32) | 0));

// MD5's per-step constants are floor(|sin(i + 1)| * 2^32) (RFC 1321 3.4) - exact in doubles.
const MD5_K = Int32Array.from({ length: 64 }, (_, i) => Math.floor(Math.abs(Math.sin(i + 1)) * 2 ** 32) | 0);
const MD5_S = [7, 12, 17, 22, 5, 9, 14, 20, 4, 11, 16, 23, 6, 10, 15, 21];

const rotl = (x: number, n: number) => (x << n) | (x >>> (32 - n));
const rotr = (x: number, n: number) => (x >>> n) | (x << (32 - n));

/** Block buffering and padding, shared by every algorithm here. */
// Plain fields, no TS parameter properties: node's own type stripping (scripts/discover-node-lib.mjs
// loads the bindings directly) only accepts erasable syntax - see CLAUDE.md's gotchas.
abstract class BlockHasher implements IHasher {
  protected readonly block: Uint8Array;
  protected readonly view: DataView;
  private readonly blockSize: number;
  private readonly lengthBytes: number;
  private readonly littleEndian: boolean;
  private filled = 0;
  private length = 0; // bytes hashed so far
  private done = false;

  constructor(blockSize: number, lengthBytes: number, littleEndian: boolean) {
    this.blockSize = blockSize;
    this.lengthBytes = lengthBytes;
    this.littleEndian = littleEndian;
    this.block = new Uint8Array(blockSize);
    this.view = new DataView(this.block.buffer);
  }

  protected abstract compress(): void;
  protected abstract output(): Uint8Array;
  protected abstract clone(): BlockHasher;

  update(data: Uint8Array): void {
    this.length += data.length;
    let offset = 0;
    while (offset < data.length) {
      const take = Math.min(this.blockSize - this.filled, data.length - offset);
      this.block.set(data.subarray(offset, offset + take), this.filled);
      this.filled += take;
      offset += take;
      if (this.filled === this.blockSize) {
        this.compress();
        this.filled = 0;
      }
    }
  }

  digest(): Uint8Array {
    if (this.done) throw new Error("Digest already called");
    this.done = true;
    const bitLength = this.length * 8;
    this.block[this.filled++] = 0x80;
    if (this.filled > this.blockSize - this.lengthBytes) {
      this.block.fill(0, this.filled);
      this.compress();
      this.filled = 0;
    }
    this.block.fill(0, this.filled);
    // The message length in bits, in the last 8 bytes (anything above 2^53 bits is out of reach).
    const high = Math.floor(bitLength / 2 ** 32);
    const low = bitLength >>> 0;
    if (this.littleEndian) {
      this.view.setUint32(this.blockSize - 8, low, true);
      this.view.setUint32(this.blockSize - 4, high, true);
    } else {
      this.view.setUint32(this.blockSize - 8, high);
      this.view.setUint32(this.blockSize - 4, low);
    }
    this.compress();
    return this.output();
  }

  copy(): IHasher {
    const twin = this.clone();
    twin.block.set(this.block);
    twin.filled = this.filled;
    twin.length = this.length;
    twin.done = this.done;
    return twin;
  }
}

class Md5 extends BlockHasher {
  state = Int32Array.of(0x67452301, 0xefcdab89 | 0, 0x98badcfe | 0, 0x10325476);
  private readonly m = new Int32Array(16);
  constructor() {
    super(64, 8, true);
  }
  protected compress() {
    const { m, state } = this;
    for (let i = 0; i < 16; i++) m[i] = this.view.getInt32(i * 4, true);
    let [a, b, c, d] = state;
    for (let i = 0; i < 64; i++) {
      let f: number;
      let g: number;
      if (i < 16) [f, g] = [(b & c) | (~b & d), i];
      else if (i < 32) [f, g] = [(d & b) | (~d & c), (5 * i + 1) % 16];
      else if (i < 48) [f, g] = [b ^ c ^ d, (3 * i + 5) % 16];
      else [f, g] = [c ^ (b | ~d), (7 * i) % 16];
      const next = (b + rotl((a + f + MD5_K[i] + m[g]) | 0, MD5_S[(i >> 4) * 4 + (i % 4)])) | 0;
      [a, d, c, b] = [d, c, b, next];
    }
    state[0] += a;
    state[1] += b;
    state[2] += c;
    state[3] += d;
  }
  protected output() {
    const out = new DataView(new ArrayBuffer(16));
    this.state.forEach((word, i) => out.setInt32(i * 4, word, true));
    return new Uint8Array(out.buffer);
  }
  protected clone() {
    const twin = new Md5();
    twin.state.set(this.state);
    return twin;
  }
}

class Sha1 extends BlockHasher {
  state = Int32Array.of(0x67452301, 0xefcdab89 | 0, 0x98badcfe | 0, 0x10325476, 0xc3d2e1f0 | 0);
  private readonly w = new Int32Array(80);
  constructor() {
    super(64, 8, false);
  }
  protected compress() {
    const { w, state } = this;
    for (let i = 0; i < 16; i++) w[i] = this.view.getInt32(i * 4);
    for (let i = 16; i < 80; i++) w[i] = rotl(w[i - 3] ^ w[i - 8] ^ w[i - 14] ^ w[i - 16], 1);
    let [a, b, c, d, e] = state;
    for (let i = 0; i < 80; i++) {
      let f: number;
      let k: number;
      if (i < 20) [f, k] = [(b & c) | (~b & d), 0x5a827999];
      else if (i < 40) [f, k] = [b ^ c ^ d, 0x6ed9eba1];
      else if (i < 60) [f, k] = [(b & c) | (b & d) | (c & d), 0x8f1bbcdc | 0];
      else [f, k] = [b ^ c ^ d, 0xca62c1d6 | 0];
      const t = (rotl(a, 5) + f + e + k + w[i]) | 0;
      [e, d, c, b, a] = [d, c, rotl(b, 30), a, t];
    }
    state[0] += a;
    state[1] += b;
    state[2] += c;
    state[3] += d;
    state[4] += e;
  }
  protected output() {
    return bigEndian(this.state, 20);
  }
  protected clone() {
    const twin = new Sha1();
    twin.state.set(this.state);
    return twin;
  }
}

const bigEndian = (words: Int32Array, bytes: number): Uint8Array => {
  const out = new DataView(new ArrayBuffer(words.length * 4));
  words.forEach((word, i) => out.setInt32(i * 4, word));
  return new Uint8Array(out.buffer, 0, bytes);
};

class Sha256 extends BlockHasher {
  readonly state: Int32Array;
  private readonly w = new Int32Array(64);
  private readonly outputBytes: number;
  constructor(iv: Int32Array, outputBytes: number) {
    super(64, 8, false);
    this.state = Int32Array.from(iv);
    this.outputBytes = outputBytes;
  }
  protected compress() {
    const { w, state } = this;
    for (let i = 0; i < 16; i++) w[i] = this.view.getInt32(i * 4);
    for (let i = 16; i < 64; i++) {
      const s0 = rotr(w[i - 15], 7) ^ rotr(w[i - 15], 18) ^ (w[i - 15] >>> 3);
      const s1 = rotr(w[i - 2], 17) ^ rotr(w[i - 2], 19) ^ (w[i - 2] >>> 10);
      w[i] = (w[i - 16] + s0 + w[i - 7] + s1) | 0;
    }
    let [a, b, c, d, e, f, g, h] = state;
    for (let i = 0; i < 64; i++) {
      const t1 = (h + (rotr(e, 6) ^ rotr(e, 11) ^ rotr(e, 25)) + ((e & f) ^ (~e & g)) + K256[i] + w[i]) | 0;
      const t2 = ((rotr(a, 2) ^ rotr(a, 13) ^ rotr(a, 22)) + ((a & b) ^ (a & c) ^ (b & c))) | 0;
      [h, g, f, e, d, c, b, a] = [g, f, e, (d + t1) | 0, c, b, a, (t1 + t2) | 0];
    }
    [a, b, c, d, e, f, g, h].forEach((v, i) => (state[i] += v));
  }
  protected output() {
    return bigEndian(this.state, this.outputBytes);
  }
  protected clone() {
    const twin = new Sha256(this.state, this.outputBytes);
    return twin;
  }
}

/** SHA-512/384: 64-bit words as (high, low) Int32 pairs - BigInt per round would be far too slow. */
class Sha512 extends BlockHasher {
  readonly state: Int32Array;
  private readonly w = new Int32Array(160);
  private readonly outputBytes: number;
  constructor(iv: Int32Array, outputBytes: number) {
    super(128, 16, false);
    this.state = Int32Array.from(iv);
    this.outputBytes = outputBytes;
  }
  protected compress() {
    const { w, state } = this;
    for (let i = 0; i < 32; i++) w[i] = this.view.getInt32(i * 4);
    // (hi, lo) helpers: rotate/shift a 64-bit value right, and add with carry.
    const rotrHi = (h: number, l: number, n: number) => (n < 32 ? (h >>> n) | (l << (32 - n)) : (l >>> (n - 32)) | (h << (64 - n)));
    const rotrLo = (h: number, l: number, n: number) => (n < 32 ? (l >>> n) | (h << (32 - n)) : (h >>> (n - 32)) | (l << (64 - n)));
    const shrHi = (h: number, _l: number, n: number) => h >>> n;
    const shrLo = (h: number, l: number, n: number) => (l >>> n) | (h << (32 - n));
    const add = (pairs: number[]): [number, number] => {
      let lo = 0;
      let hi = 0;
      for (let i = 0; i < pairs.length; i += 2) {
        const sum = (lo >>> 0) + (pairs[i + 1] >>> 0);
        hi = (hi + pairs[i] + Math.floor(sum / 2 ** 32)) | 0;
        lo = sum | 0;
      }
      return [hi, lo];
    };
    for (let i = 16; i < 80; i++) {
      const [h15, l15] = [w[2 * (i - 15)], w[2 * (i - 15) + 1]];
      const [h2, l2] = [w[2 * (i - 2)], w[2 * (i - 2) + 1]];
      const s0h = rotrHi(h15, l15, 1) ^ rotrHi(h15, l15, 8) ^ shrHi(h15, l15, 7);
      const s0l = rotrLo(h15, l15, 1) ^ rotrLo(h15, l15, 8) ^ shrLo(h15, l15, 7);
      const s1h = rotrHi(h2, l2, 19) ^ rotrHi(h2, l2, 61) ^ shrHi(h2, l2, 6);
      const s1l = rotrLo(h2, l2, 19) ^ rotrLo(h2, l2, 61) ^ shrLo(h2, l2, 6);
      [w[2 * i], w[2 * i + 1]] = add([w[2 * (i - 16)], w[2 * (i - 16) + 1], s0h, s0l, w[2 * (i - 7)], w[2 * (i - 7) + 1], s1h, s1l]);
    }
    const v = Array.from(state);
    for (let i = 0; i < 80; i++) {
      const [ah, al, bh, bl, ch, cl, dh, dl, eh, el, fh, fl, gh, gl, hh, hl] = v;
      const S1h = rotrHi(eh, el, 14) ^ rotrHi(eh, el, 18) ^ rotrHi(eh, el, 41);
      const S1l = rotrLo(eh, el, 14) ^ rotrLo(eh, el, 18) ^ rotrLo(eh, el, 41);
      const chh = (eh & fh) ^ (~eh & gh);
      const chl = (el & fl) ^ (~el & gl);
      const t1 = add([hh, hl, S1h, S1l, chh, chl, K512[2 * i], K512[2 * i + 1], w[2 * i], w[2 * i + 1]]);
      const S0h = rotrHi(ah, al, 28) ^ rotrHi(ah, al, 34) ^ rotrHi(ah, al, 39);
      const S0l = rotrLo(ah, al, 28) ^ rotrLo(ah, al, 34) ^ rotrLo(ah, al, 39);
      const majh = (ah & bh) ^ (ah & ch) ^ (bh & ch);
      const majl = (al & bl) ^ (al & cl) ^ (bl & cl);
      const t2 = add([S0h, S0l, majh, majl]);
      const e = add([dh, dl, ...t1]);
      const a = add([...t1, ...t2]);
      v.splice(0, 16, a[0], a[1], ah, al, bh, bl, ch, cl, e[0], e[1], eh, el, fh, fl, gh, gl);
    }
    for (let i = 0; i < 16; i += 2) [state[i], state[i + 1]] = add([state[i], state[i + 1], v[i], v[i + 1]]);
  }
  protected output() {
    return bigEndian(this.state, this.outputBytes);
  }
  protected clone() {
    return new Sha512(this.state, this.outputBytes);
  }
}

const FACTORIES: Record<string, () => IHasher> = {
  md5: () => new Md5(),
  sha1: () => new Sha1(),
  sha224: () => new Sha256(IV224, 28),
  sha256: () => new Sha256(IV256, 32),
  sha384: () => new Sha512(IV384, 48),
  sha512: () => new Sha512(IV512, 64),
};

/** Node's own spellings, case-insensitively, plus the WebCrypto-style `SHA-256` ones. */
export const normalizeHashName = (name: string): string => name.toLowerCase().replace(/^sha-/, "sha");

export const HASH_ALGORITHMS = Object.keys(FACTORIES);

/** A fresh hasher for `algorithm`, or undefined if it isn't one of HASH_ALGORITHMS. */
export const createHasher = (algorithm: string): IHasher | undefined => FACTORIES[normalizeHashName(algorithm)]?.();

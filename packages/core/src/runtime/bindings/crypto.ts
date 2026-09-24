// internalBinding('crypto'): NOT real Node's crypto binding. Real crypto.js unconditionally
// requires ~15 internal modules at load time (cipher, sig, hash, x509, certificate, kem,
// webcrypto, random, argon2, pbkdf2, scrypt, hkdf, keygen, keys, diffiehellman) just to be
// require()-able at all, most needing native-crypto features (KeyObject/PEM export, X.509
// certificates, DiffieHellman groups, scrypt, argon2) the Web Crypto API this sandbox would have
// to back them with simply doesn't have equivalents for - a vendoring job far bigger than this
// sandbox's actual need (hashing and randomness). So `crypto` is a narrow, hand-written module
// (runtime/shims.ts's cryptoShim, in the same "deliberately simplified real module" category as
// dns/cluster there); this file only hands it the synchronous, incremental hashers it's built on
// (bindings/hash.ts - plain JS, since SubtleCrypto.digest() is async-only and one-shot).

import { HASH_ALGORITHMS, createHasher } from "./hash";

export const createCryptoBinding = () => ({ createHasher, hashAlgorithms: HASH_ALGORITHMS });

// internalBinding('crypto'): NOT real Node's crypto binding. Real crypto.js unconditionally
// requires ~15 internal modules at load time (cipher, sig, hash, x509, certificate, kem,
// webcrypto, random, argon2, pbkdf2, scrypt, hkdf, keygen, keys, diffiehellman) just to be
// require()-able at all, most needing native-crypto features (KeyObject/PEM export, X.509
// certificates, DiffieHellman groups, scrypt, argon2) the Web Crypto API this sandbox would have
// to back them with simply doesn't have equivalents for - a vendoring job far bigger than this
// sandbox's actual need (real npm's sha512/sha1 package integrity checks). So `crypto` is a
// narrow, hand-written module (runtime/shims.ts's cryptoShim, in the same "deliberately
// simplified real module" category as dns/cluster there) rather than real vendored source; this
// file is only the one genuinely blocking primitive it needs: a synchronous digest, the same
// shape zlib's own OP_ZLIB_SYNC bridges (see protocols/syscall.ts's OP_CRYPTO_DIGEST_SYNC).

import { OP_CRYPTO_DIGEST_SYNC, encodeRequest, encodeString, type ISyscallClient } from "../../protocols/syscall";

export interface ICryptoBindingContext {
  /** Backs the blocking digestSync(); without it, it throws. Real process workers always wire
   *  this (same as execSync/spawnSync/zlib's own *Sync family). */
  spawnSync?: ISyscallClient;
}

export const createCryptoBinding = (ctx: ICryptoBindingContext) => {
  const digestSync = (algorithm: string, data: Uint8Array): Uint8Array => {
    if (!ctx.spawnSync) throw new Error("crypto digest operations need a spawnSync client");
    const request = encodeRequest([encodeString(algorithm), data]);
    return ctx.spawnSync.call(OP_CRYPTO_DIGEST_SYNC, request);
  };
  return { digestSync };
};

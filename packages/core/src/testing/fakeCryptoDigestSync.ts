// A real (but not SubtleCrypto-backed) synchronous digest, standing in for the kernel's
// OP_CRYPTO_DIGEST_SYNC servicer in tests, the same way zlib.test.ts's createFakeZlibSync stands in
// for the kernel's OP_ZLIB_SYNC one: proves the binding's request/response wire encoding is
// correct, not that SubtleCrypto.digest() itself works (that needs a real browser - see the
// Chromium e2e test). SHA-1/256/384/512 are standard, interoperable algorithms, so Node's own
// crypto is a valid stand-in for whatever actually computes these bytes.

import nodeCrypto from "node:crypto";
import { OP_CRYPTO_DIGEST_SYNC, SyscallError, decodeBytes, decodeRequest, type ISyscallClient } from "../protocols/syscall";

export const createFakeCryptoDigestSync = (): ISyscallClient => ({
  call: (opcode, request) => {
    if (opcode !== OP_CRYPTO_DIGEST_SYNC) throw new SyscallError("ENOSYS");
    const { fields } = decodeRequest(request);
    const [algorithmBytes, input] = fields;
    const nodeAlgorithm = decodeBytes(algorithmBytes).replace("SHA-", "sha");
    return new Uint8Array(nodeCrypto.createHash(nodeAlgorithm).update(input).digest());
  },
});

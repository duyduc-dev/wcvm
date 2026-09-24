import nodeCrypto from "node:crypto";
import { describe, expect, it } from "vitest";
import { runScript } from "../harness";

// Hashing needs nothing from the kernel any more (bindings/hash.ts - plain synchronous JS), so
// these run with no spawnSync client at all.
const run = (source: string) => runScript({ "/app/main.js": source }, "/app/main.js", { cwd: "/app" });

describe("crypto (hand-written shim)", () => {
  it("createHash('sha256').update().digest('hex') matches a known SHA-256 vector", async () => {
    const r = await run(
      `
      const crypto = require('crypto');
      console.log(crypto.createHash('sha256').update('hello').digest('hex'));
      `
    );
    expect(r.code).toBe(0);
    expect(r.stdout).toBe("2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824\n");
  });

  it("multiple update() calls produce the same digest as one call with the whole input", async () => {
    const r = await run(
      `
      const crypto = require('crypto');
      const whole = crypto.createHash('sha512').update('hello world').digest('hex');
      const chunked = crypto.createHash('sha512').update('hello').update(' ').update('world').digest('hex');
      console.log(whole === chunked, whole.length);
      `
    );
    expect(r.stdout).toBe("true 128\n");
  });

  it("digest() with no encoding returns a real Buffer", async () => {
    const r = await run(
      `
      const crypto = require('crypto');
      const digest = crypto.createHash('sha1').update('x').digest();
      console.log(Buffer.isBuffer(digest), digest.length);
      `
    );
    expect(r.stdout).toBe("true 20\n");
  });

  it("md5 and sha224 work too; an unknown algorithm fails with real Node's message", async () => {
    const r = await run(
      `
      const crypto = require('crypto');
      console.log(crypto.createHash('md5').update('hello').digest('hex'), crypto.createHash('sha224').update('').digest('hex'));
      try { crypto.createHash('sha3-256'); } catch (e) { console.log(e.message); }
      `,
    );
    expect(r.stdout).toBe("5d41402abc4b2a76b9719d911017c592 d14a028c2a3a2bc9476102bb288234c415a2b01f828ea62ac5b3e42f\nDigest method not supported\n");
  });

  it("a finished hash can't be updated, digested or copied again; copy() forks a running one", async () => {
    const r = await run(
      `
      const crypto = require('crypto');
      const h = crypto.createHash('sha256').update('hello ');
      const fork = h.copy();
      console.log(h.update('world').digest('hex') === crypto.createHash('sha256').update('hello world').digest('hex'));
      console.log(fork.update('there').digest('base64url').length);
      for (const again of [() => h.update('x'), () => h.digest(), () => h.copy()]) {
        try { again(); } catch (e) { console.log(e.code); }
      }
      `,
    );
    expect(r.stdout).toBe("true\n43\n" + "ERR_CRYPTO_HASH_FINALIZED\n".repeat(3));
  });

  it("hashes a multi-megabyte input in one update() - no 1 MiB limit", async () => {
    const r = await run(
      `
      const crypto = require('crypto');
      console.log(crypto.createHash('sha1').update(Buffer.alloc(3 * 1024 * 1024, 7)).digest('hex'));
      `,
    );
    expect(r.stdout).toBe(`${nodeCrypto.createHash("sha1").update(Buffer.alloc(3 * 1024 * 1024, 7)).digest("hex")}\n`);
  });

  it("randomBytes(size) is a real Buffer of the right length, sync with no callback and async with one", async () => {
    const r = await run(`
      const crypto = require('crypto');
      const sync = crypto.randomBytes(16);
      console.log('sync', Buffer.isBuffer(sync), sync.length);
      crypto.randomBytes(8, (err, buf) => {
        console.log('async', err, Buffer.isBuffer(buf), buf.length);
      });
    `);
    expect(r.code).toBe(0);
    expect(r.stdout).toBe("sync true 16\nasync null true 8\n");
  });

  it("randomUUID() returns a real v4 UUID string", async () => {
    const r = await run(`
      const crypto = require('crypto');
      const id = crypto.randomUUID();
      console.log(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(id));
    `);
    expect(r.stdout).toBe("true\n");
  });

});

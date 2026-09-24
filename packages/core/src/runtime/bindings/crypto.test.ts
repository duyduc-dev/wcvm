import { describe, expect, it } from "vitest";
import type { ISyscallClient } from "../../protocols/syscall";
import { createFakeCryptoDigestSync } from "../../testing/fakeCryptoDigestSync";
import { runScript } from "../harness";

const run = (source: string, spawnSync?: ISyscallClient) => runScript({ "/app/main.js": source }, "/app/main.js", { cwd: "/app", spawnSync });

describe("crypto (hand-written shim)", () => {
  it("createHash('sha256').update().digest('hex') matches a known SHA-256 vector", async () => {
    const r = await run(
      `
      const crypto = require('crypto');
      console.log(crypto.createHash('sha256').update('hello').digest('hex'));
      `,
      createFakeCryptoDigestSync(),
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
      `,
      createFakeCryptoDigestSync(),
    );
    expect(r.stdout).toBe("true 128\n");
  });

  it("digest() with no encoding returns a real Buffer", async () => {
    const r = await run(
      `
      const crypto = require('crypto');
      const digest = crypto.createHash('sha1').update('x').digest();
      console.log(Buffer.isBuffer(digest), digest.length);
      `,
      createFakeCryptoDigestSync(),
    );
    expect(r.stdout).toBe("true 20\n");
  });

  it("createHash() throws a clear error for an unsupported algorithm (md5 - not in SubtleCrypto)", async () => {
    const r = await run(
      `
      const crypto = require('crypto');
      try {
        crypto.createHash('md5');
        console.log('no error');
      } catch (e) {
        console.log(e.message.includes('md5'));
      }
      `,
      createFakeCryptoDigestSync(),
    );
    expect(r.stdout).toBe("true\n");
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

  it("digest sync operations throw a clear error when no spawnSync client is wired", async () => {
    const r = await run(`
      const crypto = require('crypto');
      try {
        crypto.createHash('sha256').update('x').digest('hex');
        console.log('no error');
      } catch (e) {
        console.log(e.message.includes('spawnSync client'));
      }
    `);
    expect(r.stdout).toBe("true\n");
  });
});

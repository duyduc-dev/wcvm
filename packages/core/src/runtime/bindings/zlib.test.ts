import zlibNode from "node:zlib";
import { describe, expect, it } from "vitest";
import { OP_ZLIB_SYNC, SyscallError, decodeBytes, decodeRequest, encodeRequest, encodeString, type ISyscallClient } from "../../protocols/syscall";
import { runScript } from "../harness";
import { runZlibOnce } from "./zlib";

const run = (source: string, spawnSync?: ISyscallClient) => runScript({ "/app/main.js": source }, "/app/main.js", { cwd: "/app", spawnSync });

/** A real (but NOT CompressionStream-backed) synchronous gzip/deflate implementation, standing in
 *  for the kernel's OP_ZLIB_SYNC servicer the same way spawnSync.test.ts's createFakeSpawnSync
 *  stands in for a real spawned child: it proves the binding's request/response wire encoding is
 *  correct, not that CompressionStream itself works (that's runZlibOnce's own tests below, and
 *  the Chromium e2e test). gzip/deflate are standard, interoperable formats, so Node's own zlib
 *  is a valid stand-in for whatever produced/will consume these bytes.
 */
const createFakeZlibSync = (): ISyscallClient => ({
  call: (opcode, request) => {
    if (opcode !== OP_ZLIB_SYNC) throw new SyscallError("ENOSYS");
    const { fields } = decodeRequest(request);
    const [formatBytes, directionBytes, input] = fields;
    const format = decodeBytes(formatBytes);
    const direction = decodeBytes(directionBytes);
    const fn =
      format === "gzip"
        ? direction === "compress"
          ? zlibNode.gzipSync
          : zlibNode.gunzipSync
        : format === "deflate"
          ? direction === "compress"
            ? zlibNode.deflateSync
            : zlibNode.inflateSync
          : direction === "compress"
            ? zlibNode.deflateRawSync
            : zlibNode.inflateRawSync;
    return fn(input);
  },
});

describe("runZlibOnce", () => {
  it("round-trips through gzip", async () => {
    const input = new TextEncoder().encode("the quick brown fox");
    const compressed = await runZlibOnce("gzip", "compress", input);
    const output = await runZlibOnce("gzip", "decompress", compressed);
    expect(new TextDecoder().decode(output)).toBe("the quick brown fox");
  });

  it("round-trips through deflate and deflate-raw", async () => {
    for (const format of ["deflate", "deflate-raw"] as const) {
      const input = new TextEncoder().encode("payload:" + format);
      const compressed = await runZlibOnce(format, "compress", input);
      const output = await runZlibOnce(format, "decompress", compressed);
      expect(new TextDecoder().decode(output)).toBe("payload:" + format);
    }
  });

  it("rejects on malformed input", async () => {
    await expect(runZlibOnce("gzip", "decompress", new TextEncoder().encode("not gzip"))).rejects.toThrow();
  });
});

describe("zlib binding (async)", () => {
  it("gzip/gunzip the streaming Transform classes round-trip", async () => {
    const r = await run(`
      const zlib = require("zlib");
      const chunks = [];
      const gz = zlib.createGzip();
      const gunz = zlib.createGunzip();
      gz.pipe(gunz);
      gunz.on("data", (c) => chunks.push(c));
      gunz.on("end", () => {
        console.log(Buffer.concat(chunks).toString());
      });
      gz.end("streamed through gzip");
    `);
    expect(r.stderr).toBe("");
    expect(r.stdout.trim()).toBe("streamed through gzip");
  });

  it("gzip/gunzip callback convenience functions round-trip", async () => {
    const r = await run(`
      const zlib = require("zlib");
      zlib.gzip(Buffer.from("callback style"), (err, compressed) => {
        if (err) throw err;
        zlib.gunzip(compressed, (err2, output) => {
          if (err2) throw err2;
          console.log(output.toString());
        });
      });
    `);
    expect(r.stderr).toBe("");
    expect(r.stdout.trim()).toBe("callback style");
  });

  it("supports util.promisify", async () => {
    const r = await run(`
      const zlib = require("zlib");
      const { promisify } = require("util");
      const gzip = promisify(zlib.gzip);
      const gunzip = promisify(zlib.gunzip);
      (async () => {
        const compressed = await gzip(Buffer.from("promisified"));
        const output = await gunzip(compressed);
        console.log(output.toString());
      })();
    `);
    expect(r.stderr).toBe("");
    expect(r.stdout.trim()).toBe("promisified");
  });

  it("unzip auto-detects gzip vs. zlib-wrapped deflate", async () => {
    const r = await run(`
      const zlib = require("zlib");
      zlib.gzip(Buffer.from("via gzip"), (err, gz) => {
        if (err) throw err;
        zlib.deflate(Buffer.from("via deflate"), (err2, df) => {
          if (err2) throw err2;
          zlib.unzip(gz, (err3, out1) => {
            if (err3) throw err3;
            zlib.unzip(df, (err4, out2) => {
              if (err4) throw err4;
              console.log(out1.toString());
              console.log(out2.toString());
            });
          });
        });
      });
    `);
    expect(r.stderr).toBe("");
    expect(r.stdout.trim().split("\n")).toEqual(["via gzip", "via deflate"]);
  });

  it("reports a decompress error for malformed input", async () => {
    const r = await run(`
      const zlib = require("zlib");
      zlib.gunzip(Buffer.from("not gzip"), (err) => {
        console.log(err ? "got error" : "no error");
      });
    `);
    expect(r.stderr).toBe("");
    expect(r.stdout.trim()).toBe("got error");
  });

  it("crc32 matches known vectors and supports continuation", async () => {
    const r = await run(`
      const zlib = require("zlib");
      console.log(zlib.crc32(Buffer.from("The quick brown fox jumps over the lazy dog")).toString(16));
      console.log(zlib.crc32(Buffer.alloc(0)));
      const a = zlib.crc32(Buffer.from("hello "));
      console.log(zlib.crc32(Buffer.from("world"), a).toString(16));
      console.log(zlib.crc32(Buffer.from("hello world")).toString(16));
    `);
    expect(r.stderr).toBe("");
    const lines = r.stdout.trim().split("\n");
    expect(lines[0]).toBe("414fa339");
    expect(lines[1]).toBe("0");
    expect(lines[2]).toBe(lines[3]);
  });
});

describe("zlib binding (sync, over a fake kernel)", () => {
  it("gzipSync/gunzipSync round-trip through the OP_ZLIB_SYNC opcode", async () => {
    const r = await run(
      `
      const zlib = require("zlib");
      const compressed = zlib.gzipSync(Buffer.from("sync round trip"));
      console.log(zlib.gunzipSync(compressed).toString());
      `,
      createFakeZlibSync(),
    );
    expect(r.stderr).toBe("");
    expect(r.stdout.trim()).toBe("sync round trip");
  });

  it("deflateSync/inflateSync and deflateRawSync/inflateRawSync round-trip", async () => {
    const r = await run(
      `
      const zlib = require("zlib");
      console.log(zlib.inflateSync(zlib.deflateSync(Buffer.from("deflate"))).toString());
      console.log(zlib.inflateRawSync(zlib.deflateRawSync(Buffer.from("raw"))).toString());
      `,
      createFakeZlibSync(),
    );
    expect(r.stderr).toBe("");
    expect(r.stdout.trim().split("\n")).toEqual(["deflate", "raw"]);
  });

  it("throws when no spawnSync client is wired", async () => {
    const r = await run(`
      try {
        require("zlib").gzipSync(Buffer.from("x"));
        console.log("no throw");
      } catch (e) {
        console.log("threw: " + e.message);
      }
    `);
    expect(r.stderr).toBe("");
    expect(r.stdout.trim()).toContain("threw:");
  });
});

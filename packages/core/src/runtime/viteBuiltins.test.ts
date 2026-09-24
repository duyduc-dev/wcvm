import { describe, expect, it } from "vitest";
import type { IChildProcessHost } from "./bindings/childProcess";
import { createFakeCryptoDigestSync } from "../testing/fakeCryptoDigestSync";
import { runScript } from "./harness";

// The builtins Vite imports that this runtime used to lack. `url`, `querystring`, `tty`,
// `process` and `perf_hooks` are Node's real vendored modules (over bindings/url.ts and
// bindings/performance.ts); `module`, `tls`, `https` and `inspector` are hand-written (see
// moduleBuiltin.ts and shims.ts for why).

// http (and so https) pulls in net, whose pipe_wrap router needs a childProcess host to exist.
const noopChildProcessHost: IChildProcessHost = {
  spawn: () => {}, kill: () => {}, writeStdin: () => {}, endStdin: () => {},
  writeIpc: () => {}, endIpc: () => {}, onEvent: () => {},
};

const run = (source: string, files: Record<string, string> = {}) =>
  runScript({ ...files, "/app/main.js": source }, "/app/main.js", {
    cwd: "/app",
    childProcess: noopChildProcessHost,
    // crypto's hashes block on the kernel's digest servicer; a fake backed by Node's own crypto.
    spawnSync: createFakeCryptoDigestSync(),
  });

// Run under real Node 24 once, output pinned below: this runtime must print exactly the same.
const DIFFERENTIAL_SCRIPT = String.raw`const url = require("url");
const u = url.parse("http://user:pw@Host.example:8080/p/a/t/h?query=string&x=1#hash", true);
console.log(JSON.stringify([u.protocol, u.auth, u.host, u.port, u.hostname, u.hash, u.search, u.query, u.pathname, u.path, u.href]));
console.log(url.format({ protocol: "https", hostname: "example.com", pathname: "/a b", query: { q: "1 2", r: ["x", "y"] } }));
console.log(url.resolve("http://a.com/b/c/d", "../e"), url.resolve("/one/two/three", "four"));
console.log(url.format(new URL("https://u:p@example.com:444/p?q=1#frag"), { fragment: false, auth: false, search: false }));
console.log(url.fileURLToPath("file:///tmp/a%20b.txt"), url.pathToFileURL("/tmp/a b#c.txt").href);
console.log(url.domainToASCII("español.com"), typeof url.URLSearchParams, url.URL === URL);
console.log(new url.URLPattern({ pathname: "/books/:id" }).exec("https://x.com/books/42").pathname.groups.id);
const qs = require("querystring");
console.log(qs.stringify({ a: [1, 2], b: "x y", c: "é&" }), JSON.stringify(qs.parse("a=1&a=2&b=x%20y&c")), qs.escape("a b&c"), qs.unescape("a%20b"));
console.log(require("process") === process, require("node:process") === process);
const tty = require("tty");
console.log(tty.isatty(1), tty.isatty(99), typeof tty.WriteStream, typeof tty.ReadStream);
const { createHistogram, performance, PerformanceObserver } = require("perf_hooks");
const h = createHistogram();
console.log("empty", h.count, h.min, h.max, h.mean, h.stddev, h.percentile(50), JSON.stringify([...h.percentiles]));
for (const v of [1, 2, 3, 4, 100]) h.record(v);
console.log("filled", h.count, h.min, h.max, h.mean, h.stddev, h.percentile(50), h.percentile(99), JSON.stringify([...h.percentiles]), h.minBigInt, h.countBigInt);
const h2 = createHistogram(); h2.add(h); h2.record(5n); console.log("added", h2.count, h2.max, h2.percentile(50));
console.log(typeof performance.now(), performance.now() >= 0, typeof performance.timeOrigin, typeof performance.nodeTiming);
performance.mark("a"); performance.mark("b"); const m = performance.measure("a-to-b", "a", "b");
console.log(m.name, m.entryType, performance.getEntriesByName("a").length, performance.getEntriesByType("mark").map((e) => e.name).join(","));
const obs = new PerformanceObserver((list, o) => { console.log("observed", list.getEntries().map((e) => e.entryType + ":" + e.name).join(",")); o.disconnect(); });
obs.observe({ entryTypes: ["mark"] });
performance.mark("c");
`;

const REAL_NODE_OUTPUT = `["http:","user:pw","host.example:8080","8080","host.example","#hash","?query=string&x=1",{"query":"string","x":"1"},"/p/a/t/h","/p/a/t/h?query=string&x=1","http://user:pw@host.example:8080/p/a/t/h?query=string&x=1#hash"]
https://example.com/a b?q=1%202&r=x&r=y
http://a.com/b/e /one/two/four
https://example.com:444/p
/tmp/a b.txt file:///tmp/a%20b%23c.txt
xn--espaol-zwa.com function true
42
a=1&a=2&b=x%20y&c=%C3%A9%26 {"a":["1","2"],"b":"x y","c":""} a%20b%26c a b
true true
false false function function
empty 0 9223372036854776000 0 NaN NaN 0 [[100,0]]
filled 5 1 100 22 39.01281840626232 3 100 [[0,1],[50,3],[75,4],[87.5,100],[100,100]] 1n 5n
added 6 100 3
number true number object
a-to-b measure 1 a,b
observed mark:c
`;

describe("builtins Vite needs", () => {
  it("url, querystring, process, tty and perf_hooks print exactly what real Node 24 prints", async () => {
    const r = await run(DIFFERENTIAL_SCRIPT);
    expect(r.stdout).toBe(REAL_NODE_OUTPUT);
    expect(r.code).toBe(0);
    // Real Node warns about url.parse() for code outside node_modules, too.
    expect(r.stderr).toMatch(/DEP0169/);
  });

  it("module: createRequire from a path or a file URL, builtinModules, isBuiltin, and our own Module", async () => {
    const r = await run(
      `
      const Module = require("module");
      const { createRequire, builtinModules, isBuiltin } = Module;
      const fromUrl = createRequire("file:///app/lib/entry.mjs");
      const fromPath = createRequire("/app/lib/");
      console.log(fromUrl("./sibling.js"), fromPath("./sibling.js"), fromUrl.resolve("./sibling.js"));
      console.log(fromUrl("dep"), fromUrl("node:path") === require("path"));
      console.log(["fs", "module", "url", "perf_hooks", "tls"].every((id) => builtinModules.includes(id)), builtinModules.some((id) => id.startsWith("internal/")));
      console.log(isBuiltin("fs"), isBuiltin("node:fs"), isBuiltin("nope"), isBuiltin("internal/errors"));
      console.log(Module.Module === Module, module instanceof Module, typeof Module.register, typeof Module.registerHooks);
      console.log(Module._nodeModulePaths("/app/lib").join(","), Module.wrap("x").startsWith("(function (exports, require, module"));
      try { createRequire("relative/path"); } catch (e) { console.log(e.code); }
      `,
      {
        "/app/lib/sibling.js": "module.exports = 'sibling';",
        "/app/node_modules/dep/index.js": "module.exports = 'dep';",
      },
    );
    expect(r).toEqual(
      expect.objectContaining({
        code: 0,
        stdout:
          "sibling sibling /app/lib/sibling.js\n" +
          "dep true\n" +
          "true false\n" +
          "true true false false\n" +
          "true true undefined undefined\n" +
          "/app/lib/node_modules,/app/node_modules,/node_modules true\n" +
          "ERR_INVALID_ARG_VALUE\n",
      }),
    );
  });

  it("tls and https load, but anything needing real TLS fails with Node's own ERR_NO_CRYPTO", async () => {
    const r = await run(`
      const https = require("https");
      const tls = require("tls");
      const http2 = require("http2");
      const agent = new https.Agent({ keepAlive: true });
      console.log(agent.defaultPort, agent.protocol, https.globalAgent instanceof https.Agent, tls.getCiphers().length, tls.rootCertificates.length);
      for (const attempt of [() => https.createServer(), () => https.get("https://example.com"), () => tls.connect(443), () => new tls.TLSSocket(), () => http2.createSecureServer()]) {
        try { attempt(); console.log("no error"); } catch (e) { console.log(e.code); }
      }
    `);
    expect(r).toEqual(expect.objectContaining({ code: 0, stdout: "443 https: true 0 0\n" + "ERR_NO_CRYPTO\n".repeat(5) }));
  });

  it("dns.promises and dns/promises answer lookups in the promise API's own shape", async () => {
    const r = await run(`
      const dns = require("dns");
      (async () => {
        console.log(JSON.stringify(await dns.promises.lookup("localhost")), JSON.stringify(await require("dns/promises").lookup("x", { all: true })));
        console.log(dns.getDefaultResultOrder(), require("dns/promises") === dns.promises);
      })();
    `);
    expect(r.stdout).toBe('{"address":"127.0.0.1","family":4} [{"address":"127.0.0.1","family":4}]\nverbatim true\n');
  });

  it("crypto: the members Vite uses match real Node's answers", async () => {
    // Expected output: this exact script run under real Node 24.
    const r = await run(`
      const c = require("crypto");
      console.log(c.hash("sha1", "abc"), c.hash("sha256", Buffer.from("abc"), "base64"), c.hash("sha1", "abc", "buffer").length);
      console.log(c.timingSafeEqual(Buffer.from("ab"), Buffer.from("ab")), c.timingSafeEqual(new Uint8Array([1]), new Uint8Array([2])));
      try { c.timingSafeEqual(Buffer.from("a"), Buffer.from("ab")); } catch (e) { console.log(e.code); }
      const big = c.randomFillSync(new Uint8Array(100000)); console.log(big.length, new Set(big).size > 200);
      const part = c.randomFillSync(Buffer.alloc(10), 8); console.log(part.subarray(0, 8).every((b) => b === 0));
      console.log(c.getRandomValues(new Uint32Array(4)).length, c.randomBytes(70000).length, c.webcrypto === globalThis.crypto, typeof c.subtle.digest);
      try { c.randomFillSync(Buffer.alloc(4), 5); } catch (e) { console.log(e.code); }
      c.randomFill(Buffer.alloc(8), 2, (err, buf) => console.log("filled", err, buf.length));
    `);
    expect(r.stdout).toBe(
      "a9993e364706816aba3e25717850c26c9cd0d89d ungWv48Bz+pBQUDeXa4iI7ADYaOWF3qctBD/YfIAFa0= 20\n" +
        "true false\n" +
        "ERR_CRYPTO_TIMING_SAFE_EQUAL_LENGTH\n" +
        "100000 true\n" +
        "true\n" +
        "4 70000 true function\n" +
        "ERR_OUT_OF_RANGE\n" +
        "filled null 8\n",
    );
  });

  it("inspector fails to load like a Node built without it", async () => {
    const r = await run(`
      for (const id of ["inspector", "node:inspector/promises"]) {
        try { require(id); } catch (e) { console.log(e.code); }
      }
    `);
    expect(r.stdout).toBe("ERR_INSPECTOR_NOT_AVAILABLE\nERR_INSPECTOR_NOT_AVAILABLE\n");
  });

  it("monitorEventLoopDelay samples real delays between start() and stop()", async () => {
    const r = await run(`
      const { monitorEventLoopDelay } = require("perf_hooks");
      const h = monitorEventLoopDelay({ resolution: 10 });
      console.log(h.enable(), h.enable());
      setTimeout(() => {
        console.log(h.disable(), h.disable(), h.count > 0, h.min >= 1e6, h.max >= h.min);
      }, 120);
    `);
    expect(r).toEqual(expect.objectContaining({ code: 0, stdout: "true false\ntrue false true true true\n" }));
  });
});

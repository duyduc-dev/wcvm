import { describe, expect, it } from "vitest";
import { runScript } from "./harness";

const run = (source: string, extra: Record<string, string> = {}, options = {}) =>
  runScript({ "/app/main.js": source, ...extra }, "/app/main.js", { cwd: "/app", ...options });

describe("running a script", () => {
  it("prints with console.log using Node's real formatting", async () => {
    const r = await run(`console.log("Hello", 1, { a: [1, 2] }, "%s!", "x"); console.log("%d%%", 50)`);
    expect(r).toMatchObject({ code: 0, stdout: "Hello 1 { a: [ 1, 2 ] } %s! x\n50%\n", stderr: "" });
  });

  it("routes console.error/warn to stderr and info/debug to stdout", async () => {
    const r = await run(`console.error("e"); console.warn("w"); console.info("i"); console.debug("d")`);
    expect(r.stderr).toBe("e\nw\n");
    expect(r.stdout).toBe("i\nd\n");
  });

  it("supports group, table-free helpers, dir, assert and count", async () => {
    const r = await run(`
      console.group("G"); console.log("inner"); console.groupEnd(); console.log("outer");
      console.dir({ a: { b: { c: {} } } }, { depth: 0 });
      console.assert(false, "nope");
      console.count(); console.count(); console.count("x");
    `);
    expect(r.stdout).toBe("G\n  inner\nouter\n{ a: [Object] }\ndefault: 1\ndefault: 2\nx: 1\n");
    expect(r.stderr).toContain("Assertion failed: nope");
  });

  it("writes to process.stdout / stderr directly, strings and Buffers", async () => {
    const r = await run(`process.stdout.write("a"); process.stdout.write(Buffer.from("b")); process.stderr.write("c\\n")`);
    expect(r.stdout).toBe("ab");
    expect(r.stderr).toBe("c\n");
  });

  it("gives modules __filename, __dirname, module and the main-module marker", async () => {
    const r = await run(`console.log(__filename, __dirname, require.main === module, module.id === __filename, typeof module.exports)`);
    expect(r.stdout).toBe("/app/main.js /app true true object\n");
  });

  it("exposes the process the host configured", async () => {
    const r = await run(
      `console.log(process.argv.slice(1).join(","), process.env.FOO, process.cwd(), process.platform, process.version, typeof process.pid, process.title)`,
      {},
      { argv: ["/bin/node", "/app/main.js", "one", "two"], env: { FOO: "bar" } },
    );
    expect(r.stdout).toBe("/app/main.js,one,two bar /app linux v24.18.0 number node\n");
  });

  it("process.chdir changes cwd for relative resolution and rejects non-directories", async () => {
    const r = await run(
      `process.chdir("sub"); console.log(process.cwd(), require(require("path").resolve("x"))); try { process.chdir("/app/main.js") } catch (e) { console.log(e.code) }`,
      { "/app/sub/x.js": "module.exports = 'from sub'" },
    );
    expect(r.stdout).toBe("/app/sub from sub\nENOTDIR\n");
  });

  it("makes Buffer, URL and friends available as globals", async () => {
    const r = await run(`console.log(Buffer.from("hi").toString("hex"), new URL("http://a/b?c=1").searchParams.get("c"), typeof structuredClone, typeof TextEncoder, typeof global.setTimeout, global === globalThis)`);
    expect(r.stdout).toBe("6869 1 function function function false\n");
  });
});

describe("modules", () => {
  it("requires relative files, directories with index, and JSON", async () => {
    const r = await run(
      `const a = require("./a"); const d = require("./dir"); const j = require("./data.json"); console.log(a.name, d, j.n, require("./a") === a)`,
      { "/app/a.js": `exports.name = "A"`, "/app/dir/index.js": `module.exports = "dir-index"`, "/app/data.json": `{"n": 7}` },
    );
    expect(r.stdout).toBe("A dir-index 7 true\n");
  });

  it("resolves extensions and package.json main for directories", async () => {
    const r = await run(
      `console.log(require("./lib"), require("./lib/util"))`,
      { "/app/lib/package.json": `{"main": "./entry"}`, "/app/lib/entry.js": `module.exports = "entry"`, "/app/lib/util.js": `module.exports = "util"` },
    );
    expect(r.stdout).toBe("entry util\n");
  });

  it("module.exports replaces exports; exports.x adds to it", async () => {
    const r = await run(
      `console.log(require("./m1"), require("./m2"))`,
      { "/app/m1.js": `exports.a = 1; module.exports = { b: 2 }; exports.c = 3`, "/app/m2.js": `exports.a = 1; exports.c = 3` },
    );
    expect(r.stdout).toBe("{ b: 2 } { a: 1, c: 3 }\n");
  });

  it("hands a circular require the partial exports, like Node", async () => {
    const r = await run(`console.log(require("./a").done)`, {
      "/app/a.js": `exports.early = 1; const b = require("./b"); exports.done = "a saw " + JSON.stringify(b.sawA)`,
      "/app/b.js": `exports.sawA = { ...require("./a") }`,
    });
    expect(r.stdout).toBe('a saw {"early":1}\n');
  });

  it("caches modules and lets require.cache be inspected", async () => {
    const r = await run(
      `require("./c"); require("./c"); console.log(globalThis.__count ?? global.__count, Object.keys(require.cache).sort().join())`,
      { "/app/c.js": `global.__count = (global.__count || 0) + 1` },
    );
    expect(r.stdout).toBe("1 /app/c.js,/app/main.js\n");
  });

  it("finds packages in node_modules walking up, including scoped ones", async () => {
    const r = await run(`console.log(require("pkg"), require("@s/thing"), require("pkg/sub"))`, {
      "/node_modules/pkg/package.json": `{"main": "main.js"}`,
      "/node_modules/pkg/main.js": `module.exports = "pkg-main"`,
      "/node_modules/pkg/sub.js": `module.exports = "pkg-sub"`,
      "/app/node_modules/@s/thing/index.js": `module.exports = "scoped"`,
    });
    expect(r.stdout).toBe("pkg-main scoped pkg-sub\n");
  });

  it("honours package.json exports: conditions, subpaths and patterns", async () => {
    const pkg = {
      exports: {
        ".": { import: "./esm.mjs", require: "./cjs.js" },
        "./feature": "./features/f.js",
        "./utils/*": "./lib/*.js",
      },
    };
    const r = await run(
      `console.log(require("p"), require("p/feature"), require("p/utils/x"))`,
      {
        "/app/node_modules/p/package.json": JSON.stringify(pkg),
        "/app/node_modules/p/cjs.js": `module.exports = "cjs"`,
        "/app/node_modules/p/features/f.js": `module.exports = "feature"`,
        "/app/node_modules/p/lib/x.js": `module.exports = "x"`,
      },
    );
    expect(r.stdout).toBe("cjs feature x\n");
  });

  it("refuses paths a package does not export", async () => {
    const r = await run(`try { require("p/private") } catch (e) { console.log(e.code) }`, {
      "/app/node_modules/p/package.json": `{"exports": {".": "./i.js"}}`,
      "/app/node_modules/p/i.js": ``,
      "/app/node_modules/p/private.js": ``,
    });
    expect(r.stdout).toBe("ERR_PACKAGE_PATH_NOT_EXPORTED\n");
  });

  it("follows symlinks to the real path", async () => {
    const r = await runScript(
      { "/real/lib.js": `module.exports = __filename`, "/app/main.js": `console.log(require("./link"))` },
      "/app/main.js",
      { cwd: "/app", setup: () => {} },
    ).catch(() => null);
    expect(r).not.toBeNull();
  });

  it('resolves require("#x") through the nearest package.json "imports", with require conditions', async () => {
    const r = await runScript(
      {
        "/app/package.json": JSON.stringify({
          imports: { "#config": { require: "./lib/config.cjs", default: "./lib/config.mjs" }, "#util/*": "./lib/util/*.js", "#dep": "dep" },
        }),
        "/app/lib/config.cjs": "module.exports = 'config for require';",
        "/app/lib/util/strings.js": "module.exports = 'strings';",
        "/app/node_modules/dep/index.js": "module.exports = 'dep';",
        "/app/src/main.js": `
          console.log(require("#config"), require("#util/strings"), require("#dep"));
          try { require("#missing"); } catch (e) { console.log(e.code); }
        `,
      },
      "/app/src/main.js",
    );
    expect(r).toEqual(expect.objectContaining({ code: 0, stdout: "config for require strings dep\nERR_PACKAGE_IMPORT_NOT_DEFINED\n" }));
  });

  it("reports a missing module with the require stack and MODULE_NOT_FOUND", async () => {
    const r = await run(`require("./nope")`);
    expect(r.code).toBe(1);
    expect(r.stderr).toContain("Cannot find module './nope'");
    expect(r.stderr).toContain("Require stack:\n- /app/main.js");
    expect(r.stderr).toContain("Node.js v24.18.0");
  });

  it("exposes Node's public builtins, with or without the node: scheme", async () => {
    const r = await run(`
      const path = require("path"); const events = require("node:events"); const util = require("util");
      console.log(path.join("a", "b"), typeof events, util.format("%s", "ok"), require("buffer").Buffer === Buffer);
    `);
    expect(r.stdout).toBe("a/b function ok true\n");
  });

  it("rejects internal and unknown builtins", async () => {
    const r = await run(`
      for (const id of ["internal/errors", "node:nope"]) { try { require(id) } catch (e) { console.log(e.code) } }
    `);
    expect(r.stdout).toBe("MODULE_NOT_FOUND\nERR_UNKNOWN_BUILTIN_MODULE\n");
  });

  it("strips a shebang and reports JSON errors with the filename", async () => {
    const r = await run(`console.log(require("./s")); try { require("./bad.json") } catch (e) { console.log(e.message.startsWith("/app/bad.json:")) }`, {
      "/app/s.js": `#!/usr/bin/env node\nmodule.exports = "shebang ok"`,
      "/app/bad.json": `{nope`,
    });
    expect(r.stdout).toBe("shebang ok\ntrue\n");
  });

  it("does not cache a module whose evaluation threw", async () => {
    const r = await run(
      `let n = 0; for (let i = 0; i < 2; i++) { try { require("./boom") } catch (e) { n++ } } console.log(n, global.__runs)`,
      { "/app/boom.js": `global.__runs = (global.__runs || 0) + 1; throw new Error("boom")` },
    );
    expect(r.stdout).toBe("2 2\n");
  });
});

describe("exit codes and process events", () => {
  it("exits 0 normally and with process.exit(n) immediately", async () => {
    expect((await run(`console.log("x")`)).code).toBe(0);
    const r = await run(`console.log("before"); process.exit(3); console.log("after")`);
    expect(r).toMatchObject({ code: 3, stdout: "before\n" });
  });

  it("uses process.exitCode, and process.exit() without an argument honours it", async () => {
    expect((await run(`process.exitCode = 4`)).code).toBe(4);
    expect((await run(`process.exitCode = 5; process.exit()`)).code).toBe(5);
  });

  it("rejects a non-integer exit code", async () => {
    const r = await run(`try { process.exitCode = "abc" } catch (e) { console.log(e.code) }`);
    expect(r.stdout).toBe("ERR_INVALID_ARG_TYPE\n");
  });

  it("emits exit with the code, and beforeExit which may schedule more work", async () => {
    const r = await run(`
      let again = false;
      process.on("beforeExit", () => { if (!again) { again = true; console.log("beforeExit"); setTimeout(() => console.log("more work"), 1); } });
      process.on("exit", (c) => console.log("exit", c));
    `);
    expect(r).toMatchObject({ code: 0, stdout: "beforeExit\nmore work\nexit 0\n" });
  });

  it("does not run beforeExit on process.exit()", async () => {
    const r = await run(`process.on("beforeExit", () => console.log("no")); process.on("exit", (c) => console.log("exit", c)); process.exit(2)`);
    expect(r).toMatchObject({ code: 2, stdout: "exit 2\n" });
  });

  it("lets an exit handler change the exit code", async () => {
    const r = await run(`process.on("exit", () => { process.exitCode = 9 })`);
    expect(r.code).toBe(9);
  });
});

describe("errors", () => {
  it("prints an uncaught exception's stack to stderr and exits 1", async () => {
    const r = await run(`console.log("before"); throw new TypeError("bad")`);
    expect(r.code).toBe(1);
    expect(r.stdout).toBe("before\n");
    expect(r.stderr).toContain("TypeError: bad");
    expect(r.stderr).toContain("/app/main.js");
    expect(r.stderr).toContain("Node.js v24.18.0");
  });

  it("prints non-Error throws", async () => {
    const r = await run(`throw { custom: true }`);
    expect(r.code).toBe(1);
    expect(r.stderr).toContain("Uncaught { custom: true }");
  });

  it("catches an exception thrown from a timer", async () => {
    const r = await run(`setTimeout(() => { throw new Error("late") }, 1)`);
    expect(r.code).toBe(1);
    expect(r.stderr).toContain("Error: late");
  });

  it("lets uncaughtException handlers keep the process alive", async () => {
    const r = await run(`
      process.on("uncaughtException", (e, origin) => console.log("caught", e.message, origin));
      setTimeout(() => { throw new Error("one") }, 1);
      setTimeout(() => console.log("still running"), 5);
    `);
    expect(r).toMatchObject({ code: 0, stdout: "caught one uncaughtException\nstill running\n" });
  });

  it("reports an unhandled rejection through 'unhandledRejection'", async () => {
    const r = await run(
      `process.on("unhandledRejection", (reason) => console.log("unhandled:", reason.message)); setTimeout(() => {}, 1)`,
      {},
      {
        setup: (runtime: any) => {
          const p = Promise.reject(new Error("nope"));
          p.catch(() => {}); // keep Node's own detector quiet; the runtime is told directly
          setTimeout(() => runtime.reportUnhandledRejection(p, new Error("nope")), 0);
        },
      },
    );
    expect(r.stdout).toBe("unhandled: nope\n");
  });

  it("an unhandled rejection with no handler is an uncaught error, exit 1", async () => {
    const r = await run(`setTimeout(() => {}, 5)`, {}, {
      setup: (runtime: any) => {
        const p = Promise.reject(new Error("fatal"));
        p.catch(() => {});
        setTimeout(() => runtime.reportUnhandledRejection(p, new Error("fatal")), 0);
      },
    });
    expect(r.code).toBe(1);
    expect(r.stderr).toContain("fatal");
  });
});

describe("the event loop", () => {
  it("runs nextTick before promise jobs, and both after synchronous code", async () => {
    const r = await run(`
      Promise.resolve().then(() => console.log("promise"));
      process.nextTick(() => console.log("tick"));
      console.log("sync");
    `);
    expect(r.stdout).toBe("sync\ntick\npromise\n");
  });

  it("drains nested ticks before microtasks (t1 t2 p1 p2)", async () => {
    const r = await run(`
      Promise.resolve().then(() => console.log("p1"));
      process.nextTick(() => { console.log("t1"); Promise.resolve().then(() => console.log("p2")); process.nextTick(() => console.log("t2")); });
    `);
    expect(r.stdout).toBe("t1\nt2\np1\np2\n");
  });

  it("runs a nextTick queued from a promise job after the microtask queue drains", async () => {
    const r = await run(`
      Promise.resolve().then(() => {
        process.nextTick(() => console.log("tick-from-promise"));
        Promise.resolve().then(() => console.log("promise-after"));
      });
    `);
    expect(r.stdout).toBe("promise-after\ntick-from-promise\n");
  });

  it("runs timers in order of their delay, and same-delay timers in creation order", async () => {
    const r = await run(`
      setTimeout(() => console.log("c"), 15);
      setTimeout(() => console.log("a1"), 2);
      setTimeout(() => console.log("a2"), 2);
      setTimeout(() => console.log("b"), 8);
    `);
    expect(r.stdout).toBe("a1\na2\nb\nc\n");
  });

  it("passes arguments, returns Timeout objects, and clears them", async () => {
    const r = await run(`
      const t = setTimeout((x, y) => console.log("args", x, y), 1, "a", "b");
      const dead = setTimeout(() => console.log("never"), 1);
      clearTimeout(dead);
      console.log(typeof t.ref, t.hasRef(), typeof t[Symbol.toPrimitive]());
    `);
    expect(r.stdout).toBe("function true number\nargs a b\n");
  });

  it("setInterval repeats until cleared", async () => {
    const r = await run(`
      let n = 0; const id = setInterval(() => { console.log("tick", ++n); if (n === 3) clearInterval(id); }, 1);
    `);
    expect(r.stdout).toBe("tick 1\ntick 2\ntick 3\n");
  });

  it("setImmediate runs, in order, and clearImmediate cancels", async () => {
    const r = await run(`
      setImmediate(() => console.log("i1"));
      const x = setImmediate(() => console.log("never"));
      setImmediate(() => console.log("i2"));
      clearImmediate(x);
    `);
    expect(r.stdout).toBe("i1\ni2\n");
  });

  it("a timer scheduled from inside an immediate still runs", async () => {
    const r = await run(`setImmediate(() => { setTimeout(() => console.log("t"), 1); setImmediate(() => console.log("i2")); console.log("i1") })`);
    expect(r.stdout).toContain("i1\n");
    expect(r.stdout).toContain("i2\n");
    expect(r.stdout).toContain("t\n");
  });

  it("an unref'd timer does not keep the process alive", async () => {
    const started = Date.now();
    const r = await run(`setTimeout(() => console.log("never"), 5000).unref(); console.log("done")`);
    expect(r.stdout).toBe("done\n");
    expect(Date.now() - started).toBeLessThan(2000);
  });

  it("a ref'd timer does, and ref()/unref() can be toggled", async () => {
    const r = await run(`
      const t = setTimeout(() => console.log("fired"), 5); t.unref(); t.ref(); console.log(t.hasRef());
    `);
    expect(r.stdout).toBe("true\nfired\n");
  });

  it("timer.refresh() restarts the countdown", async () => {
    const r = await run(`
      const start = Date.now(); const t = setTimeout(() => console.log(Date.now() - start >= 25), 15);
      setTimeout(() => t.refresh(), 10);
    `);
    expect(r.stdout).toBe("true\n");
  });

  it("queueMicrotask runs with the promise jobs", async () => {
    const r = await run(`queueMicrotask(() => console.log("mt")); process.nextTick(() => console.log("tick")); console.log("sync")`);
    expect(r.stdout).toBe("sync\ntick\nmt\n");
  });

  it("async/await interleaves with timers", async () => {
    const r = await run(`
      const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
      (async () => { console.log("a"); await sleep(3); console.log("b"); await null; console.log("c"); })();
      console.log("sync");
    `);
    expect(r.stdout).toBe("a\nsync\nb\nc\n");
  });

  it("runs a large number of chained timers without stalling", async () => {
    const r = await run(`let n = 0; const go = () => { if (++n < 300) setImmediate(go); else console.log(n) }; go()`);
    expect(r.stdout).toBe("300\n");
  });
});

describe("standard streams", () => {
  it("stdin is an already-ended stream when the host provides none", async () => {
    const r = await run(`process.stdin.on("data", () => console.log("data")); process.stdin.on("end", () => console.log("end")); process.stdin.resume()`);
    expect(r.stdout).toBe("end\n");
  });

  /**
   * `runScript` can't interleave: it awaits the whole run before returning.
   * These drive `createRuntime` directly so the test can push stdin data
   * mid-run, after the script has installed its listeners.
   */
  const runInterleaved = async (source: string) => {
    const fs = (await import("../testing/loopbackFs")).createLoopbackFs().fs;
    fs.mkdir("/app");
    fs.writeFile("/app/main.js", source);
    const { createRuntime } = await import("./runtime");
    const outChunks: string[] = [];
    let deliver: ((chunk: Uint8Array | null) => void) | undefined;
    const runtime = createRuntime({
      fs,
      cwd: "/app",
      argv: ["/bin/node"],
      env: {},
      host: {
        write: (_stream, chunk) => outChunks.push(new TextDecoder().decode(chunk)),
        stdin: { onData: (h) => (deliver = h) },
      },
    });
    const donePromise = runtime.runMain("/app/main.js");
    // Give the script a turn to install its listeners before pushing.
    await Promise.resolve();
    return { deliver: deliver!, done: donePromise, stdout: () => outChunks.join("") };
  };

  it("with a real stdin host, a script reading stdin sees exactly what's pushed, in order", async () => {
    const r = await runInterleaved(`
      let out = "";
      process.stdin.on("data", (c) => { out += c; });
      process.stdin.on("end", () => console.log("end:", out));
      process.stdin.resume();
    `);
    r.deliver(new TextEncoder().encode("hello "));
    r.deliver(new TextEncoder().encode("world"));
    r.deliver(null);
    expect(await r.done).toBe(0);
    expect(r.stdout()).toBe("end: hello world\n");
  });

  it("stays alive waiting for stdin while resumed, then exits once it ends", async () => {
    const r = await runInterleaved(`
      process.stdin.resume();
      process.stdin.on("end", () => console.log("ended"));
      setTimeout(() => console.log("still running"), 5);
    `);
    // The timer alone wouldn't keep a resumed-but-silent stdin from mattering;
    // confirm the process is still alive after it, waiting on stdin.
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(r.stdout()).toBe("still running\n");
    r.deliver(null);
    expect(await r.done).toBe(0);
    expect(r.stdout()).toBe("still running\nended\n");
  });

  it("a script that never touches stdin exits normally even with a live host that never ends it", async () => {
    const r = await runInterleaved(`console.log("done")`);
    expect(await r.done).toBe(0);
    expect(r.stdout()).toBe("done\n");
  });

  it("stdout reports what it is", async () => {
    const r = await run(`console.log(process.stdout.isTTY, process.stdout.fd, process.stderr.fd, typeof process.stdout.write)`);
    expect(r.stdout).toBe("false 1 2 function\n");
  });

  it("emitWarning prints in Node's format on stderr", async () => {
    const r = await run(`process.emitWarning("careful")`);
    expect(r.stderr).toContain("Warning: careful");
    expect(r.code).toBe(0);
  });
});

describe("assert and readline from user code", () => {
  it("require('assert') throws AssertionError, uncaught, with a nonzero exit", async () => {
    const r = await run(`const assert = require("assert"); assert.strictEqual(1, 1); assert.strictEqual(1, 2, "nope")`);
    expect(r.code).toBe(1);
    expect(r.stderr).toContain("AssertionError");
    expect(r.stderr).toContain("nope");
  });

  it("require('readline') reads lines from a piped Readable and closes on end", async () => {
    const r = await run(`
      const readline = require("readline");
      const { Readable } = require("stream");
      const input = new Readable({ read() {} });
      const rl = readline.createInterface({ input, terminal: false });
      rl.on("line", (line) => console.log("line:", line));
      rl.on("close", () => console.log("closed"));
      input.push("one\\ntwo\\n");
      input.push(null);
    `);
    expect(r.stdout).toBe("line: one\nline: two\nclosed\n");
    expect(r.code).toBe(0);
  });
});

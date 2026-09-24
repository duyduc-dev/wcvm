import nodeCrypto from "node:crypto";
import { expect, test } from "@playwright/test";

type WcWindow = Window & { wc: import("wcvm").IWcvm; wcvmBoot: typeof import("wcvm").boot };

let pageErrors: string[] = [];

test.beforeEach(async ({ page }) => {
  pageErrors = [];
  page.on("pageerror", (error) => pageErrors.push(error.message));
  await page.goto("/");
  await expect(page.locator("#app")).toHaveText("wcvm ready", {
    timeout: 15_000,
  });
});

test.afterEach(() => {
  expect(pageErrors).toEqual([]);
});

test("boots in a cross-origin isolated page", async ({ page }) => {
  expect(await page.evaluate(() => self.crossOriginIsolated)).toBe(true);
});

test("fs round-trips through the real kernel and fs workers", async ({ page }) => {
  const result = await page.evaluate(async () => {
    const { fs } = (window as unknown as WcWindow).wc;
    await fs.mkdir("/proj/src", { recursive: true });
    await fs.writeFile("/proj/src/a.txt", "hello");
    const text = new TextDecoder().decode(await fs.readFile("/proj/src/a.txt"));
    return {
      text,
      dir: await fs.readdir("/proj"),
      stat: await fs.stat("/proj/src/a.txt"),
    };
  });

  expect(result.text).toBe("hello");
  expect(result.dir).toEqual(["src"]);
  expect(result.stat).toMatchObject({ kind: "file", size: 5 });
});

test("errors carry an errno code across the worker boundary", async ({ page }) => {
  const code = await page.evaluate(async () => {
    const { fs } = (window as unknown as WcWindow).wc;
    try {
      await fs.readFile("/does/not/exist");
    } catch (error) {
      return (error as { code?: string }).code;
    }
    return "no error";
  });
  expect(code).toBe("ENOENT");
});

test("mount seeds a tree, and symlinks resolve", async ({ page }) => {
  const result = await page.evaluate(async () => {
    const { fs } = (window as unknown as WcWindow).wc;
    await fs.mount(
      {
        "package.json": { file: { contents: '{"name":"x"}' } },
        src: { directory: { "index.js": { file: { contents: "1" } } } },
        current: { symlink: "/app/src" },
      },
      "/app",
    );
    return {
      pkg: new TextDecoder().decode(await fs.readFile("/app/package.json")),
      viaLink: new TextDecoder().decode(await fs.readFile("/app/current/index.js")),
      real: await fs.realpath("/app/current"),
    };
  });
  expect(result).toEqual({ pkg: '{"name":"x"}', viaLink: "1", real: "/app/src" });
});

test("files larger than the 1 MiB syscall window survive a round trip", async ({ page }) => {
  const ok = await page.evaluate(async () => {
    const { fs } = (window as unknown as WcWindow).wc;
    const big = new Uint8Array(2_500_000);
    for (let i = 0; i < big.length; i++) big[i] = (i * 31 + 7) & 0xff;
    await fs.writeFile("/big.bin", big);
    const back = await fs.readFile("/big.bin");
    return back.length === big.length && back.every((v, i) => v === big[i]);
  });
  expect(ok).toBe(true);
});

type Result = { code: number; out: string; err: string; signal?: string };

// Runs a command in the page and collects everything it produced.
const spawn = (page: import("@playwright/test").Page, command: string, args: string[] = [], cwd?: string) =>
  page.evaluate(
    async ({ command, args, cwd }) => {
      const wc = (window as unknown as WcWindow).wc;
      const proc = await wc.spawn(command, args, { cwd });
      const [out, err, exit] = await Promise.all([
        new Response(proc.stdout).text(),
        new Response(proc.stderr).text(),
        proc.exit,
      ]);
      return { code: exit.exitCode, out, err, signal: exit.signal } as Result;
    },
    { command, args, cwd },
  );

test("echo runs in its own worker and its stdout reaches the host", async ({ page }) => {
  expect(await spawn(page, "echo", ["Hello,", "World!"])).toEqual({
    code: 0,
    out: "Hello, World!\n",
    err: "",
  });
});

test("a process reads a file the host wrote, and the host sees what a process wrote", async ({ page }) => {
  await page.evaluate(async () => {
    const { fs } = (window as unknown as WcWindow).wc;
    await fs.mkdir("/work", { recursive: true });
    await fs.writeFile("/work/note.txt", "written by the host\n");
  });

  const cat = await spawn(page, "cat", ["note.txt"], "/work");
  expect(cat).toMatchObject({ code: 0, out: "written by the host\n" });

  expect((await spawn(page, "mkdir", ["-p", "/work/a/b"])).code).toBe(0);
  const ls = await spawn(page, "ls", ["/work"]);
  expect(ls.out).toBe("a\nnote.txt\n");

  const seen = await page.evaluate(() =>
    (window as unknown as WcWindow).wc.fs.readdir("/work/a"),
  );
  expect(seen).toEqual(["b"]);
});

test("failures come back as exit codes and stderr", async ({ page }) => {
  expect(await spawn(page, "nonesuch")).toMatchObject({ code: 127 });
  const missing = await spawn(page, "cat", ["/missing"]);
  expect(missing.code).toBe(1);
  expect(missing.err).toBe("cat: /missing: No such file or directory\n");
  expect((await spawn(page, "pwd", [], "/no/such/dir")).code).toBe(1);
});

test("concurrent processes are isolated and all complete", async ({ page }) => {
  const results = await page.evaluate(async () => {
    const wc = (window as unknown as WcWindow).wc;
    const procs = await Promise.all(
      ["one", "two", "three", "four"].map((word) => wc.spawn("echo", [word])),
    );
    return Promise.all(
      procs.map(async (p) => ({
        id: p.processId,
        out: await new Response(p.stdout).text(),
        code: (await p.exit).exitCode,
      })),
    );
  });
  expect(results.map((r) => r.out)).toEqual(["one\n", "two\n", "three\n", "four\n"]);
  expect(results.every((r) => r.code === 0)).toBe(true);
  expect(new Set(results.map((r) => r.id)).size).toBe(4);
});

test("kill stops a long-running process with SIGTERM's status", async ({ page }) => {
  const result = await page.evaluate(async () => {
    const wc = (window as unknown as WcWindow).wc;
    const proc = await wc.spawn("sleep", ["60"]);
    const started = performance.now();
    await new Promise((resolve) => setTimeout(resolve, 300));
    proc.kill();
    const exit = await proc.exit;
    return { exit, ms: performance.now() - started };
  });
  expect(result.exit).toMatchObject({ exitCode: 143, signal: "SIGTERM" });
  expect(result.ms).toBeLessThan(5_000);
});

test("a killed process cannot corrupt the filesystem for the next one", async ({ page }) => {
  await page.evaluate(async () => {
    const wc = (window as unknown as WcWindow).wc;
    const p = await wc.spawn("sleep", ["60"]);
    p.kill("SIGKILL");
    await p.exit;
  });
  expect((await spawn(page, "echo", ["still fine"])).out).toBe("still fine\n");
  const big = await page.evaluate(async () => {
    const { fs } = (window as unknown as WcWindow).wc;
    await fs.writeFile("/after.txt", "ok");
    return new TextDecoder().decode(await fs.readFile("/after.txt"));
  });
  expect(big).toBe("ok");
});

test.describe("node", () => {
  const writeFiles = (page: import("@playwright/test").Page, files: Record<string, string>) =>
    page.evaluate(async (files) => {
      const { fs } = (window as unknown as WcWindow).wc;
      for (const [path, contents] of Object.entries(files)) {
        await fs.mkdir(path.slice(0, path.lastIndexOf("/")) || "/", { recursive: true });
        await fs.writeFile(path, contents);
      }
    }, files);

  test("node -e runs JavaScript in a process worker", async ({ page }) => {
    const r = await spawn(page, "node", ["-e", "console.log('hello', 1 + 1, [1, { a: 2 }])"]);
    expect(r).toEqual({ code: 0, out: "hello 2 [ 1, { a: 2 } ]\n", err: "" });
  });

  test("runs a script that requires other files and modules from node_modules", async ({ page }) => {
    await writeFiles(page, {
      "/app/main.js": `
        const greet = require("./greet");
        const dep = require("dep");
        console.log(greet(process.argv[2]), dep, require("path").basename(__filename));
      `,
      "/app/greet.js": `module.exports = (n) => "hello " + n`,
      "/app/node_modules/dep/package.json": `{"main":"lib.js"}`,
      "/app/node_modules/dep/lib.js": `module.exports = "dep-ok"`,
    });
    const r = await spawn(page, "node", ["main.js", "world"], "/app");
    expect(r).toEqual({ code: 0, out: "hello world dep-ok main.js\n", err: "" });
  });

  test("timers, promises and nextTick run in Node's order and the process exits when idle", async ({ page }) => {
    const r = await spawn(page, "node", ["-e", `
      setTimeout(() => console.log("timeout"), 30);
      setImmediate(() => console.log("immediate"));
      Promise.resolve().then(() => console.log("promise"));
      process.nextTick(() => console.log("tick"));
      console.log("sync");
    `]);
    expect(r.code).toBe(0);
    expect(r.out).toBe("sync\ntick\npromise\nimmediate\ntimeout\n");
  });

  test("exit codes, uncaught errors and stderr", async ({ page }) => {
    expect((await spawn(page, "node", ["-e", "process.exit(6)"])).code).toBe(6);
    const err = await spawn(page, "node", ["-e", "console.error('oops'); throw new TypeError('bad')"]);
    expect(err.code).toBe(1);
    expect(err.err).toContain("oops");
    expect(err.err).toContain("TypeError: bad");
    const missing = await spawn(page, "node", ["nope.js"]);
    expect(missing.code).toBe(1);
    expect(missing.err).toContain("Cannot find module");
  });

  test("output streams while the process is still running", async ({ page }) => {
    const result = await page.evaluate(async () => {
      const wc = (window as unknown as WcWindow).wc;
      const proc = await wc.spawn("node", ["-e", "console.log('early'); setTimeout(() => console.log('late'), 400)"]);
      const reader = proc.stdout.getReader();
      const first = await reader.read();
      const exitedYet = await Promise.race([proc.exit.then(() => true), new Promise((r) => setTimeout(() => r(false), 50))]);
      const rest = await new Response(new ReadableStream({
        async pull(c) { const { done, value } = await reader.read(); if (done) c.close(); else c.enqueue(value); },
      })).text();
      return { first: new TextDecoder().decode(first.value), exitedYet, rest, code: (await proc.exit).exitCode };
    });
    expect(result).toEqual({ first: "early\n", exitedYet: false, rest: "late\n", code: 0 });
  });

  test("kill stops a script that would run forever", async ({ page }) => {
    const r = await page.evaluate(async () => {
      const wc = (window as unknown as WcWindow).wc;
      const proc = await wc.spawn("node", ["-e", "setInterval(() => {}, 1000); console.log('running')"]);
      const reader = proc.stdout.getReader();
      await reader.read();
      const started = performance.now();
      proc.kill();
      const exit = await proc.exit;
      return { exit, ms: performance.now() - started };
    });
    expect(r.exit).toMatchObject({ exitCode: 143, signal: "SIGTERM" });
    expect(r.ms).toBeLessThan(3000);
  });

  test("several node processes run at once without interfering", async ({ page }) => {
    const results = await page.evaluate(async () => {
      const wc = (window as unknown as WcWindow).wc;
      const procs = await Promise.all(
        [1, 2, 3].map((n) =>
          wc.spawn("node", ["-e", `setTimeout(() => console.log("worker ${"$"}{${"$"}{n}}", process.pid > 0), ${"$"}{${"$"}{n}} * 20)`.replace(/\$\{\$\{n\}\}/g, String(n))]),
        ),
      );
      return Promise.all(procs.map(async (p) => new Response(p.stdout).text()));
    });
    expect(results).toEqual(["worker 1 true\n", "worker 2 true\n", "worker 3 true\n"]);
  });

  test("a script's globals do not leak into the next process", async ({ page }) => {
    await spawn(page, "node", ["-e", "global.leaked = 1"]);
    const r = await spawn(page, "node", ["-e", "console.log(typeof leaked)"]);
    expect(r.out).toBe("undefined\n");
  });

  test("a script reads a file the host wrote, and the host reads what the script wrote (the milestone)", async ({ page }) => {
    await writeFiles(page, { "/work/input.txt": "written by the host\n" });
    const r = await spawn(page, "node", ["-e", `
      const fs = require("fs");
      const text = fs.readFileSync("input.txt", "utf8");
      fs.writeFileSync("output.txt", text.toUpperCase());
      fs.mkdirSync("made/by/script", { recursive: true });
      console.log("read", text.length, "bytes");
    `], "/work");
    expect(r).toEqual({ code: 0, out: "read 20 bytes\n", err: "" });

    const seen = await page.evaluate(async () => {
      const { fs } = (window as unknown as WcWindow).wc;
      return {
        output: new TextDecoder().decode(await fs.readFile("/work/output.txt")),
        made: await fs.exists("/work/made/by/script"),
      };
    });
    expect(seen).toEqual({ output: "WRITTEN BY THE HOST\n", made: true });
  });

  test("fs errors, callbacks, promises and streams work in a real worker", async ({ page }) => {
    await writeFiles(page, { "/w/a.txt": "0123456789" });
    const r = await spawn(page, "node", ["-e", `
      const fs = require("fs");
      try { fs.readFileSync("/nope") } catch (e) { console.log(e.code, e.message) }
      fs.readFile("a.txt", "utf8", async (err, text) => {
        console.log("callback", text);
        console.log("promise", await fs.promises.readFile("a.txt", "utf8"), (await fs.promises.stat("a.txt")).size);
        let chunks = 0, total = 0;
        fs.createReadStream("a.txt", { highWaterMark: 4 }).on("data", (c) => { chunks++; total += c.length })
          .on("end", () => console.log("stream", chunks, total));
      });
    `], "/w");
    expect(r.code).toBe(0);
    expect(r.out).toBe("ENOENT ENOENT: no such file or directory, open '/nope'\ncallback 0123456789\npromise 0123456789 10\nstream 3 10\n");
  });

  test("a multi-megabyte file round-trips between two processes", async ({ page }) => {
    const w = await spawn(page, "node", ["-e", "require('fs').writeFileSync('/big.bin', Buffer.alloc(3_000_000, 5)); console.log('wrote')"]);
    expect(w.out).toBe("wrote\n");
    const r = await spawn(page, "node", ["-e", `
      const b = require("fs").readFileSync("/big.bin");
      console.log(b.length, b.every((x) => x === 5));
    `]);
    expect(r).toEqual({ code: 0, out: "3000000 true\n", err: "" });
  });

  test("fs.writeSync on fd 1 and 2 reaches the host's stdout and stderr", async ({ page }) => {
    const r = await spawn(page, "node", ["-e", "const fs = require('fs'); fs.writeSync(1, 'to stdout\\n'); fs.writeSync(2, 'to stderr\\n')"]);
    expect(r).toEqual({ code: 0, out: "to stdout\n", err: "to stderr\n" });
  });

  test("a killed process does not leak its open files", async ({ page }) => {
    // Two rounds: if the first process's descriptors leaked, the VFS would still
    // hold them; we can observe that as fd numbers never being reused.
    const fdOf = async () => {
      const proc = await spawn(page, "node", ["-e", "console.log(require('fs').openSync('/etc-none', 'w'))"]);
      return Number(proc.out.trim());
    };
    const first = await fdOf();
    const killed = await page.evaluate(async () => {
      const wc = (window as unknown as WcWindow).wc;
      const p = await wc.spawn("node", ["-e", "const fs = require('fs'); fs.openSync('/leak-a', 'w'); fs.openSync('/leak-b', 'w'); console.log('opened'); setInterval(() => {}, 1000)"]);
      await p.stdout.getReader().read();
      p.kill("SIGKILL");
      return (await p.exit).exitCode;
    });
    expect(killed).toBe(137);
    const second = await fdOf();
    expect(second).toBe(first);
  });

  test("os reports a Linux machine", async ({ page }) => {
    const r = await spawn(page, "node", ["-e", "const os = require('os'); console.log(os.platform(), os.tmpdir(), os.homedir(), os.EOL === '\\n')"]);
    expect(r).toEqual({ code: 0, out: "linux /tmp /home/user true\n", err: "" });
  });

  test("assert throws AssertionError uncaught, with a nonzero exit", async ({ page }) => {
    const r = await spawn(page, "node", [
      "-e",
      "const assert = require('assert'); assert.strictEqual(1, 1); assert.strictEqual(1, 2, 'boom')",
    ]);
    expect(r.code).toBe(1);
    expect(r.err).toContain("AssertionError");
    expect(r.err).toContain("boom");
  });

  test("the builtins Vite imports load and work in a real worker: url, module, perf_hooks, tty, tls/https", async ({ page }) => {
    await writeFiles(page, { "/app/lib/dep.js": "module.exports = 'dep via createRequire';" });
    const r = await spawn(page, "node", ["-e", `
      const url = require("node:url");
      console.log(new url.URLPattern({ pathname: "/books/:id" }).exec("https://x.com/books/42").pathname.groups.id, url.domainToASCII("español.com"));
      console.log(require("node:module").createRequire("file:///app/lib/entry.mjs")("./dep.js"));
      const { performance, createHistogram, monitorEventLoopDelay } = require("node:perf_hooks");
      const h = createHistogram(); [1, 2, 3, 4, 100].forEach((v) => h.record(v));
      console.log(h.percentile(50), h.mean, typeof performance.now());
      console.log(require("node:tty").isatty(1), require("node:querystring").stringify({ a: [1, 2] }), require("node:process") === process);
      try { require("node:https").createServer(); } catch (e) { console.log(e.code); }
      const eld = monitorEventLoopDelay({ resolution: 10 });
      eld.enable();
      setTimeout(() => { eld.disable(); console.log("eld", eld.count > 0, eld.min >= 1e6); }, 100);
    `], "/app");
    expect(r).toEqual({
      code: 0,
      out: "42 xn--espaol-zwa.com\ndep via createRequire\n3 22 number\nfalse a=1&a=2 true\nERR_NO_CRYPTO\neld true true\n",
      err: "",
    });
  });

  test("a worker_threads MessagePort's EventTarget-style onmessage/addEventListener get a real MessageEvent", async ({ page }) => {
    // Builds the event via internal/worker/io.js's createFastMessageEvent, from the undici
    // stand-in (runtime/shims.ts) - a Node-style port.on("message") never needed an event object.
    const r = await spawn(page, "node", ["-e", `
      const { MessageChannel } = require("worker_threads");
      const { port1, port2 } = new MessageChannel();
      let seen = 0;
      port1.addEventListener("message", (e) => console.log("listener", e.constructor.name, e.data));
      port1.onmessage = (e) => { console.log("onmessage", e.data); if (++seen === 2) port1.close(() => console.log("closed")); };
      port2.postMessage("one");
      port2.postMessage({ two: 2 });
    `]);
    // ...and closing the port releases it, so the process exits on its own, like real Node.
    expect(r).toEqual({ code: 0, out: "listener MessageEvent one\nonmessage one\nlistener MessageEvent { two: 2 }\nonmessage { two: 2 }\nclosed\n", err: "" });
  });

  test("readline reads lines from a piped Readable in a real worker", async ({ page }) => {
    const r = await spawn(page, "node", [
      "-e",
      "const readline = require('readline'); const { Readable } = require('stream');" +
        "const input = new Readable({ read() {} });" +
        "const rl = readline.createInterface({ input, terminal: false });" +
        "rl.on('line', (l) => console.log('line:', l));" +
        "rl.on('close', () => console.log('closed'));" +
        "input.push('one\\ntwo\\n'); input.push(null);",
    ]);
    expect(r).toEqual({ code: 0, out: "line: one\nline: two\nclosed\n", err: "" });
  });

  test.describe("child_process", () => {
    test("spawn() runs a real child in its own process worker and streams its stdout back", async ({ page }) => {
      const r = await spawn(page, "node", [
        "-e",
        "const { spawn } = require('child_process');" +
          "const child = spawn('echo', ['hello', 'from', 'child']);" +
          "let out = '';" +
          "child.stdout.on('data', (c) => { out += c; });" +
          "child.on('exit', (code, signal) => console.log(JSON.stringify({ code, signal, out, pid: typeof child.pid })));",
      ]);
      expect(r.code).toBe(0);
      expect(r.err).toBe("");
      expect(JSON.parse(r.out)).toEqual({ code: 0, signal: null, out: "hello from child\n", pid: "number" });
    });

    test("a long-lived service child: requests in over fs.read(0), replies out over fs.write(1), and an unref'd child doesn't hold its parent", async ({ page }) => {
      // esbuild-wasm's own shape: its JS API spawns `node .../bin/esbuild --service`, whose Go
      // WebAssembly runtime reads requests with fs.read(0) and answers with fs.write(1), then
      // unrefs the child and both pipes so an idle service never keeps the script alive.
      await writeFiles(page, {
        "/svc/service.js": `
          const fs = require("fs");
          const buf = Buffer.alloc(64);
          const loop = () => fs.read(0, buf, 0, buf.length, null, (err, n) => {
            if (err || n === 0) return;
            const reply = Buffer.from("echo:" + buf.toString("utf8", 0, n).toUpperCase());
            fs.write(1, reply, 0, reply.length, null, loop);
          });
          loop();
        `,
        "/svc/main.js": `
          const child = require("child_process").spawn("node", ["service.js"], { stdio: ["pipe", "pipe", "inherit"] });
          child.stdout.on("data", (d) => {
            console.log("got", String(d));
            child.unref(); child.stdin.unref?.(); child.stdout.unref?.();
          });
          child.stdin.write("ping");
        `,
      });
      const r = await spawn(page, "node", ["main.js"], "/svc");
      expect(r).toEqual({ code: 0, out: "got echo:PING\n", err: "" });
    });

    test("a child that fails to run reports a nonzero exit, not a crash", async ({ page }) => {
      const r = await spawn(page, "node", [
        "-e",
        "const { spawn } = require('child_process');" +
          "const child = spawn('this-command-does-not-exist', []);" +
          "child.on('exit', (code) => console.log('exit', code));",
      ]);
      expect(r).toEqual({ code: 0, out: "exit 127\n", err: "" });
    });

    test("execFile runs the child and collects its output via a callback", async ({ page }) => {
      const r = await spawn(page, "node", [
        "-e",
        "require('child_process').execFile('echo', ['via', 'execFile'], (err, stdout, stderr) => " +
          "console.log(JSON.stringify({ err, stdout, stderr })));",
      ]);
      expect(r.code).toBe(0);
      expect(JSON.parse(r.out)).toEqual({ err: null, stdout: "via execFile\n", stderr: "" });
    });

    test("child.kill() stops a long-running child and reports the signal", async ({ page }) => {
      const r = await spawn(page, "node", [
        "-e",
        "const { spawn } = require('child_process');" +
          "const child = spawn('sleep', ['9']);" +
          "child.on('exit', (code, signal) => console.log(JSON.stringify({ code, signal })));" +
          "child.on('spawn', () => child.kill('SIGKILL'));",
      ]);
      expect(r).toEqual({ code: 0, out: JSON.stringify({ code: null, signal: "SIGKILL" }) + "\n", err: "" });
    });

    test("a node child of a node parent: nested real process workers", async ({ page }) => {
      const r = await spawn(page, "node", [
        "-e",
        "const { spawn } = require('child_process');" +
          "const child = spawn('node', ['-e', \"console.log('hi from grandchild')\"]);" +
          "let out = '';" +
          "child.stdout.on('data', (c) => { out += c; });" +
          "child.on('exit', (code) => console.log(JSON.stringify({ code, out })));",
      ]);
      expect(r.code).toBe(0);
      expect(JSON.parse(r.out)).toEqual({ code: 0, out: "hi from grandchild\n" });
    });

    test("killing a parent also kills its still-running child_process children (subtree kill)", async ({ page }) => {
      // The child sets a timer that would leave an observable trace on the VFS
      // if it kept running after the parent is gone; a real Process Worker
      // getting terminated drops that timer with it, so the file never appears.
      const r = await page.evaluate(async () => {
        const wc = (window as unknown as WcWindow).wc;
        const parent = await wc.spawn("node", [
          "-e",
          "const { spawn } = require('child_process');" +
            "spawn('node', ['-e', \"setTimeout(() => require('fs').writeFileSync('/child-finished', 'yes'), 150)\"]);" +
            "setInterval(() => {}, 10000);",
        ]);
        await new Promise((resolve) => setTimeout(resolve, 50));
        parent.kill();
        await parent.exit;
        await new Promise((resolve) => setTimeout(resolve, 300));
        return { childFinished: await wc.fs.exists("/child-finished") };
      });
      expect(r.childFinished).toBe(false);
    });
  });

  test.describe("execSync / spawnSync", () => {
    test("spawnSync blocks until the child exits and returns its buffered output", async ({ page }) => {
      const r = await spawn(page, "node", [
        "-e",
        "const { spawnSync } = require('child_process');" +
          "const r = spawnSync('echo', ['from spawnSync']);" +
          "console.log(JSON.stringify({ status: r.status, signal: r.signal, out: r.stdout.toString() }));",
      ]);
      expect(r).toMatchObject({ code: 0, out: JSON.stringify({ status: 0, signal: null, out: "from spawnSync\n" }) + "\n" });
    });

    test("execSync returns stdout and throws on a nonzero exit", async ({ page }) => {
      const r = await spawn(page, "node", [
        "-e",
        "const { execSync } = require('child_process');" +
          "console.log(execSync('echo hi', { encoding: 'utf8' }));" +
          "try { execSync('false'); console.log('should have thrown'); }" +
          "catch (e) { console.log('threw:', e.message.split('\\n')[0]); }",
      ]);
      expect(r.out).toBe("hi\n\nthrew: Command failed: false\n");
    });

    test("the `input` option feeds the child's stdin", async ({ page }) => {
      const r = await spawn(page, "node", [
        "-e",
        "const r = require('child_process').spawnSync('cat', [], { input: 'piped in via spawnSync' });" +
          "console.log(r.stdout.toString());",
      ]);
      expect(r).toMatchObject({ code: 0, out: "piped in via spawnSync\n" });
    });

    test("a real script running through sh -c is spawned and awaited synchronously", async ({ page }) => {
      const r = await spawn(page, "node", [
        "-e",
        "const r = require('child_process').spawnSync('sh', ['-c', 'echo one; echo two']);" +
          "console.log(r.stdout.toString());",
      ]);
      expect(r).toMatchObject({ code: 0, out: "one\ntwo\n\n" });
    });

    test("a timeout kills a still-running child and reports the signal", async ({ page }) => {
      const r = await spawn(page, "node", [
        "-e",
        "const r = require('child_process').spawnSync('sleep', ['5'], { timeout: 100 });" +
          "console.log(JSON.stringify({ status: r.status, signal: r.signal }));",
      ]);
      expect(r).toMatchObject({ code: 0, out: JSON.stringify({ status: null, signal: "SIGTERM" }) + "\n" });
    });
  });

  test.describe("fork() / IPC", () => {
    test("a forked child receives a message and replies, over a real bidirectional ipc channel", async ({ page }) => {
      await writeFiles(page, {
        "/app/child.js": `
          process.on("message", (m) => {
            process.send({ echo: m });
            process.exit(0); // a live 'message' listener keeps a real fork()ed child alive
            // forever otherwise (real Node semantics) - it must exit explicitly once done.
          });
        `,
      });
      const r = await spawn(page, "node", [
        "-e",
        "const child = require('child_process').fork('/app/child.js', { silent: true });" +
          "child.on('message', (m) => { console.log('parent got', JSON.stringify(m)); child.disconnect(); });" +
          "child.send({ hello: 'world' });",
      ]);
      expect(r).toMatchObject({ code: 0, out: 'parent got {"echo":{"hello":"world"}}\n' });
    });

    test("the child's own process.send/on('message') work the other way too - it can speak first", async ({ page }) => {
      await writeFiles(page, {
        "/app/child.js": `
          process.send({ ready: true });
          process.on("message", (m) => {
            if (m.stop) process.exit(0);
          });
        `,
      });
      const r = await spawn(page, "node", [
        "-e",
        "const child = require('child_process').fork('/app/child.js', { silent: true });" +
          "child.on('message', (m) => { console.log(JSON.stringify(m)); child.send({ stop: true }); });",
      ]);
      expect(r).toMatchObject({ code: 0, out: '{"ready":true}\n' });
    });

    test("child.disconnect() ends the channel; the child sees 'disconnect' and exits on its own", async ({ page }) => {
      // Fork's default stdio is 'inherit' (real fd-sharing this sandbox can't do), so a
      // disconnected child's own stdout has nowhere to go - confirm it ran via a file instead,
      // the same way subtree-kill above observes child-side behavior externally.
      await writeFiles(page, {
        "/app/child.js": `
          console.log("child: started");
          process.on("message", () => {});
          process.on("disconnect", () => { console.log("child: disconnected"); process.exit(0); });
        `,
      });
      const r = await page.evaluate(async () => {
        const wc = (window as unknown as WcWindow).wc;
        const proc = await wc.spawn("node", [
          "-e",
          "const child = require('child_process').fork('/app/child.js', { silent: true });" +
            "child.stdout.on('data', (c) => process.stdout.write(c));" +
            "setTimeout(() => child.disconnect(), 50);" +
            "child.on('exit', (code) => console.log('child exited', code));",
        ]);
        const [out, err, exit] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exit]);
        return { out, err, code: exit.exitCode };
      });
      expect(r).toMatchObject({ code: 0, out: "child: started\nchild: disconnected\nchild exited 0\n", err: "" });
    });
  });

  test.describe("stdin", () => {
    test("process.stdin delivers what the host writes, and ends when the host closes it", async ({ page }) => {
      const r = await page.evaluate(async () => {
        const wc = (window as unknown as WcWindow).wc;
        const proc = await wc.spawn("node", [
          "-e",
          "let out = ''; process.stdin.on('data', (c) => { out += c; });" +
            "process.stdin.on('end', () => console.log('end:', out)); process.stdin.resume();",
        ]);
        const writer = proc.stdin.getWriter();
        await writer.write(new TextEncoder().encode("hello "));
        await writer.write(new TextEncoder().encode("world"));
        await writer.close();
        const [out, err, exit] = await Promise.all([
          new Response(proc.stdout).text(),
          new Response(proc.stderr).text(),
          proc.exit,
        ]);
        return { code: exit.exitCode, out, err };
      });
      expect(r).toEqual({ code: 0, out: "end: hello world\n", err: "" });
    });

    test("cat with no args streams real stdin to stdout", async ({ page }) => {
      const r = await page.evaluate(async () => {
        const wc = (window as unknown as WcWindow).wc;
        const proc = await wc.spawn("cat", []);
        const writer = proc.stdin.getWriter();
        await writer.write(new TextEncoder().encode("piped through cat"));
        await writer.close();
        const [out, err, exit] = await Promise.all([
          new Response(proc.stdout).text(),
          new Response(proc.stderr).text(),
          proc.exit,
        ]);
        return { code: exit.exitCode, out, err };
      });
      expect(r).toEqual({ code: 0, out: "piped through cat", err: "" });
    });

    test("child_process: child.stdin.write()/end() reach the real child's stdin", async ({ page }) => {
      const r = await spawn(page, "node", [
        "-e",
        "const { spawn } = require('child_process');" +
          "const child = spawn('cat', []);" +
          "let out = '';" +
          "child.stdout.on('data', (c) => { out += c; });" +
          "child.on('exit', () => console.log(out));" +
          "child.stdin.write('from parent ');" +
          "child.stdin.end('to child');",
      ]);
      expect(r).toEqual({ code: 0, out: "from parent to child\n", err: "" });
    });
  });

  test.describe("esm", () => {
    test("static import: named and default exports, live via the browser's real linking", async ({ page }) => {
      await writeFiles(page, {
        "/lib.mjs": "export const greeting = 'hello esm';\nexport default 42;\n",
        "/main.mjs": "import def, { greeting } from './lib.mjs';\nconsole.log(greeting, def);\n",
      });
      const r = await spawn(page, "node", ["/main.mjs"]);
      expect(r).toEqual({ code: 0, out: "hello esm 42\n", err: "" });
    });

    test("dynamic import() and top-level await both work", async ({ page }) => {
      await writeFiles(page, {
        "/lib.mjs": "export const x = 1;\n",
        "/main.mjs": "const m = await import('./lib.mjs');\nconsole.log(m.x);\n",
      });
      const r = await spawn(page, "node", ["/main.mjs"]);
      expect(r).toEqual({ code: 0, out: "1\n", err: "" });
    });

    test("import() from a CommonJS module reaches ESM, builtins and node_modules, resolving from that module's own file", async ({ page }) => {
      await writeFiles(page, {
        "/app/lib/loader.js": `module.exports = async () => {
          const esm = await import("./esm.mjs");
          const path = await import("node:path");
          const pkg = await import("pkg");
          return [esm.x, esm.default, path.basename("/a/b.txt"), pkg.default.name];
        };`,
        "/app/lib/esm.mjs": "export const x = 'esm-x';\nexport default 'esm-default';\n",
        "/app/node_modules/pkg/package.json": '{"name":"pkg","main":"index.js"}',
        "/app/node_modules/pkg/index.js": "module.exports = { name: 'pkg-cjs' };",
        "/app/main.js": "require('./lib/loader.js')().then((v) => console.log(v.join(' ')));",
      });
      const r = await spawn(page, "node", ["main.js"], "/app");
      expect(r).toEqual({ code: 0, out: "esm-x esm-default b.txt pkg-cjs\n", err: "" });
    });

    test("import() from node -e resolves from the cwd, and a failing one rejects instead of vanishing", async ({ page }) => {
      await writeFiles(page, { "/app/esm.mjs": "export const answer = 42;\n" });
      const r = await spawn(page, "node", ["-e", `
        import("./esm.mjs").then((m) => console.log("answer", m.answer));
        import("./missing.mjs").catch((e) => console.log("rejected", e.code));
      `], "/app");
      expect(r.code).toBe(0);
      expect(r.out.split("\n").filter(Boolean).sort()).toEqual(["answer 42", "rejected ERR_MODULE_NOT_FOUND"]);
    });

    test("import.meta is the module's real file:// URL - what Vite does with it all works", async ({ page }) => {
      await writeFiles(page, {
        "/app/src/main.mjs": `
          import { readFileSync } from "node:fs";
          import { fileURLToPath } from "node:url";
          import { createRequire } from "node:module";
          console.log(import.meta.url, import.meta.filename, import.meta.dirname);
          console.log(readFileSync(new URL("../package.json", import.meta.url), "utf8").trim());
          console.log(fileURLToPath(new URL("./other.mjs", import.meta.url)));
          console.log(createRequire(import.meta.url)("./helper.cjs"));
          console.log(import.meta.resolve("./other.mjs"), import.meta.resolve("node:fs"));
          const other = await import(new URL("./other.mjs", import.meta.url).pathname);
          console.log(other.whoami, import.meta === import.meta);
        `,
        "/app/src/other.mjs": "export const whoami = import.meta.url;\n",
        "/app/src/helper.cjs": "module.exports = 'required from ' + __filename;",
        "/app/package.json": '{"name":"meta-app"}',
      });
      const r = await spawn(page, "node", ["src/main.mjs"], "/app");
      expect(r).toEqual({
        code: 0,
        out:
          "file:///app/src/main.mjs /app/src/main.mjs /app/src\n" +
          '{"name":"meta-app"}\n' +
          "/app/src/other.mjs\n" +
          "required from /app/src/helper.cjs\n" +
          "file:///app/src/other.mjs node:fs\n" +
          "file:///app/src/other.mjs true\n",
        err: "",
      });
    });

    test("importing a CJS file from ESM: default is module.exports, named exports are its own keys", async ({ page }) => {
      await writeFiles(page, {
        "/lib.cjs": "module.exports = { a: 1, b: 2 };\n",
        "/main.mjs": "import mod, { a, b } from './lib.cjs';\nconsole.log(JSON.stringify(mod), a, b);\n",
      });
      const r = await spawn(page, "node", ["/main.mjs"]);
      expect(r).toEqual({ code: 0, out: '{"a":1,"b":2} 1 2\n', err: "" });
    });

    test("a node: builtin can be imported from ESM, named exports included", async ({ page }) => {
      await writeFiles(page, { "/main.mjs": "import { basename } from 'node:path';\nconsole.log(basename('/a/b.js'));\n" });
      const r = await spawn(page, "node", ["/main.mjs"]);
      expect(r).toEqual({ code: 0, out: "b.js\n", err: "" });
    });

    test("a JSON file can be imported with `with { type: 'json' }`", async ({ page }) => {
      await writeFiles(page, {
        "/data.json": '{"a":1,"b":[2,3]}',
        "/main.mjs": "import data from './data.json' with { type: 'json' };\nconsole.log(JSON.stringify(data));\n",
      });
      const r = await spawn(page, "node", ["/main.mjs"]);
      expect(r).toEqual({ code: 0, out: '{"a":1,"b":[2,3]}\n', err: "" });
    });

    test("a node_modules package resolves through its package.json \"exports\" field", async ({ page }) => {
      await writeFiles(page, {
        "/node_modules/pkg/package.json": '{"name":"pkg","exports":{"import":"./esm.mjs","require":"./cjs.cjs"}}',
        "/node_modules/pkg/esm.mjs": "export const via = 'esm-exports';\n",
        "/main.mjs": "import { via } from 'pkg';\nconsole.log(via);\n",
      });
      const r = await spawn(page, "node", ["/main.mjs"]);
      expect(r).toEqual({ code: 0, out: "esm-exports\n", err: "" });
    });

    test("a package.json \"type\": \"module\" makes its plain .js files ESM", async ({ page }) => {
      await writeFiles(page, {
        "/pkg/package.json": '{"type":"module"}',
        "/pkg/lib.js": "export const y = 99;\n",
        "/pkg/main.js": "import { y } from './lib.js';\nconsole.log(y);\n",
      });
      const r = await spawn(page, "node", ["/pkg/main.js"]);
      expect(r).toEqual({ code: 0, out: "99\n", err: "" });
    });

    test("a genuinely circular static import throws a clear error instead of a silent wrong value", async ({ page }) => {
      await writeFiles(page, {
        "/a.mjs": "import { b } from './b.mjs';\nexport const a = 1;\nconsole.log('a', b);\n",
        "/b.mjs": "import { a } from './a.mjs';\nexport const b = 2;\nconsole.log('b', a);\n",
      });
      const r = await spawn(page, "node", ["/a.mjs"]);
      expect(r.code).toBe(1);
      expect(r.err).toContain("Circular static ESM import");
    });
  });

  test.describe("fs.watch", () => {
    // The single-threaded Vitest suite (packages/core/src/runtime/fsWatch.test.ts) already
    // covers fs.watch/fs.watchFile's detailed semantics (eventType, recursive, filenames, ...)
    // against a real FsServer, just not over a real postMessage/worker boundary. These three
    // exercise exactly that boundary: the fs worker's watch registry -> kernel -> a DIFFERENT
    // real Process Worker than the one that caused the change - the one thing that can't be
    // faked in Vitest.

    test("the host's own wc.fs.writeFile is seen by a process's fs.watch, in a real worker", async ({ page }) => {
      const r = await page.evaluate(async () => {
        const wc = (window as unknown as WcWindow).wc;
        await wc.fs.mkdir("/proj");
        await wc.fs.writeFile("/proj/a.txt", "one");
        const proc = await wc.spawn("node", [
          "-e",
          "const fs = require('fs');" +
            "const w = fs.watch('/proj', (eventType, filename) => {" +
            "  w.close();" +
            "  console.log(eventType, filename);" +
            "});" +
            "console.log('ready');",
        ]);
        // Waits for the script's own "ready\n" (printed right after fs.watch()'s synchronous
        // registration call returns) before writing - wc.spawn() resolving only means the
        // worker started, not that its script has reached the fs.watch() call yet.
        const reader = proc.stdout.getReader();
        const first = await reader.read();
        if (new TextDecoder().decode(first.value) !== "ready\n") throw new Error("watcher did not become ready");
        await wc.fs.writeFile("/proj/a.txt", "two");
        const rest = await new Response(
          new ReadableStream({
            async pull(c) {
              const { done, value } = await reader.read();
              if (done) c.close();
              else c.enqueue(value);
            },
          }),
        ).text();
        const [err, exit] = await Promise.all([new Response(proc.stderr).text(), proc.exit]);
        return { code: exit.exitCode, rest, err };
      });
      expect(r).toEqual({ code: 0, rest: "change a.txt\n", err: "" });
    });

    test("one process's fs.watch sees another real process's write, routed through the kernel", async ({ page }) => {
      const r = await page.evaluate(async () => {
        const wc = (window as unknown as WcWindow).wc;
        await wc.fs.mkdir("/shared");
        const watcher = await wc.spawn("node", [
          "-e",
          "const fs = require('fs');" +
            "const w = fs.watch('/shared', { recursive: true }, (eventType, filename) => {" +
            "  w.close();" +
            "  console.log(eventType, filename);" +
            "});" +
            "console.log('ready');",
        ]);
        const reader = watcher.stdout.getReader();
        const first = await reader.read();
        if (new TextDecoder().decode(first.value) !== "ready\n") throw new Error("watcher did not become ready");
        const writer = await wc.spawn("node", ["-e", "require('fs').writeFileSync('/shared/from-writer.txt', 'hi')"]);
        const rest = await new Response(
          new ReadableStream({
            async pull(c) {
              const { done, value } = await reader.read();
              if (done) c.close();
              else c.enqueue(value);
            },
          }),
        ).text();
        const [watcherErr, watcherExit, writerExit] = await Promise.all([new Response(watcher.stderr).text(), watcher.exit, writer.exit]);
        return { code: watcherExit.exitCode, rest, err: watcherErr, writerCode: writerExit.exitCode };
      });
      expect(r).toEqual({ code: 0, rest: "rename from-writer.txt\n", err: "", writerCode: 0 });
    });

    test("fs.watchFile really polls on a real native timer in a real worker, and unwatchFile lets the process exit", async ({ page }) => {
      const r = await spawn(page, "node", [
        "-e",
        "const fs = require('fs');" +
          "fs.writeFileSync('/a.txt', 'one');" +
          "fs.watchFile('/a.txt', { interval: 20 }, (curr, prev) => {" +
          "  fs.unwatchFile('/a.txt');" +
          "  console.log('changed', curr.size, prev.size);" +
          "});" +
          "setTimeout(() => fs.writeFileSync('/a.txt', 'a much longer body'), 60);",
      ]);
      expect(r).toEqual({ code: 0, out: "changed 18 3\n", err: "" });
    });
  });

  test.describe("net", () => {
    // net.createServer/net.connect are entirely virtual (kernel/netServer.ts relays bytes
    // between two real Process Workers) - these can't be exercised in the single-threaded
    // Vitest suite (packages/core/src/runtime/net.test.ts) at all, since that needs a real
    // postMessage round-trip through a real Kernel Worker between two separate real workers.

    test("a real client process connects to a real server process on an explicit port, and data flows both ways", async ({ page }) => {
      const r = await page.evaluate(async () => {
        const wc = (window as unknown as WcWindow).wc;
        const server = await wc.spawn("node", [
          "-e",
          "const net = require('net');" +
            "const server = net.createServer((socket) => {" +
            "  socket.on('data', (chunk) => socket.write('echo:' + chunk));" +
            "});" +
            "server.listen(4000, () => console.log('ready'));",
        ]);
        // Waits for the server's own "ready\n" before spawning the client - wc.spawn() resolving
        // only means the worker started, not that its script has reached listen()'s callback yet.
        const serverReader = server.stdout.getReader();
        const first = await serverReader.read();
        if (new TextDecoder().decode(first.value) !== "ready\n") throw new Error("server did not become ready");

        const client = await wc.spawn("node", [
          "-e",
          "const net = require('net');" +
            "const socket = net.connect(4000, () => socket.write('hi'));" +
            "socket.on('data', (chunk) => { console.log(chunk.toString()); process.exit(0); });",
        ]);
        const [clientOut, clientErr, clientExit] = await Promise.all([
          new Response(client.stdout).text(),
          new Response(client.stderr).text(),
          client.exit,
        ]);

        server.kill();
        const serverExit = await server.exit;
        return { clientOut, clientErr, clientCode: clientExit.exitCode, serverSignal: serverExit.signal };
      });
      expect(r).toEqual({ clientOut: "echo:hi\n", clientErr: "", clientCode: 0, serverSignal: "SIGTERM" });
    });

    test("listen(0) auto-assigns different real ports to two different real processes", async ({ page }) => {
      const r = await page.evaluate(async () => {
        const wc = (window as unknown as WcWindow).wc;
        const spawnListener = () =>
          wc.spawn("node", ["-e", "const net = require('net'); const s = net.createServer(); s.listen(0, () => { console.log(s.address().port); s.close(); });"]);
        const [a, b] = await Promise.all([spawnListener(), spawnListener()]);
        const [outA, outB] = await Promise.all([new Response(a.stdout).text(), new Response(b.stdout).text()]);
        return { portA: Number(outA), portB: Number(outB) };
      });
      expect(r.portA).toBeGreaterThan(0);
      expect(r.portB).toBeGreaterThan(0);
      expect(r.portA).not.toBe(r.portB);
    });

    test("a second real process listening on an already-used port gets a real EADDRINUSE", async ({ page }) => {
      const r = await page.evaluate(async () => {
        const wc = (window as unknown as WcWindow).wc;
        const first = await wc.spawn("node", ["-e", "const net = require('net'); net.createServer().listen(4100, () => console.log('ready'));"]);
        const reader = first.stdout.getReader();
        const ready = await reader.read();
        if (new TextDecoder().decode(ready.value) !== "ready\n") throw new Error("first server did not become ready");

        const second = await wc.spawn("node", [
          "-e",
          "const net = require('net');" +
            "const s = net.createServer();" +
            "s.on('error', (e) => { console.log('error', e.code); process.exit(0); });" +
            "s.listen(4100);",
        ]);
        const [secondOut, secondErr, secondExit] = await Promise.all([
          new Response(second.stdout).text(),
          new Response(second.stderr).text(),
          second.exit,
        ]);

        first.kill();
        await first.exit;
        return { out: secondOut, err: secondErr, code: secondExit.exitCode };
      });
      expect(r).toEqual({ code: 0, out: "error EADDRINUSE\n", err: "" });
    });

    test("connecting to a real port nobody is listening on gets a real ECONNREFUSED", async ({ page }) => {
      const r = await spawn(page, "node", [
        "-e",
        "const net = require('net');" +
          "const s = net.connect(4200);" +
          "s.on('error', (e) => { console.log('error', e.code); process.exit(0); });",
      ]);
      expect(r).toEqual({ code: 0, out: "error ECONNREFUSED\n", err: "" });
    });
  });

  test.describe("dgram", () => {
    // dgram.createSocket/bind/send are entirely virtual too (kernel/netServer.ts's own, separate
    // UDP port registry) - same reason as net's own describe block above: this needs a real
    // postMessage round-trip through a real Kernel Worker between two separate real Process
    // Workers, which the single-threaded Vitest suite (packages/core/src/runtime/udp.test.ts)
    // can't exercise.

    test("a real client process sends a datagram to a real server process, which echoes it back", async ({ page }) => {
      const r = await page.evaluate(async () => {
        const wc = (window as unknown as WcWindow).wc;
        const server = await wc.spawn("node", [
          "-e",
          "const dgram = require('dgram');" +
            "const s = dgram.createSocket('udp4');" +
            "s.on('message', (msg, rinfo) => s.send('echo:' + msg, rinfo.port));" +
            "s.bind(7000, () => console.log('ready'));",
        ]);
        const serverReader = server.stdout.getReader();
        const first = await serverReader.read();
        if (new TextDecoder().decode(first.value) !== "ready\n") throw new Error("server did not become ready");

        const client = await wc.spawn("node", [
          "-e",
          "const dgram = require('dgram');" +
            "const s = dgram.createSocket('udp4');" +
            "s.on('message', (msg) => { console.log(msg.toString()); process.exit(0); });" +
            "s.bind(0, () => s.send('hi', 7000));",
        ]);
        const [clientOut, clientErr, clientExit] = await Promise.all([
          new Response(client.stdout).text(),
          new Response(client.stderr).text(),
          client.exit,
        ]);

        server.kill();
        const serverExit = await server.exit;
        return { clientOut, clientErr, clientCode: clientExit.exitCode, serverSignal: serverExit.signal };
      });
      expect(r).toEqual({ clientOut: "echo:hi\n", clientErr: "", clientCode: 0, serverSignal: "SIGTERM" });
    });

    test("bind(0) auto-assigns different real ports to two different real processes", async ({ page }) => {
      const r = await page.evaluate(async () => {
        const wc = (window as unknown as WcWindow).wc;
        const spawnBound = () =>
          wc.spawn("node", ["-e", "const dgram = require('dgram'); const s = dgram.createSocket('udp4'); s.bind(0, () => { console.log(s.address().port); s.close(); });"]);
        const [a, b] = await Promise.all([spawnBound(), spawnBound()]);
        const [outA, outB] = await Promise.all([new Response(a.stdout).text(), new Response(b.stdout).text()]);
        return { portA: Number(outA), portB: Number(outB) };
      });
      expect(r.portA).toBeGreaterThan(0);
      expect(r.portB).toBeGreaterThan(0);
      expect(r.portA).not.toBe(r.portB);
    });

    test("a second real process binding an already-bound UDP port gets a real EADDRINUSE", async ({ page }) => {
      const r = await page.evaluate(async () => {
        const wc = (window as unknown as WcWindow).wc;
        const first = await wc.spawn("node", ["-e", "const dgram = require('dgram'); dgram.createSocket('udp4').bind(7100, () => console.log('ready'));"]);
        const reader = first.stdout.getReader();
        const ready = await reader.read();
        if (new TextDecoder().decode(ready.value) !== "ready\n") throw new Error("first socket did not become ready");

        const second = await wc.spawn("node", [
          "-e",
          "const dgram = require('dgram');" +
            "const s = dgram.createSocket('udp4');" +
            "s.on('error', (e) => { console.log('error', e.code); process.exit(0); });" +
            "s.bind(7100);",
        ]);
        const [secondOut, secondErr, secondExit] = await Promise.all([
          new Response(second.stdout).text(),
          new Response(second.stderr).text(),
          second.exit,
        ]);

        first.kill();
        await first.exit;
        return { out: secondOut, err: secondErr, code: secondExit.exitCode };
      });
      expect(r).toEqual({ code: 0, out: "error EADDRINUSE\n", err: "" });
    });

    test("a datagram sent to a port nobody is bound to is simply never delivered - no error, no hang", async ({ page }) => {
      const r = await spawn(page, "node", [
        "-e",
        "const dgram = require('dgram');" +
          "const s = dgram.createSocket('udp4');" +
          "s.send('nobody home', 7200, () => { s.close(); console.log('done'); });",
      ]);
      expect(r).toEqual({ code: 0, out: "done\n", err: "" });
    });
  });

  test.describe("http", () => {
    // http.createServer()/http.request() run entirely on top of net (net.test.ts already covers
    // net's own cross-process plumbing) - these prove the real vendored _http_server.js/
    // _http_client.js/_http_outgoing.js stack round-trips correctly over that real relay between
    // two separate real Process Workers, which packages/core's single-threaded http.test.ts
    // (fake net host, one side at a time) can't exercise.

    test("a real client process GETs from a real server process: status, headers, and body round-trip", async ({ page }) => {
      const r = await page.evaluate(async () => {
        const wc = (window as unknown as WcWindow).wc;
        const server = await wc.spawn("node", [
          "-e",
          "const http = require('http');" +
            "const server = http.createServer((req, res) => {" +
            "  res.setHeader('Content-Type', 'text/plain');" +
            "  res.end('hello from server');" +
            "});" +
            "server.listen(5000, () => console.log('ready'));",
        ]);
        const serverReader = server.stdout.getReader();
        const first = await serverReader.read();
        if (new TextDecoder().decode(first.value) !== "ready\n") throw new Error("server did not become ready");

        const client = await wc.spawn("node", [
          "-e",
          "const http = require('http');" +
            "http.get('http://h:5000/x', (res) => {" +
            "  let body = '';" +
            "  res.on('data', (c) => { body += c; });" +
            "  res.on('end', () => { console.log(res.statusCode, res.headers['content-type'], body); process.exit(0); });" +
            "});",
        ]);
        const [clientOut, clientErr, clientExit] = await Promise.all([
          new Response(client.stdout).text(),
          new Response(client.stderr).text(),
          client.exit,
        ]);

        server.kill();
        const serverExit = await server.exit;
        return { clientOut, clientErr, clientCode: clientExit.exitCode, serverSignal: serverExit.signal };
      });
      expect(r).toEqual({
        clientOut: "200 text/plain hello from server\n",
        clientErr: "",
        clientCode: 0,
        serverSignal: "SIGTERM",
      });
    });

    test("a real client process POSTs a body to a real server process, which streams and echoes it back", async ({ page }) => {
      const r = await page.evaluate(async () => {
        const wc = (window as unknown as WcWindow).wc;
        const server = await wc.spawn("node", [
          "-e",
          "const http = require('http');" +
            "const server = http.createServer((req, res) => {" +
            "  let body = '';" +
            "  req.on('data', (c) => { body += c; });" +
            "  req.on('end', () => { res.end('echo:' + body); });" +
            "});" +
            "server.listen(5001, () => console.log('ready'));",
        ]);
        const serverReader = server.stdout.getReader();
        const first = await serverReader.read();
        if (new TextDecoder().decode(first.value) !== "ready\n") throw new Error("server did not become ready");

        const client = await wc.spawn("node", [
          "-e",
          "const http = require('http');" +
            "const req = http.request({ hostname: 'h', port: 5001, path: '/', method: 'POST' }, (res) => {" +
            "  let body = '';" +
            "  res.on('data', (c) => { body += c; });" +
            "  res.on('end', () => { console.log(body); process.exit(0); });" +
            "});" +
            "req.end('payload data');",
        ]);
        const [clientOut, clientErr, clientExit] = await Promise.all([
          new Response(client.stdout).text(),
          new Response(client.stderr).text(),
          client.exit,
        ]);

        server.kill();
        const serverExit = await server.exit;
        return { clientOut, clientErr, clientCode: clientExit.exitCode, serverSignal: serverExit.signal };
      });
      expect(r).toEqual({
        clientOut: "echo:payload data\n",
        clientErr: "",
        clientCode: 0,
        serverSignal: "SIGTERM",
      });
    });
  });

  test.describe("preview", () => {
    // wc.preview relays a same-origin fetch() from the HOST PAGE itself through a real Service
    // Worker, the kernel, and the same virtual net/http a script's own http.createServer() is
    // listening on - none of that (Service Worker registration/activation/claiming, or a real
    // browser `fetch()`) can be exercised outside real Chromium at all.

    test("fetch() to the preview URL relays through the Service Worker into a real listening http.createServer()", async ({ page }) => {
      const r = await page.evaluate(async () => {
        const wc = (window as unknown as WcWindow).wc;
        await wc.preview.enable();
        const server = await wc.spawn("node", [
          "-e",
          "const http = require('http');" +
            "const server = http.createServer((req, res) => {" +
            "  res.setHeader('Content-Type', 'text/plain');" +
            "  res.end('hello from preview: ' + req.url);" +
            "});" +
            "server.listen(6000, () => console.log('ready'));",
        ]);
        const reader = server.stdout.getReader();
        const first = await reader.read();
        if (new TextDecoder().decode(first.value) !== "ready\n") throw new Error("server did not become ready");

        const response = await fetch(wc.preview.url(6000, "/hello?x=1"));
        const text = await response.text();
        server.kill();
        await server.exit;
        return { status: response.status, contentType: response.headers.get("content-type"), text };
      });
      expect(r).toEqual({ status: 200, contentType: "text/plain", text: "hello from preview: /hello?x=1" });
    });

    test("a POST body reaches the guest server's request handler for real", async ({ page }) => {
      const r = await page.evaluate(async () => {
        const wc = (window as unknown as WcWindow).wc;
        await wc.preview.enable();
        const server = await wc.spawn("node", [
          "-e",
          "const http = require('http');" +
            "const server = http.createServer((req, res) => {" +
            "  let body = '';" +
            "  req.on('data', (c) => { body += c; });" +
            "  req.on('end', () => res.end('echo:' + body));" +
            "});" +
            "server.listen(6001, () => console.log('ready'));",
        ]);
        const reader = server.stdout.getReader();
        const first = await reader.read();
        if (new TextDecoder().decode(first.value) !== "ready\n") throw new Error("server did not become ready");

        const response = await fetch(wc.preview.url(6001), { method: "POST", body: "payload" });
        const text = await response.text();
        server.kill();
        await server.exit;
        return text;
      });
      expect(r).toBe("echo:payload");
    });

    test("a port nobody is listening on comes back as a 502, not a hang", async ({ page }) => {
      const status = await page.evaluate(async () => {
        const wc = (window as unknown as WcWindow).wc;
        await wc.preview.enable();
        const response = await fetch(wc.preview.url(6002));
        return response.status;
      });
      expect(status).toBe(502);
    });
  });
});

test.describe("preview UI", () => {
  // The playground's own #preview pane (src/preview.ts): wires wc.preview.onListen() to an
  // iframe with no polling or manual refresh - real coverage needs the actual iframe navigation
  // and Service Worker relay this describe's tests exercise, not just the onListen() event
  // plumbing itself (unit-tested in packages/core/src/preview.test.ts and kernel/netServer.test.ts).
  test("enabling preview, then a real server listening, points the iframe at it and loads its content", async ({ page }) => {
    await page.click("#preview-enable");
    await expect(page.locator("#preview-status")).toHaveText(/Waiting for a script to listen/);

    await page.evaluate(async () => {
      const wc = (window as unknown as WcWindow).wc;
      const server = await wc.spawn("node", [
        "-e",
        "const http = require('http');" +
          "http.createServer((req, res) => res.end('preview ui works')).listen(6100, () => console.log('ready'));",
      ]);
      (window as unknown as { __server: typeof server }).__server = server;
      const reader = server.stdout.getReader();
      const first = await reader.read();
      if (new TextDecoder().decode(first.value) !== "ready\n") throw new Error("server did not become ready");
    });

    await expect(page.locator("#preview-frame")).toHaveAttribute("src", "/__wcvm_preview__/6100/");
    await expect(page.locator("#preview-status")).toHaveText("Previewing virtual port 6100.");
    await expect(page.frameLocator("#preview-frame").locator("body")).toHaveText("preview ui works");

    await page.evaluate(async () => {
      const server = (window as unknown as { __server: { kill: () => void; exit: Promise<unknown> } }).__server;
      server.kill();
      await server.exit;
    });

    await expect(page.locator("#preview-status")).toHaveText(/Waiting for a script to listen/);
  });

  // A previewed page's own `new WebSocket("ws://" + location.host + ...)` - exactly what Vite's
  // HMR client does - tunnelled to the guest server's real 'upgrade' handler: the Service Worker
  // injects the shim (workers/preview/webSocketShim.ts) into the iframe's document, the shim hands
  // the host page a MessagePort (apis/Preview.ts), and the kernel is the real RFC 6455 client over
  // a virtual TCP connection (kernel/previewWebSocket.ts). The server here is hand-rolled on
  // purpose (no npm to install `ws` with) - the real handshake, masking and close handshake are
  // the point, and a real `ws` would speak exactly the same bytes.
  const WS_SERVER = `
    const http = require('http');
    const crypto = require('crypto');
    const PAGE = [
      '<!doctype html><html><head><meta charset="utf-8"><title>ws</title></head><body><pre id="log"></pre><script>',
      'const log = (s) => { document.getElementById("log").textContent += s + "\\\\n"; };',
      'const ws = new WebSocket("ws://" + location.host + "/echo?x=1", ["echo-v1"]);',
      'ws.binaryType = "arraybuffer";',
      'let seen = 0;',
      'ws.onopen = () => { log("open " + ws.protocol); ws.send("hi from page"); ws.send(new Uint8Array([1, 2, 3])); };',
      'ws.onmessage = (e) => { log("message " + (typeof e.data === "string" ? e.data : new Uint8Array(e.data).join(","))); if (++seen === 3) ws.close(1000, "done"); };',
      'ws.onerror = () => log("error");',
      'ws.onclose = (e) => log("close " + e.code + " " + e.reason + " " + e.wasClean);',
      '</script></body></html>',
    ].join('');
    const frame = (opcode, payload) => {
      const header = payload.length < 126 ? [0x80 | opcode, payload.length] : [0x80 | opcode, 126, payload.length >> 8, payload.length & 255];
      return Buffer.concat([Buffer.from(header), payload]);
    };
    const server = http.createServer((req, res) => {
      res.setHeader('Content-Type', 'text/html; charset=utf-8');
      res.end(PAGE);
    });
    server.on('upgrade', (req, socket) => {
      console.log('upgrade ' + req.url + ' ' + req.headers['sec-websocket-protocol']);
      const accept = crypto.createHash('sha1').update(req.headers['sec-websocket-key'] + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11').digest('base64');
      socket.write('HTTP/1.1 101 Switching Protocols\\r\\nUpgrade: websocket\\r\\nConnection: Upgrade\\r\\nSec-WebSocket-Accept: ' + accept + '\\r\\nSec-WebSocket-Protocol: echo-v1\\r\\n\\r\\n');
      socket.write(frame(1, Buffer.from('welcome')));
      let buffered = Buffer.alloc(0);
      socket.on('data', (chunk) => {
        if (process.argv[3] === 'hold') return; // never answer: the page's socket stays open
        buffered = Buffer.concat([buffered, chunk]);
        while (buffered.length >= 2) {
          const opcode = buffered[0] & 15;
          let length = buffered[1] & 127;
          let offset = 2;
          if (length === 126) { length = buffered.readUInt16BE(2); offset = 4; }
          if (buffered.length < offset + 4 + length) return;
          const mask = buffered.subarray(offset, offset + 4);
          const payload = Buffer.from(buffered.subarray(offset + 4, offset + 4 + length).map((b, i) => b ^ mask[i & 3]));
          buffered = buffered.subarray(offset + 4 + length);
          if (opcode === 1) socket.write(frame(1, Buffer.from('echo:' + payload.toString())));
          else if (opcode === 2) socket.write(frame(2, payload));
          else if (opcode === 8) {
            console.log('client closed ' + payload.readUInt16BE(0) + ' ' + payload.subarray(2).toString());
            socket.end(frame(8, payload));
          }
        }
      });
    });
    server.listen(Number(process.argv[2]), () => console.log('ready'));
  `;

  const startWsServer = (page: import("@playwright/test").Page, port: number, mode = "echo") =>
    page.evaluate(
      async ({ source, port, mode }) => {
        const wc = (window as unknown as WcWindow).wc;
        await wc.fs.writeFile("/ws-server.js", source);
        const server = await wc.spawn("node", ["/ws-server.js", String(port), mode]);
        const w = window as unknown as { __server: typeof server; __serverOut: string[] };
        w.__server = server;
        w.__serverOut = [];
        const reader = server.stdout.getReader();
        const first = await reader.read();
        if (new TextDecoder().decode(first.value) !== "ready\n") throw new Error("server did not become ready");
        void (async () => {
          for (;;) {
            const { value, done } = await reader.read();
            if (done) return;
            w.__serverOut.push(new TextDecoder().decode(value));
          }
        })();
      },
      { source: WS_SERVER, port, mode },
    );

  const serverOutput = (page: import("@playwright/test").Page) =>
    page.evaluate(() => (window as unknown as { __serverOut: string[] }).__serverOut.join(""));

  test("a previewed page's WebSocket reaches the guest server's real 'upgrade' handler, both ways", async ({ page }) => {
    await page.click("#preview-enable");
    await expect(page.locator("#preview-status")).toHaveText(/Waiting for a script to listen/);
    await startWsServer(page, 6200);

    await expect(page.locator("#preview-frame")).toHaveAttribute("src", "/__wcvm_preview__/6200/");
    await expect(page.frameLocator("#preview-frame").locator("#log")).toHaveText(
      ["open echo-v1", "message welcome", "message echo:hi from page", "message 1,2,3", "close 1000 done true", ""].join("\n"),
    );
    expect(await serverOutput(page)).toBe("upgrade /echo?x=1 echo-v1\nclient closed 1000 done\n");
  });

  test("the guest server dying drops the page's WebSocket with an unclean close", async ({ page }) => {
    // Its own iframe, not the playground's #preview-frame: that pane (rightly) resets to
    // about:blank the moment the server stops listening, taking the page under test with it.
    await page.evaluate(() => (window as unknown as WcWindow).wc.preview.enable());
    await startWsServer(page, 6201, "hold");
    await page.evaluate(() => {
      const frame = document.createElement("iframe");
      frame.id = "ws-frame";
      frame.src = (window as unknown as WcWindow).wc.preview.url(6201);
      document.body.append(frame);
    });
    const log = page.frameLocator("#ws-frame").locator("#log");
    await expect(log).toHaveText("open echo-v1\nmessage welcome\n");
    await page.evaluate(() => (window as unknown as { __server: { kill: () => void } }).__server.kill());
    await expect(log).toHaveText("open echo-v1\nmessage welcome\nerror\nclose 1006  false\n");
  });
});

test.describe("preview absolute paths", () => {
  // A previewed page's ABSOLUTE URLs - `<script src="/app.js">`, `fetch("/api/data")`, a link to
  // "/second" - resolve against the host page's origin root, not the /__wcvm_preview__/<port>/
  // prefix; the preview SW (workers/preview/previewRouting.ts) redirects each into the right
  // port's prefix, based on which client (or, for a navigation, which referrer) asked. Every Vite
  // module URL is absolute, so this is what a real dev server's page needs to load at all.
  const SERVER = `
    const http = require('http');
    const files = {
      '/': ['text/html', '<!doctype html><html><head><meta charset="utf-8"><script type="module" src="/app.js"></script></head><body><pre id="out"></pre><a id="next" href="/second?from=link">next</a></body></html>'],
      '/app.js': ['text/javascript', 'import { dep } from "./dep.js"; import { abs } from "/nested/abs.js"; const data = await (await fetch("/api/data", { method: "POST", body: "ping" })).json(); document.getElementById("out").textContent = [dep, abs, data.echo, new URL(import.meta.url).pathname].join(" | ");'],
      '/dep.js': ['text/javascript', 'export const dep = "relative import";'],
      '/nested/abs.js': ['text/javascript', 'export const abs = "absolute import";'],
      '/second': ['text/html', '<!doctype html><p id="second">second page</p>'],
    };
    http.createServer((req, res) => {
      const path = req.url.split('?')[0];
      console.log(req.method + ' ' + req.url);
      if (path === '/api/data') {
        let body = '';
        req.on('data', (c) => (body += c));
        req.on('end', () => { res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify({ echo: 'api got ' + body })); });
        return;
      }
      const file = files[path];
      if (!file) { res.statusCode = 404; res.end('no ' + path); return; }
      res.setHeader('Content-Type', file[0]);
      res.end(file[1]);
    }).listen(6300, () => console.log('ready'));
  `;

  const openPreviewFrame = (page: import("@playwright/test").Page) =>
    page.evaluate(async (source) => {
      const wc = (window as unknown as WcWindow).wc;
      await wc.preview.enable();
      await wc.fs.writeFile("/abs-server.js", source);
      const server = await wc.spawn("node", ["/abs-server.js"]);
      const w = window as unknown as { __serverOut: string[] };
      w.__serverOut = [];
      const reader = server.stdout.getReader();
      void (async () => {
        for (;;) {
          const { value, done } = await reader.read();
          if (done) return;
          w.__serverOut.push(new TextDecoder().decode(value));
        }
      })();
      while (!w.__serverOut.join("").includes("ready")) await new Promise((r) => setTimeout(r, 10));
      const frame = document.createElement("iframe");
      frame.id = "abs-frame";
      frame.src = wc.preview.url(6300);
      document.body.append(frame);
    }, SERVER);

  test("a previewed page's absolute-path modules, fetches and links all reach its own guest server", async ({ page }) => {
    await openPreviewFrame(page);
    const frame = page.frameLocator("#abs-frame");
    await expect(frame.locator("#out")).toHaveText("relative import | absolute import | api got ping | /__wcvm_preview__/6300/app.js");

    await frame.locator("#next").click();
    await expect(frame.locator("#second")).toHaveText("second page");
    const frameUrl = await page.evaluate(() => (document.getElementById("abs-frame") as HTMLIFrameElement).contentWindow!.location.href);
    expect(new URL(frameUrl).pathname + new URL(frameUrl).search).toBe("/__wcvm_preview__/6300/second?from=link");

    // Unique paths: the playground's own #preview-frame also loads any port that starts listening.
    const log = await page.evaluate(() => (window as unknown as { __serverOut: string[] }).__serverOut.join(""));
    expect([...new Set(log.split("\n").filter((line) => line && line !== "ready"))].sort()).toEqual(
      ["GET /", "GET /app.js", "GET /dep.js", "GET /nested/abs.js", "GET /second?from=link", "POST /api/data"].sort(),
    );
  });

  test("still routed after the browser stops the idle Service Worker and forgets which client is which", async ({ page }) => {
    await openPreviewFrame(page);
    await expect(page.frameLocator("#abs-frame").locator("#out")).toContainText("api got ping");
    // What a real browser does to an idle Service Worker after ~30s: its in-memory client->port
    // map is gone, so the frame's next absolute request takes the async clients.get() path.
    const cdp = await page.context().newCDPSession(page);
    await cdp.send("ServiceWorker.enable");
    await cdp.send("ServiceWorker.stopAllWorkers");
    const inner = await (await page.$("#abs-frame"))!.contentFrame();
    const result = await inner!.evaluate(async () => {
      const response = await fetch("/api/data", { method: "POST", body: "after restart" });
      return { json: await response.json(), url: new URL(response.url).pathname };
    });
    expect(result).toEqual({ json: { echo: "api got after restart" }, url: "/__wcvm_preview__/6300/api/data" });
  });
});

test.describe("npm install", () => {
  // wcvm's minimal npm (packages/core/src/programs/npm/): a real CORS fetch() from a Process Worker
  // to a registry on another origin (e2e/fixtureRegistry.ts, the same cross-origin shape as
  // registry.npmjs.org), real sha512 integrity checks via SubtleCrypto, real gunzip via the
  // browser's DecompressionStream, then the installed tree used for real by `node`.
  const REGISTRY = "http://localhost:5184/";

  test("installs from a cross-origin registry, and node can require, import and run what it installed", async ({ page }) => {
    await page.evaluate(async () => {
      const { fs } = (window as unknown as WcWindow).wc;
      await fs.mkdir("/app", { recursive: true });
      await fs.writeFile("/app/package.json", JSON.stringify({ name: "app", dependencies: { "colors-lite": "^1.0.0", "esm-only": "^1.0.0" } }));
    });

    const install = await spawn(page, "npm", ["install", "greet", "--registry", REGISTRY], "/app");
    expect(install).toEqual({ code: 0, out: expect.stringMatching(/^\nadded 5 packages in \d+m?s\n$/), err: "" });

    const used = await spawn(page, "node", ["-e", `
      console.log(require("greet")("world"));
      console.log(require("colors-lite").tag);
      import("esm-only").then((m) => console.log("esm", m.answer));
    `], "/app");
    // greet's own ^2 of colors-lite is nested under it; the app's ^1 stays at the top.
    expect(used).toEqual({ code: 0, out: "[hello world] colors@2\ncolors@1\nesm 42\n", err: "" });

    const bin = await spawn(page, "node", ["node_modules/.bin/greet", "bin"], "/app");
    expect(bin).toEqual({ code: 0, out: "[hello bin] colors@2\n", err: "" });

    const layout = await page.evaluate(async () => {
      const { fs } = (window as unknown as WcWindow).wc;
      const read = async (path: string) => new TextDecoder().decode(await fs.readFile(path));
      return {
        pkg: JSON.parse(await read("/app/package.json")),
        top: (await fs.readdir("/app/node_modules")).sort(),
        nested: JSON.parse(await read("/app/node_modules/greet/node_modules/colors-lite/package.json")).version,
      };
    });
    expect(layout).toEqual({
      pkg: { name: "app", dependencies: { "colors-lite": "^1.0.0", "esm-only": "^1.0.0", greet: "^1.2.0" } },
      // No @demo/native-linux-x64: an optional native build, which nothing here could run.
      top: [".bin", "@demo", "colors-lite", "esm-only", "greet"],
      nested: "2.0.0",
    });

    const again = await spawn(page, "npm", ["install", "--registry", REGISTRY], "/app");
    expect(again).toEqual({ code: 0, out: expect.stringMatching(/^\nup to date in \d+m?s\n$/), err: "" });
  });

  test("a registry that has no such package fails the install with npm's own error code", async ({ page }) => {
    await page.evaluate(() => (window as unknown as WcWindow).wc.fs.mkdir("/empty", { recursive: true }));
    const r = await spawn(page, "npm", ["install", "no-such-package", "--registry", REGISTRY], "/empty");
    expect(r.code).toBe(1);
    expect(r.err).toMatch(/^npm error code E404\n/);
  });
});

test.describe("Vite dev server", () => {
  // An unmodified Vite 7 inside wcvm, the whole way: installed by wcvm's own `npm install` from the
  // REAL npm registry, esbuild and Rollup swapped for their wasm builds via `overrides`, started
  // with Vite's real CLI, shown in the playground's own preview pane, TypeScript transformed and an
  // npm dependency pre-bundled by esbuild-wasm, and hot updates arriving over the preview WebSocket
  // tunnel - CSS and a self-accepting module both applied WITHOUT a reload.
  //
  // OPT-IN (needs the internet, ~5 MB of packages): `WCVM_E2E_VITE=1 pnpm exec playwright test -g
  // "Vite dev server"`. Behind a proxy, HTTPS_PROXY is passed on to Chromium (playwright.config.ts).
  // Every building block it relies on has its own small, offline test; this one proves they add up
  // to real Vite.
  test.skip(!process.env.WCVM_E2E_VITE, "opt-in: set WCVM_E2E_VITE=1 (installs real Vite from registry.npmjs.org)");
  const REGISTRY = "https://registry.npmjs.org/";
  const APP = {
    "/app/package.json": JSON.stringify({
      name: "vite-app",
      private: true,
      type: "module",
      dependencies: { mitt: "3.0.1" },
      devDependencies: { vite: "7.3.6" },
      overrides: { esbuild: "npm:esbuild-wasm@0.28.2", rollup: "npm:@rollup/wasm-node@4.63.4" },
    }),
    "/app/index.html": '<!doctype html><html><head><title>vite app</title><script type="module" src="/src/main.ts"></script></head><body><h1 id="t">loading</h1></body></html>',
    "/app/src/main.ts": [
      "import './style.css';",
      "import mitt from 'mitt';",
      "import { label } from './label';",
      "(window as any).__boot ??= Math.random();",
      "const bus = mitt<{ show: string }>();",
      "bus.on('show', (text: string) => { document.getElementById('t')!.textContent = text; });",
      "bus.emit('show', 'label ' + label);",
    ].join("\n"),
    "/app/src/label.ts": "export const label: string = 'v1';\nif (import.meta.hot) import.meta.hot.accept((m) => { document.getElementById('t')!.textContent = 'label ' + m!.label; });\n",
    "/app/src/style.css": "h1 { color: rgb(255, 0, 0); }\n",
  };

  test("runs Vite from npm install to hot module replacement, entirely in the tab", async ({ page }) => {
    test.setTimeout(180_000); // a real ~5 MB install over the network
    await page.click("#preview-enable");
    await expect(page.locator("#preview-status")).toHaveText(/Waiting for a script to listen/);
    await page.evaluate(async (files) => {
      const { fs } = (window as unknown as WcWindow).wc;
      for (const [path, contents] of Object.entries(files)) {
        await fs.mkdir(path.slice(0, path.lastIndexOf("/")), { recursive: true });
        await fs.writeFile(path, contents);
      }
    }, APP);

    const install = await spawn(page, "npm", ["install", "--registry", REGISTRY], "/app");
    expect(install).toEqual({ code: 0, out: expect.stringMatching(/^\nadded \d+ packages in \d+m?s\n$/), err: "" });

    await page.evaluate(async () => {
      const wc = (window as unknown as WcWindow).wc;
      const vite = await wc.spawn("node", ["node_modules/vite/bin/vite.js", "--port", "5173", "--strictPort"], { cwd: "/app" });
      const w = window as unknown as { __vite: typeof vite; __viteOut: string };
      w.__vite = vite;
      w.__viteOut = "";
      for (const stream of [vite.stdout, vite.stderr]) {
        void (async () => {
          const reader = stream.getReader();
          for (;;) {
            const { value, done } = await reader.read();
            if (done) return;
            w.__viteOut += new TextDecoder().decode(value);
          }
        })();
      }
    });
    const viteOutput = () => page.evaluate(() => (window as unknown as { __viteOut: string }).__viteOut);
    await expect.poll(viteOutput, { timeout: 30_000 }).toContain("Local:");

    await expect(page.locator("#preview-frame")).toHaveAttribute("src", "/__wcvm_preview__/5173/");
    const heading = page.frameLocator("#preview-frame").locator("#t");
    await expect(heading).toHaveText("label v1", { timeout: 30_000 });
    const state = () =>
      heading.evaluate((el) => ({ color: getComputedStyle(el).color, boot: (el.ownerDocument.defaultView as unknown as { __boot: number }).__boot }));
    const initial = await state();
    expect(initial.color).toBe("rgb(255, 0, 0)");

    // esbuild-wasm did real work: types stripped, the npm dependency pre-bundled.
    const served = await page.evaluate(async () => (await fetch("/__wcvm_preview__/5173/src/main.ts")).text());
    expect(served).not.toContain(": string");
    expect(served).toMatch(/from "\/node_modules\/\.vite\/deps\/mitt\.js\?v=/);

    await page.evaluate(() => (window as unknown as WcWindow).wc.fs.writeFile("/app/src/style.css", "h1 { color: rgb(0, 0, 255); }\n"));
    await expect.poll(async () => (await state()).color, { timeout: 15_000 }).toBe("rgb(0, 0, 255)");
    expect((await state()).boot).toBe(initial.boot); // hot-updated, not reloaded

    await page.evaluate(() =>
      (window as unknown as WcWindow).wc.fs.writeFile(
        "/app/src/label.ts",
        "export const label: string = 'v2';\nif (import.meta.hot) import.meta.hot.accept((m) => { document.getElementById('t')!.textContent = 'label ' + m!.label; });\n",
      ),
    );
    await expect(heading).toHaveText("label v2", { timeout: 15_000 });
    expect((await state()).boot).toBe(initial.boot);
    expect(await viteOutput()).toMatch(/hmr update \/src\/style\.css[\s\S]*hmr update \/src\/label\.ts/);

    await page.evaluate(async () => {
      const vite = (window as unknown as { __vite: { kill: () => void; exit: Promise<unknown> } }).__vite;
      vite.kill();
      await vite.exit;
    });
    await expect(page.locator("#preview-status")).toHaveText(/Waiting for a script to listen/);
  });
});

test.describe("fetcher", () => {
  // wc.fs.fetch() (apis/Fs.ts -> kernel/fetcher.ts -> a real, dedicated Fetcher Worker,
  // workers/fetcher/worker.ts) does a REAL fetch() and streams the response into the VFS over
  // its own fs client - a real SharedArrayBuffer/MessageChannel pair registered with the FS
  // Worker, exactly like a process worker's own (see kernel/index.ts's attachFsClient). None of
  // that (a real fetch() from inside a dedicated Worker, a real cross-worker SAB write) can be
  // exercised outside real Chromium - only unit-tested with a fake fetchImpl
  // (packages/core/src/workers/fetcher/fetcherRuntime.test.ts).
  test("downloads a real same-origin asset straight into the VFS, matching a plain fetch() of it", async ({ page }) => {
    const result = await page.evaluate(async () => {
      const wc = (window as unknown as WcWindow).wc;
      const outcome = await wc.fs.fetch("/index.html", "/downloaded.html");
      const written = new TextDecoder().decode(await wc.fs.readFile("/downloaded.html"));
      const real = await fetch("/index.html").then((r) => r.text());
      return {
        status: outcome.status,
        matches: written === real,
        hasContentType: outcome.headers.some(([name]) => name.toLowerCase() === "content-type"),
      };
    });
    expect(result).toEqual({ status: 200, matches: true, hasContentType: true });
  });

  test("a real connection failure rejects and never writes the destination file", async ({ page }) => {
    const result = await page.evaluate(async () => {
      const wc = (window as unknown as WcWindow).wc;
      try {
        // Port 1 is privileged/reserved - nothing listens there, so this is a real, fast
        // connection refusal, not a hypothetical.
        await wc.fs.fetch("http://localhost:1/", "/never.txt");
        return { threw: false };
      } catch {
        return { threw: true, exists: await wc.fs.exists("/never.txt") };
      }
    });
    expect(result).toEqual({ threw: true, exists: false });
  });
});

test.describe("OPFS persistence", () => {
  // wc.fs.* mirrored to the real Origin Private File System, write-behind, and restored before a
  // fresh boot's first syscall - none of that (a real navigator.storage.getDirectory(), a real
  // page reload reading back what a PREVIOUS page load wrote) can be exercised outside real
  // Chromium; unit-tested against a fake OPFS handle in
  // packages/core/src/fs/opfsPersistence.test.ts. Each test picks its own unique root name so
  // leftover OPFS state from a previous full suite run on this machine can never collide with it.
  test("a file written with persist enabled survives a real page reload", async ({ page }) => {
    const root = `e2e-persist-${Date.now()}-${Math.random().toString(36).slice(2)}`;

    await page.evaluate(async (persistRoot) => {
      const wc = (window as unknown as WcWindow).wcvmBoot({ persist: { root: persistRoot } });
      await wc.ready;
      await wc.fs.mkdir("/proj", { recursive: true });
      await wc.fs.writeFile("/proj/a.txt", "hello from before the reload");
      // Write-behind: the syscall above already answered before its OPFS mirror finished -
      // give it a moment to actually land before reloading.
      await new Promise((resolve) => setTimeout(resolve, 300));
    }, root);

    await page.reload();
    await expect(page.locator("#app")).toHaveText("wcvm ready", { timeout: 15000 });

    const result = await page.evaluate(async (persistRoot) => {
      const wc = (window as unknown as WcWindow).wcvmBoot({ persist: { root: persistRoot } });
      await wc.ready;
      return new TextDecoder().decode(await wc.fs.readFile("/proj/a.txt"));
    }, root);

    expect(result).toBe("hello from before the reload");
  });

  test("a file removed before reload does not come back", async ({ page }) => {
    const root = `e2e-persist-${Date.now()}-${Math.random().toString(36).slice(2)}`;

    await page.evaluate(async (persistRoot) => {
      const wc = (window as unknown as WcWindow).wcvmBoot({ persist: { root: persistRoot } });
      await wc.ready;
      await wc.fs.writeFile("/keep.txt", "still here");
      await wc.fs.writeFile("/gone.txt", "not for long");
      await new Promise((resolve) => setTimeout(resolve, 300));
      await wc.fs.rm("/gone.txt");
      await new Promise((resolve) => setTimeout(resolve, 300));
    }, root);

    await page.reload();
    await expect(page.locator("#app")).toHaveText("wcvm ready", { timeout: 15000 });

    const result = await page.evaluate(async (persistRoot) => {
      const wc = (window as unknown as WcWindow).wcvmBoot({ persist: { root: persistRoot } });
      await wc.ready;
      return { keep: await wc.fs.exists("/keep.txt"), gone: await wc.fs.exists("/gone.txt") };
    }, root);

    expect(result).toEqual({ keep: true, gone: false });
  });
});

test.describe("example: Vite + React + TypeScript", () => {
  // The playground's own #example section (src/reactExample.ts): a real react-ts project, installed
  // from npm by wcvm's own `npm install`, served by Vite's real CLI into the preview pane, with an
  // App.tsx editor whose edits hot-update the running app.
  test("the example section is the React + TS app, with App.tsx ready to edit", async ({ page }) => {
    await expect(page.locator("#example-label")).toContainText("Vite + React + TypeScript");
    await expect(page.locator("#example-run")).toHaveText("run React example");
    await expect(page.locator("#example-editor")).toHaveValue(/useState\(0\)[\s\S]*count is \{count\}/);
    await expect(page.locator("#example-status")).toHaveText("Not running.");
  });

  // OPT-IN, like the "Vite dev server" test: it installs React and Vite from the real registry.
  test("runs it end to end: install, Vite, the app in the preview, and an edit hot-reloading with state kept", async ({ page }) => {
    test.skip(!process.env.WCVM_E2E_VITE, "opt-in: set WCVM_E2E_VITE=1 (installs React + Vite from registry.npmjs.org)");
    test.setTimeout(240_000);
    await page.click("#example-run");
    await expect(page.locator("#example-status")).toHaveText(/Vite is running on virtual port 5173/, { timeout: 180_000 });
    await expect(page.locator("#preview-frame")).toHaveAttribute("src", "/__wcvm_preview__/5173/");

    const frame = page.frameLocator("#preview-frame");
    const count = frame.locator("#count");
    await expect(count).toHaveText("count is 0", { timeout: 60_000 });
    await count.click();
    await count.click();
    await expect(count).toHaveText("count is 2");

    // Typing in the editor writes src/App.tsx; Vite hot-updates the component - React Fast
    // Refresh keeps its state, so the count is still 2 under the new heading.
    const edited = (await page.locator("#example-editor").inputValue()).replace("<h1>Vite + React + TypeScript</h1>", "<h1>Edited live</h1>");
    await page.locator("#example-editor").fill(edited);
    await expect(frame.locator("h1")).toHaveText("Edited live", { timeout: 30_000 });
    await expect(count).toHaveText("count is 2");

    await page.click("#example-run"); // now "stop React example"
    await expect(page.locator("#example-status")).toHaveText("Stopped.");
  });
});

test.describe("zlib", () => {
  test("a streaming gzip/gunzip round trip via createGzip/createGunzip", async ({ page }) => {
    const r = await spawn(page, "node", ["-e", `
      const zlib = require("zlib");
      const chunks = [];
      const gz = zlib.createGzip();
      const gunz = zlib.createGunzip();
      gz.pipe(gunz);
      gunz.on("data", (c) => chunks.push(c));
      gunz.on("end", () => console.log(Buffer.concat(chunks).toString()));
      gz.end("hello from a real browser CompressionStream");
    `]);
    expect(r).toEqual({ code: 0, out: "hello from a real browser CompressionStream\n", err: "" });
  });

  test("gzipSync/gunzipSync round trip through the real kernel-mediated blocking path", async ({ page }) => {
    const r = await spawn(page, "node", ["-e", `
      const zlib = require("zlib");
      const compressed = zlib.gzipSync(Buffer.from("sync via the kernel"));
      console.log(zlib.gunzipSync(compressed).toString());
    `]);
    expect(r).toEqual({ code: 0, out: "sync via the kernel\n", err: "" });
  });
});

test.describe("worker_threads", () => {
  const writeFiles = (page: import("@playwright/test").Page, files: Record<string, string>) =>
    page.evaluate(async (files) => {
      const { fs } = (window as unknown as WcWindow).wc;
      for (const [path, contents] of Object.entries(files)) {
        await fs.mkdir(path.slice(0, path.lastIndexOf("/")) || "/", { recursive: true });
        await fs.writeFile(path, contents);
      }
    }, files);

  test("a real, separate Process Worker exchanges messages with its parent over a real MessageChannel", async ({ page }) => {
    const r = await spawn(page, "node", ["-e", `
      const { Worker, isMainThread } = require('worker_threads');
      console.log('isMainThread', isMainThread);
      const w = new Worker("require('worker_threads').parentPort.postMessage('pong');", { eval: true });
      w.on('online', () => console.log('online'));
      w.on('message', (msg) => { console.log('got', msg); process.exit(0); });
      w.on('error', (e) => { console.log('error', e.message); process.exit(1); });
    `]);
    expect(r).toEqual({ code: 0, out: "isMainThread true\nonline\ngot pong\n", err: "" });
  });

  test("workerData round-trips from the parent to the child", async ({ page }) => {
    const r = await spawn(page, "node", ["-e", `
      const { Worker } = require('worker_threads');
      const w = new Worker(
        "const { parentPort, workerData } = require('worker_threads'); parentPort.postMessage(workerData.n * 2);",
        { eval: true, workerData: { n: 21 } },
      );
      w.on('message', (msg) => { console.log('doubled', msg); process.exit(0); });
      w.on('error', (e) => { console.log('error', e.message); process.exit(1); });
    `]);
    expect(r).toEqual({ code: 0, out: "doubled 42\n", err: "" });
  });

  test("new Worker(file) resolves and runs a real script from the VFS", async ({ page }) => {
    await writeFiles(page, {
      "/proj/worker.js": `
        const { parentPort } = require('worker_threads');
        parentPort.postMessage('hello from a file');
      `,
    });
    const r = await spawn(page, "node", ["-e", `
      const { Worker } = require('worker_threads');
      const w = new Worker('/proj/worker.js');
      w.on('message', (msg) => { console.log(msg); process.exit(0); });
      w.on('error', (e) => { console.log('error', e.message); process.exit(1); });
    `]);
    expect(r).toEqual({ code: 0, out: "hello from a file\n", err: "" });
  });

  test("w.terminate() stops a still-running worker and its own promise resolves once it has", async ({ page }) => {
    const r = await spawn(page, "node", ["-e", `
      const { Worker } = require('worker_threads');
      const w = new Worker("setInterval(() => {}, 1000);", { eval: true });
      w.on('online', async () => {
        const exitCode = await w.terminate();
        console.log('terminated', exitCode);
        process.exit(0);
      });
      w.on('error', (e) => { console.log('error', e.message); process.exit(1); });
    `]);
    expect(r.code).toBe(0);
    expect(r.out).toMatch(/^terminated \d+\n$/);
  });

  // Known difference from real Node: an uncaught exception inside a worker thread there
  // surfaces as an 'error' event on the parent (the native binding serializes it via
  // internal/error_serdes.js's serializeError() and posts an ERROR_MESSAGE). Here it surfaces as
  // an ordinary nonzero exit instead - internal/main/worker_thread.js's own uncaught-exception ->
  // ERROR_MESSAGE reporting isn't vendored (this project hand-writes the worker thread bootstrap
  // instead, see runWorkerThread.ts's own header comment), and wiring it up would need real
  // v8.serialize()/deserialize() - deliberately left unimplemented (runtime/shims.ts's v8Shim),
  // the same scope decision fork()'s own "advanced" IPC serialization mode already made.
  test("an uncaught exception inside the worker ends it with exit code 1, not a hang", async ({ page }) => {
    const r = await spawn(page, "node", ["-e", `
      const { Worker } = require('worker_threads');
      const w = new Worker("throw new Error('boom');", { eval: true });
      w.on('error', (e) => { console.log('error', e.message); process.exit(2); });
      w.on('exit', (code) => { console.log('exit', code); process.exit(0); });
    `]);
    // Matches real Node's own default (options.stderr: false pipes the worker's stderr straight
    // to the parent's own) - the worker's own uncaught-exception report lands on the TOP-LEVEL
    // process's stderr here too, via workers/process/worker.ts's own child:stderr routing.
    expect(r.code).toBe(0);
    expect(r.out).toBe("exit 1\n");
    expect(r.err).toContain("Error: boom");
  });

  test("a worker thread can itself spawn a nested worker thread", async ({ page }) => {
    await writeFiles(page, {
      "/proj/inner.js": `
        require('worker_threads').parentPort.postMessage('from inner');
      `,
      "/proj/outer.js": `
        const { Worker, parentPort } = require('worker_threads');
        const inner = new Worker('/proj/inner.js');
        inner.on('message', (msg) => parentPort.postMessage(msg));
      `,
    });
    const r = await spawn(page, "node", ["-e", `
      const { Worker } = require('worker_threads');
      const w = new Worker('/proj/outer.js');
      w.on('message', (msg) => { console.log('outer got', msg); process.exit(0); });
      w.on('error', (e) => { console.log('error', e.message); process.exit(1); });
    `]);
    expect(r).toEqual({ code: 0, out: "outer got from inner\n", err: "" });
  });
});

test.describe("crypto", () => {
  test("createHash().update().digest() blocks through the real kernel-mediated SubtleCrypto.digest() path", async ({ page }) => {
    const r = await spawn(page, "node", ["-e", `
      const crypto = require("crypto");
      console.log(crypto.createHash("sha512").update("hello from a real browser SubtleCrypto").digest("hex"));
    `]);
    expect(r.code).toBe(0);
    expect(r.err).toBe("");
    // Cross-checked against Node's own crypto.createHash('sha512') for the same input - proves
    // the real browser SubtleCrypto.digest() round trip, not just that some bytes came back.
    expect(r.out).toBe(
      nodeCrypto.createHash("sha512").update("hello from a real browser SubtleCrypto").digest("hex") + "\n",
    );
  });

  test("randomBytes/randomUUID are real, distinct values from the real browser Web Crypto API", async ({ page }) => {
    const r = await spawn(page, "node", ["-e", `
      const crypto = require("crypto");
      const a = crypto.randomBytes(16);
      const b = crypto.randomBytes(16);
      console.log(a.length, b.length, a.equals(b), crypto.randomUUID() !== crypto.randomUUID());
    `]);
    expect(r).toEqual({ code: 0, out: "16 16 false true\n", err: "" });
  });
});

test.describe("sh", () => {
  test("sequences, short-circuits, and pipes across real built-in programs", async ({ page }) => {
    const r = await spawn(page, "sh", ["-c", "false && echo skipped; echo one | cat; true && echo two"]);
    expect(r).toEqual({ code: 0, out: "one\ntwo\n", err: "" });
  });

  test("> and >> redirect to real files on the VFS, visible to the host", async ({ page }) => {
    const out = await page.evaluate(async () => {
      const wc = (window as unknown as WcWindow).wc;
      const proc = await wc.spawn("sh", ["-c", "echo one > /log.txt; echo two >> /log.txt"]);
      await proc.exit;
      return new TextDecoder().decode(await wc.fs.readFile("/log.txt"));
    });
    expect(out).toBe("one\ntwo\n");
  });

  test("cd changes cwd for the rest of the script, across a real spawn", async ({ page }) => {
    await page.evaluate(async () => {
      const wc = (window as unknown as WcWindow).wc;
      await wc.fs.mount({ work: { directory: { "f.txt": { file: { contents: "x" } } } } });
    });
    const r = await spawn(page, "sh", ["-c", "cd /work && ls"]);
    expect(r).toEqual({ code: 0, out: "f.txt\n", err: "" });
  });

  test("runs node as an ordinary command inside a real shell script", async ({ page }) => {
    const r = await spawn(page, "sh", ["-c", "node -e \"console.log(1 + 1)\""]);
    expect(r).toEqual({ code: 0, out: "2\n", err: "" });
  });

  test("a script file runs via `sh <file>`, resolved against cwd", async ({ page }) => {
    await page.evaluate(async () => {
      const wc = (window as unknown as WcWindow).wc;
      await wc.fs.mount({ app: { directory: { "build.sh": { file: { contents: "echo building; echo done" } } } } });
    });
    const r = await spawn(page, "sh", ["build.sh"], "/app");
    expect(r).toEqual({ code: 0, out: "building\ndone\n", err: "" });
  });

  test("stdin is handed back to the sh REPL after a nested node REPL exits normally", async ({ page }) => {
    // Reproduces the originally-reported bug: node's own runtime registers its own handler on
    // the SAME IStdinHost sh's REPL is reading from, displacing it; without lineReader.ts's
    // reattach() (programs/sh/sh.ts's runReplSh), further typed input after `.exit` would go
    // nowhere - sh would look frozen even though the whole process's stdin is still open.
    //
    // Each line waits for the prompt/result it follows, like a person at a terminal - not a fixed
    // delay: a nested `node` can take far longer than any fixed delay to start on a loaded
    // machine, and then `.exit` and the next line arrive together and node (correctly, as real
    // node would with typed-ahead input) consumes both before its exit takes effect.
    const r = await page.evaluate(async () => {
      const wc = (window as unknown as WcWindow).wc;
      const proc = await wc.spawn("sh", []);
      const writer = proc.stdin.getWriter();
      const encoder = new TextEncoder();
      let out = "";
      const reading = (async () => {
        const reader = proc.stdout.getReader();
        for (;;) {
          const { value, done } = await reader.read();
          if (done) return;
          out += new TextDecoder().decode(value);
        }
      })();
      const waitFor = async (after: number, text: string) => {
        const deadline = Date.now() + 20_000;
        while (!out.slice(after).includes(text)) {
          if (Date.now() > deadline) throw new Error(`timed out waiting for ${JSON.stringify(text)} in ${JSON.stringify(out)}`);
          await new Promise((resolve) => setTimeout(resolve, 20));
        }
      };
      const send = async (line: string, thenWaitFor: string) => {
        const mark = out.length;
        await writer.write(encoder.encode(`${line}\n`));
        await waitFor(mark, thenWaitFor);
      };
      await waitFor(0, "$ ");
      await send("node", "> "); // starts a nested interactive node REPL, in the same process
      await send("1 + 1", "2\n"); // evaluated by node, not sh
      await send(".exit", "$ "); // node exits normally - does NOT end the whole process's stdin
      await send("echo still alive", "still alive\n"); // must reach sh's REPL, not a now-defunct handler
      await writer.close();
      const [err, exit] = await Promise.all([new Response(proc.stderr).text(), proc.exit, reading]);
      return { out, err, code: exit.exitCode };
    });
    expect(r.out).toContain("2\n");
    expect(r.out).toContain("still alive\n");
    expect(r.code).toBe(0);
  });
});

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

    // FIXED (was: threw ERR_CIRCULAR_ESM_NOT_SUPPORTED unconditionally - see runtime/esm/loader.ts
    // and runtime/esm/cyclic.ts's own doc comments for the full design and the two dead ends hit
    // on the way there). A genuine cycle now works via a shared, per-module registry object (live
    // GETTERS, not a one-time snapshot - the exact "partial exports" hazard a snapshot would have,
    // confirmed to actually break the real target case: zod v4's own core.js/util.js, reached
    // through @tanstack/router-plugin) - but reading a circular binding SYNCHRONOUSLY, at the
    // TOP LEVEL, right where the import used to be, still can't work (neither would real,
    // un-transformed circular ESM - that's a TDZ ReferenceError there too), so it throws a
    // clear, TDZ-shaped error instead of silently reading `undefined`.
    test("reading a circular binding synchronously at the top level still throws - a clear, TDZ-shaped error, not a silent wrong value", async ({ page }) => {
      await writeFiles(page, {
        "/a.mjs": "import { b } from './b.mjs';\nexport const a = 1;\nconsole.log('a', b);\n",
        "/b.mjs": "import { a } from './a.mjs';\nexport const b = 2;\nconsole.log('b', a);\n",
      });
      const r = await spawn(page, "node", ["/a.mjs"]);
      expect(r.code).toBe(1);
      expect(r.err).toMatch(/ReferenceError.*before initialization/);
    });

    test("a genuinely circular import actually works when used the real (lazy) way - not at the top level, and mutation across the cycle is visible", async ({ page }) => {
      await writeFiles(page, {
        // Same shape as zod v4's real core.js/util.js: each side reads the OTHER's export only
        // INSIDE a function, called later - never synchronously at the top level.
        "/core.mjs": [
          "import { installMembers } from './util.mjs';",
          "export const globalConfig = { count: 0 };",
          "export function setup() { installMembers(globalConfig); }",
        ].join("\n"),
        "/util.mjs": [
          "import { globalConfig } from './core.mjs';",
          "export function installMembers(obj) { obj.installed = true; }",
          "export function readCount() { return globalConfig.count; }",
        ].join("\n"),
        "/main.mjs": [
          "import { globalConfig, setup } from './core.mjs';",
          "import { readCount } from './util.mjs';",
          "setup();",
          "globalConfig.count = 5;",
          "console.log(globalConfig.installed, readCount());",
        ].join("\n"),
      });
      const r = await spawn(page, "node", ["/main.mjs"]);
      expect(r).toEqual({ code: 0, out: "true 5\n", err: "" });
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

test.describe("npm create", () => {
  // `npm create vite@latest` (real registry, needs the internet - opt-in like "Vite dev server"):
  // wcvm's npm mangles "vite" to "create-vite" (exec.ts's mangleCreateName, matching real npm's
  // own init.js), fetches JUST that one package (it has zero runtime dependencies of its own -
  // everything's bundled into its own dist/index.js) and runs its real, unmodified bin directly.
  // create-vite decides whether to prompt interactively from `process.stdin.isTTY` - always false
  // here (no raw-mode TTY in this sandbox), so it runs fully non-interactively off argv alone, the
  // same as a CI system with no real terminal. Then proves the scaffolded project is real by
  // installing and starting it, exactly like the hand-written React example does.
  test("scaffolds a real react-ts project non-interactively, and it installs and runs for real", async ({ page }) => {
    test.skip(!process.env.WCVM_E2E_VITE, "opt-in: set WCVM_E2E_VITE=1 (installs create-vite, then Vite/React, from registry.npmjs.org)");
    test.setTimeout(120_000);

    const created = await spawn(page, "npm", ["create", "vite@latest", "scaffolded", "--", "--template", "react-ts", "--no-interactive"], "/");
    expect(created.code).toBe(0);
    expect(created.out).toContain("Scaffolding project in");
    expect(created.out).toContain("Done. Now run:");

    const files = await page.evaluate(async () => {
      const { fs } = (window as unknown as WcWindow).wc;
      const pkg = JSON.parse(new TextDecoder().decode(await fs.readFile("/scaffolded/package.json")));
      return { pkg, top: (await fs.readdir("/scaffolded")).sort() };
    });
    expect(files.pkg).toMatchObject({ name: "scaffolded", dependencies: { react: expect.any(String), "react-dom": expect.any(String) } });
    expect(files.top).toEqual(expect.arrayContaining(["index.html", "package.json", "src", "vite.config.ts"]));

    // The scaffolded project is a real, unmodified react-ts template - but create-vite@latest's
    // CURRENT template scaffolds Vite 8, which defaults to Rolldown (a native/Wasm Rust bundler,
    // not Rollup+esbuild) - and PLAN.md already recorded that hitting an upstream Wasm trap in an
    // earlier investigation. Pin vite and @vitejs/plugin-react down to the exact versions the
    // hand-written React example already proved work (plugin-react@6.x, scaffolded by default,
    // expects newer export paths vite@7.3.6 doesn't have) - vite 7 still uses Rollup+esbuild, so
    // it still takes the same wasm-build overrides that example uses.
    await page.evaluate(async () => {
      const { fs } = (window as unknown as WcWindow).wc;
      const pkg = JSON.parse(new TextDecoder().decode(await fs.readFile("/scaffolded/package.json")));
      pkg.devDependencies.vite = "7.3.6";
      pkg.devDependencies["@vitejs/plugin-react"] = "^5.0.0";
      pkg.overrides = { esbuild: "npm:esbuild-wasm@0.28.2", rollup: "npm:@rollup/wasm-node@4.63.4" };
      await fs.writeFile("/scaffolded/package.json", JSON.stringify(pkg));
    });
    const install = await spawn(page, "npm", ["install"], "/scaffolded");
    expect(install.code).toBe(0);

    await page.evaluate(async () => {
      const wc = (window as unknown as WcWindow).wc;
      const vite = await wc.spawn("npm", ["run", "dev", "--", "--port", "5197", "--strictPort"], { cwd: "/scaffolded" });
      const w = window as unknown as { __create_vite: typeof vite; __create_viteOut: string };
      w.__create_vite = vite;
      w.__create_viteOut = "";
      for (const stream of [vite.stdout, vite.stderr]) {
        void (async () => {
          const reader = stream.getReader();
          for (;;) {
            const { value, done } = await reader.read();
            if (done) return;
            w.__create_viteOut += new TextDecoder().decode(value);
          }
        })();
      }
    });
    const viteOutput = () => page.evaluate(() => (window as unknown as { __create_viteOut: string }).__create_viteOut);
    await expect.poll(viteOutput, { timeout: 30_000 }).toContain("Local:");

    await page.evaluate(() => (window as unknown as { __create_vite: { kill: () => void } }).__create_vite.kill());
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

test.describe("TanStack Router template (Studio recipe)", () => {
  // apps/studio's tanstackRouterTemplateProject.ts scaffolds react-ts, adds @tanstack/react-router
  // + @tanstack/router-plugin, and replaces the entry/App with a router setup. This is the exact
  // recipe (same package versions, same files), proving end-to-end that the router plugin's own
  // Vite plugin (which must run BEFORE @vitejs/plugin-react, see vite.config.ts below) really does
  // generate routeTree.gen.ts on dev start under wcvm's sandboxed fs/Vite, and that real
  // client-side navigation between file-based routes works through the preview iframe. First found
  // genuinely broken (a real circular ESM import three layers deep in @tanstack/router-core's own
  // zod dependency), then FIXED at the ESM loader level - see constants.ts's own comment on the
  // picker entry for the full writeup of everything that had to be fixed along the way.
  const VITE_CONFIG_TS = `import { defineConfig } from "vite";
import { tanstackRouter } from "@tanstack/router-plugin/vite";
import viteReact from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [
    // The router plugin MUST come before React's so routeTree.gen.ts is generated
    // before the React transform runs.
    tanstackRouter({ target: "react", autoCodeSplitting: true }),
    viteReact(),
  ],
});
`;

  const MAIN_TSX = `import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { RouterProvider, createRouter } from "@tanstack/react-router";
import { routeTree } from "./routeTree.gen";

// wcvm's preview relay serves this project under a /__wcvm_preview__/<port>/ prefix - the router
// needs to know about it, since it matches routes against the real window.location.pathname,
// which includes that prefix inside the preview iframe. The port isn't known ahead of time (you
// start the dev server yourself, on whatever port Vite picks), so this is computed at runtime,
// not a build-time Vite "base" config. Outside wcvm's preview (e.g. a plain "vite preview"), this
// is just "/", Vite's own default.
const segments = window.location.pathname.split("/").filter(Boolean);
const basepath = segments[0] === "__wcvm_preview__" && segments[1] ? "/" + segments[0] + "/" + segments[1] : "/";

// The @tanstack/router-plugin Vite plugin generates ./routeTree.gen.ts on dev start.
const router = createRouter({
  routeTree,
  basepath,
  defaultPreload: "intent",
  scrollRestoration: true,
});

declare module "@tanstack/react-router" {
  interface Register {
    router: typeof router;
  }
}

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <RouterProvider router={router} />
  </StrictMode>,
);
`;

  const ROOT_ROUTE_TSX = `import { Link, Outlet, createRootRoute } from "@tanstack/react-router";

export const Route = createRootRoute({
  component: RootComponent,
});

function RootComponent() {
  return (
    <div style={{ fontFamily: "system-ui, sans-serif" }}>
      <nav style={{ display: "flex", gap: "1rem", padding: "1rem" }}>
        <Link to="/">Home</Link>
        <Link to="/about">About</Link>
      </nav>
      <hr />
      <Outlet />
    </div>
  );
}
`;

  const INDEX_ROUTE_TSX = `import { createFileRoute } from "@tanstack/react-router";

export const Route = createFileRoute("/")({
  component: Home,
});

function Home() {
  return (
    <main style={{ padding: "2rem" }}>
      <h1>TanStack Router</h1>
      <p>Type-safe, file-based routing for React — a client-side SPA on Vite.</p>
      <p>
        Edit <code>src/routes/index.tsx</code> and save, or add a file under{" "}
        <code>src/routes/</code>.
      </p>
    </main>
  );
}
`;

  const ABOUT_ROUTE_TSX = `import { createFileRoute } from "@tanstack/react-router";

export const Route = createFileRoute("/about")({
  component: About,
});

function About() {
  return (
    <main style={{ padding: "2rem" }}>
      <h1>About</h1>
      <p>
        This route lives in <code>src/routes/about.tsx</code>.
      </p>
    </main>
  );
}
`;

  // FIXED (was: vite.config.ts failed to load with EsmResolveError: Circular static ESM import
  // involving zod/v4/core/core.js, reached transitively through @tanstack/router-plugin - a
  // genuine 2-node cycle, zod v4's own core.js<->util.js). Root-caused and fixed in
  // runtime/esm/loader.ts + runtime/esm/cyclic.ts: see their own doc comments for the full design
  // (a live, getter-backed registry per cyclic module instead of a native import between them).
  test("scaffolds, installs and serves a real dev server, and client-side navigation works", async ({ page }) => {
    test.skip(!process.env.WCVM_E2E_VITE, "opt-in: set WCVM_E2E_VITE=1 (installs create-vite, then Vite/React/TanStack Router, from registry.npmjs.org)");
    test.setTimeout(120_000);

    await page.click("#preview-enable");
    await expect(page.locator("#preview-status")).toHaveText(/Waiting for a script to listen/);

    // 1. Scaffold - exactly what createTanstackRouterTemplateProject does.
    const created = await spawn(page, "npm", ["create", "vite@latest", "tsr", "--", "--template", "react-ts", "--no-interactive"], "/");
    expect(created.code).toBe(0);

    // 2. Wire up TanStack Router - same package.json/file edits as the Studio recipe (pkg edits
    // inline the pins vitePins.ts's pinVitePackage() would apply, since this test lives outside
    // the studio app).
    await page.evaluate(
      async ({ viteConfig, mainTsx, rootRoute, indexRoute, aboutRoute }) => {
        const { fs } = (window as unknown as WcWindow).wc;
        const pkg = JSON.parse(new TextDecoder().decode(await fs.readFile("/tsr/package.json")));
        pkg.dependencies = { ...pkg.dependencies, "@tanstack/react-router": "^1.130.0" };
        pkg.devDependencies = {
          ...pkg.devDependencies,
          "@tanstack/router-plugin": "^1.130.0",
          vite: "7.3.6",
          "@vitejs/plugin-react": "^5.0.0",
        };
        pkg.overrides = { esbuild: "npm:esbuild-wasm@0.28.2", rollup: "npm:@rollup/wasm-node@4.63.4" };
        await fs.writeFile("/tsr/package.json", JSON.stringify(pkg));
        await fs.writeFile("/tsr/vite.config.ts", viteConfig);
        await fs.writeFile("/tsr/src/main.tsx", mainTsx);
        if (await fs.exists("/tsr/src/App.tsx")) await fs.rm("/tsr/src/App.tsx");
        if (await fs.exists("/tsr/src/App.css")) await fs.rm("/tsr/src/App.css");
        await fs.mkdir("/tsr/src/routes", { recursive: true });
        await fs.writeFile("/tsr/src/routes/__root.tsx", rootRoute);
        await fs.writeFile("/tsr/src/routes/index.tsx", indexRoute);
        await fs.writeFile("/tsr/src/routes/about.tsx", aboutRoute);
      },
      { viteConfig: VITE_CONFIG_TS, mainTsx: MAIN_TSX, rootRoute: ROOT_ROUTE_TSX, indexRoute: INDEX_ROUTE_TSX, aboutRoute: ABOUT_ROUTE_TSX },
    );

    // 3. Install.
    const install = await spawn(page, "npm", ["install"], "/tsr");
    expect(install.code).toBe(0);

    // 4. Start the real dev server.
    await page.evaluate(async () => {
      const wc = (window as unknown as WcWindow).wc;
      const vite = await wc.spawn("node", ["node_modules/vite/bin/vite.js", "--port", "5198", "--strictPort"], { cwd: "/tsr" });
      const w = window as unknown as { __tsr: typeof vite; __tsrOut: string };
      w.__tsr = vite;
      w.__tsrOut = "";
      for (const stream of [vite.stdout, vite.stderr]) {
        void (async () => {
          const reader = stream.getReader();
          for (;;) {
            const { value, done } = await reader.read();
            if (done) return;
            w.__tsrOut += new TextDecoder().decode(value);
          }
        })();
      }
    });
    const viteOutput = () => page.evaluate(() => (window as unknown as { __tsrOut: string }).__tsrOut);
    await expect.poll(viteOutput, { timeout: 30_000 }).toContain("Local:");

    // 5. The router plugin actually generated routeTree.gen.ts, and the app renders through it.
    const generated = await page.evaluate(() => (window as unknown as WcWindow).wc.fs.exists("/tsr/src/routeTree.gen.ts"));
    expect(generated).toBe(true);

    await expect(page.locator("#preview-frame")).toHaveAttribute("src", "/__wcvm_preview__/5198/");
    const frame = page.frameLocator("#preview-frame");
    await expect(frame.locator("h1")).toHaveText("TanStack Router", { timeout: 30_000 });

    // 6. Real client-side navigation (no full reload) between the two file-based routes.
    await frame.locator("a", { hasText: "About" }).click();
    await expect(frame.locator("h1")).toHaveText("About");
    await frame.locator("a", { hasText: "Home" }).click();
    await expect(frame.locator("h1")).toHaveText("TanStack Router");

    await page.evaluate(async () => {
      const vite = (window as unknown as { __tsr: { kill: () => void; exit: Promise<unknown> } }).__tsr;
      vite.kill();
      await vite.exit;
    });
  });
});

test.describe("Frontend template scaffolds (Preact/Lit/Solid/Qwik/Svelte)", () => {
  // Studio's picker (apps/studio/src/features/Home/CardTemplate/CreateTemplateDialog/constants.ts)
  // offers these four via the SAME generic path react-ts/vue-ts already use
  // (templateProjects/viteTemplateProject.ts's pinVitePackage(): pins vite to 7.3.6 and swaps
  // esbuild/rollup for their wasm builds - it does NOT pin each framework's own vite plugin, only
  // @vitejs/plugin-react/plugin-vue). The commit that added them claimed Qwik alone "hit a
  // different, not-yet-diagnosed dev-server problem" and was left out of the picker - but the
  // code shipped a "qwik-ts" entry anyway, so that claim can't be trusted without checking for
  // real. This runs the EXACT production recipe for all four, one framework per test so a single
  // failure doesn't hide the others.
  const runTemplate = async (
    page: import("@playwright/test").Page,
    id: string,
    dir: string,
    port: number,
    knownPluginPins: Record<string, string> = {},
  ) => {
    const created = await spawn(page, "npm", ["create", "vite@latest", dir, "--", "--template", id, "--no-interactive"], "/");
    expect(created.code).toBe(0);

    // Exactly pinVitePackage() (apps/studio/.../vitePins.ts): pin vite + swap esbuild/rollup for
    // their wasm builds, plus any framework plugin pin KNOWN_PLUGIN_PINS actually has for this
    // template (only applied when the scaffold already depends on it, same as the real function).
    await page.evaluate(
      async ({ dir, knownPluginPins }) => {
        const { fs } = (window as unknown as WcWindow).wc;
        const pkg = JSON.parse(new TextDecoder().decode(await fs.readFile(`/${dir}/package.json`)));
        pkg.devDependencies.vite = "7.3.6";
        for (const [name, pin] of Object.entries(knownPluginPins)) {
          if (pkg.devDependencies[name]) pkg.devDependencies[name] = pin;
        }
        pkg.overrides = { ...pkg.overrides, esbuild: "npm:esbuild-wasm@0.28.2", rollup: "npm:@rollup/wasm-node@4.63.4" };
        await fs.writeFile(`/${dir}/package.json`, JSON.stringify(pkg));
      },
      { dir, knownPluginPins },
    );

    const install = await spawn(page, "npm", ["install"], `/${dir}`);
    expect(install.code, install.out + install.err).toBe(0);

    await page.evaluate(
      async ({ dir, port }) => {
        const wc = (window as unknown as WcWindow).wc;
        const vite = await wc.spawn("node", ["node_modules/vite/bin/vite.js", "--port", String(port), "--strictPort"], { cwd: `/${dir}` });
        const w = window as unknown as { __tpl: typeof vite; __tplOut: string };
        w.__tpl = vite;
        w.__tplOut = "";
        for (const stream of [vite.stdout, vite.stderr]) {
          void (async () => {
            const reader = stream.getReader();
            for (;;) {
              const { value, done } = await reader.read();
              if (done) return;
              w.__tplOut += new TextDecoder().decode(value);
            }
          })();
        }
      },
      { dir, port },
    );
    const output = () => page.evaluate(() => (window as unknown as { __tplOut: string }).__tplOut);
    await expect.poll(output, { timeout: 30_000 }).toMatch(/Local:|error/i);
    const out = await output();
    expect(out, out).toContain("Local:");

    await expect(page.locator("#preview-frame")).toHaveAttribute("src", `/__wcvm_preview__/${port}/`);
  };

  const stopTemplate = (page: import("@playwright/test").Page) =>
    page.evaluate(async () => {
      const vite = (window as unknown as { __tpl: { kill: () => void; exit: Promise<unknown> } }).__tpl;
      vite.kill();
      await vite.exit;
    });

  test("preact-ts really runs (@preact/preset-vite, unpinned, against vite 7.3.6)", async ({ page }) => {
    test.skip(!process.env.WCVM_E2E_VITE, "opt-in: set WCVM_E2E_VITE=1 (installs from registry.npmjs.org)");
    test.setTimeout(90_000);
    await page.click("#preview-enable");
    await runTemplate(page, "preact-ts", "tpl-preact", 5199);
    await expect(page.frameLocator("#preview-frame").locator("h1")).toHaveText("Get started", { timeout: 30_000 });
    await stopTemplate(page);
  });

  test("lit-ts really runs (no vite plugin at all - just vite 7.3.6 + TS)", async ({ page }) => {
    test.skip(!process.env.WCVM_E2E_VITE, "opt-in: set WCVM_E2E_VITE=1 (installs from registry.npmjs.org)");
    test.setTimeout(90_000);
    await page.click("#preview-enable");
    await runTemplate(page, "lit-ts", "tpl-lit", 5200);
    // The <h1> is static light-DOM content in index.html itself, projected through <slot></slot>
    // - it renders even if the custom element's own JS never runs, so it isn't proof of anything.
    // "Count is 0" only renders through <my-element>'s own shadow-DOM template once Lit's JS
    // actually executes.
    await expect(page.frameLocator("#preview-frame").locator("button")).toHaveText("Count is 0", { timeout: 30_000 });
    await stopTemplate(page);
  });

  test("solid-ts really runs (vite-plugin-solid, unpinned, against vite 7.3.6)", async ({ page }) => {
    test.skip(!process.env.WCVM_E2E_VITE, "opt-in: set WCVM_E2E_VITE=1 (installs from registry.npmjs.org)");
    test.setTimeout(90_000);
    await page.click("#preview-enable");
    await runTemplate(page, "solid-ts", "tpl-solid", 5201);
    await expect(page.frameLocator("#preview-frame").locator("h1")).toHaveText("Get started", { timeout: 30_000 });
    await stopTemplate(page);
  });

  // FIXED (was: hung forever, no error, ever - root-caused to @builder.io/qwik's own optimizer
  // (dist/optimizer.mjs's loadPlatformBinding()): after its expected, harmless native-binding
  // failure ("Unable to load native binding ... Falling back to wasm build."), its wasm fallback
  // calls the real, native `WebAssembly.compile()`/`instantiate()` directly - a Promise wcvm's own
  // event loop (eventLoop.ts) knew nothing about, since `WebAssembly` reaches guest code completely
  // unmodified (`globalObject: self`). With nothing else pending, the loop considered itself idle
  // and the whole process (its underlying Worker) got torn down before that real, independent
  // Chromium-internal compile ever had a live realm left to deliver its result into - same broad
  // class of gap already hit for a `uv_tcp_t`/`FSEvent`/`MessagePort` that forgot to `ref()`.
  // Fixed in runtime/bindings/rawWasm.ts: wraps the real `WebAssembly.compile`/`instantiate`/
  // `instantiateStreaming`/`compileStreaming` to ref the loop for the duration of each call, the
  // same shape rawFetch.ts's wrapped `fetch` and zlib.ts's `ctx.loop.ref()` around the real
  // `CompressionStream` already use).
  test("qwik-ts really runs (@builder.io/qwik's own optimizer, peer range vite >=5 <8)", async ({ page }) => {
    test.skip(!process.env.WCVM_E2E_VITE, "opt-in: set WCVM_E2E_VITE=1 (installs from registry.npmjs.org)");
    test.setTimeout(90_000);
    await page.click("#preview-enable");
    await runTemplate(page, "qwik-ts", "tpl-qwik", 5202);
    await expect(page.frameLocator("#preview-frame").locator("h1")).toHaveText("Get started", { timeout: 30_000 });
    await stopTemplate(page);
  });

  // FIXED (was PARKED - see HISTORY.md's "Svelte was attempted as a fifth example and PARKED"):
  // Svelte's own compiler (compiler/utils/ast.js <-> #compiler/builders) has a genuine, static,
  // mutual circular ESM import that wcvm's ESM loader couldn't handle until the SCC-aware rewrite
  // added alongside TanStack Router above (runtime/esm/loader.ts, runtime/esm/cyclic.ts). Unlike
  // Preact/Lit/Solid/Qwik, create-vite's svelte-ts template needs one plugin pin:
  // @sveltejs/vite-plugin-svelte defaults to ^7.3.0, which needs vite@8+ (this sandbox has no
  // Rolldown-WASM build) - ^6.2.4 is the last major still compatible with vite@7 (confirmed via
  // `npm view @sveltejs/vite-plugin-svelte@6.2.4 peerDependencies`: "^6.3.0 || ^7.0.0").
  test("svelte-ts really runs (@sveltejs/vite-plugin-svelte pinned to ^6.2.4 for vite@7)", async ({ page }) => {
    test.skip(!process.env.WCVM_E2E_VITE, "opt-in: set WCVM_E2E_VITE=1 (installs from registry.npmjs.org)");
    test.setTimeout(90_000);
    await page.click("#preview-enable");
    await runTemplate(page, "svelte-ts", "tpl-svelte", 5203, { "@sveltejs/vite-plugin-svelte": "^6.2.4" });
    await expect(page.frameLocator("#preview-frame").locator("h1")).toHaveText("Get started", { timeout: 30_000 });
    await stopTemplate(page);
  });
});

test.describe("Bootstrap 5 template (Studio recipe)", () => {
  // apps/studio's bootstrapTemplateProject.ts: scaffold vanilla-ts, add the real bootstrap npm
  // package, pinVitePackage() (vite 7.3.6 + wasm overrides - vanilla-ts has no plugin of its own
  // to pin), and swap in a small index.html/main.ts that also exercises Bootstrap's JS (a modal),
  // not just its CSS. Lower risk than the other hand-wired templates (no build-time plugin, no
  // transitive dependency prone to a circular-ESM cycle) but never actually run end to end before.
  const INDEX_HTML = `<!doctype html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>Vite + Bootstrap 5</title>
  </head>
  <body>
    <div id="app" class="container py-5"></div>
    <script type="module" src="/src/main.ts"></script>
  </body>
</html>
`;

  const MAIN_TS = `import "bootstrap/dist/css/bootstrap.min.css";
import { Modal } from "bootstrap";

const app = document.querySelector<HTMLDivElement>("#app")!;
app.innerHTML = \`
  <h1 class="mb-3">Vite + Bootstrap 5</h1>
  <p class="text-muted">Running inside wcvm.</p>
  <button class="btn btn-primary" id="open" type="button">Open modal</button>
  <div class="modal fade" id="demo" tabindex="-1">
    <div class="modal-dialog"><div class="modal-content">
      <div class="modal-header"><h5 class="modal-title">Hello</h5></div>
      <div class="modal-body">Bootstrap's JS works too.</div>
      <div class="modal-footer"><button class="btn btn-secondary" data-bs-dismiss="modal" type="button">Close</button></div>
    </div></div>
  </div>
\`;
const modal = new Modal("#demo");
document.querySelector("#open")!.addEventListener("click", () => modal.show());
`;

  test("scaffolds, installs and serves a real dev server, and Bootstrap's own JS (a modal) works", async ({ page }) => {
    test.skip(!process.env.WCVM_E2E_VITE, "opt-in: set WCVM_E2E_VITE=1 (installs from registry.npmjs.org)");
    test.setTimeout(90_000);
    await page.click("#preview-enable");

    const created = await spawn(page, "npm", ["create", "vite@latest", "tpl-bootstrap", "--", "--template", "vanilla-ts", "--no-interactive"], "/");
    expect(created.code).toBe(0);

    await page.evaluate(
      async ({ indexHtml, mainTs }) => {
        const { fs } = (window as unknown as WcWindow).wc;
        const pkg = JSON.parse(new TextDecoder().decode(await fs.readFile("/tpl-bootstrap/package.json")));
        pkg.dependencies = { ...pkg.dependencies, bootstrap: "^5.3.3" };
        pkg.devDependencies.vite = "7.3.6";
        pkg.overrides = { ...pkg.overrides, esbuild: "npm:esbuild-wasm@0.28.2", rollup: "npm:@rollup/wasm-node@4.63.4" };
        await fs.writeFile("/tpl-bootstrap/package.json", JSON.stringify(pkg));
        await fs.writeFile("/tpl-bootstrap/index.html", indexHtml);
        await fs.writeFile("/tpl-bootstrap/src/main.ts", mainTs);
      },
      { indexHtml: INDEX_HTML, mainTs: MAIN_TS },
    );

    const install = await spawn(page, "npm", ["install"], "/tpl-bootstrap");
    expect(install.code, install.out + install.err).toBe(0);

    await page.evaluate(async () => {
      const wc = (window as unknown as WcWindow).wc;
      const vite = await wc.spawn("node", ["node_modules/vite/bin/vite.js", "--port", "5203", "--strictPort"], { cwd: "/tpl-bootstrap" });
      const w = window as unknown as { __bs: typeof vite; __bsOut: string };
      w.__bs = vite;
      w.__bsOut = "";
      for (const stream of [vite.stdout, vite.stderr]) {
        void (async () => {
          const reader = stream.getReader();
          for (;;) {
            const { value, done } = await reader.read();
            if (done) return;
            w.__bsOut += new TextDecoder().decode(value);
          }
        })();
      }
    });
    const output = () => page.evaluate(() => (window as unknown as { __bsOut: string }).__bsOut);
    await expect.poll(output, { timeout: 30_000 }).toMatch(/Local:|error/i);
    const out = await output();
    expect(out, out).toContain("Local:");

    const frame = page.frameLocator("#preview-frame");
    await expect(frame.locator("h1")).toHaveText("Vite + Bootstrap 5", { timeout: 30_000 });
    await frame.locator("#open").click();
    await expect(frame.locator(".modal-body")).toBeVisible();

    await page.evaluate(async () => {
      const vite = (window as unknown as { __bs: { kill: () => void; exit: Promise<unknown> } }).__bs;
      vite.kill();
      await vite.exit;
    });
  });
});

test.describe("Tailwind v4 native deps (@tailwindcss/oxide WASI, lightningcss)", () => {
  // Tailwind CSS v4 was INVESTIGATED and PARKED, not shipped as a Studio template - see PLAN.md's
  // "Tailwind CSS v4: feasibility findings" for the full writeup. This test documents the one part
  // that genuinely DOES work (kept as a real, passing regression - both native deps loading and
  // running basic native work at all): everything past it (real project-file scanning) hits a
  // structural deadlock this sandbox cannot route around.
  //
  // Summary of the full investigation (see PLAN.md for the complete chain of reasoning):
  // - lightningcss: fixed cleanly. Swapped for lightningcss-wasm via the usual `overrides` trick
  //   (esbuild/rollup already use it) - its "node" condition target happens to be sandbox-friendly
  //   already (sync fs.readFileSync + sync WebAssembly.Module/Instance, no thread pool at all).
  // - @tailwindcss/oxide (a Scanner, native Rust via napi-rs): its stock loader needs real
  //   `node:wasi` (unimplemented) and throws - but its own `-wasm32-wasi` optional sibling (already
  //   installed for free, since wcvm's npm fakes cpu="wasm32" for esbuild/rollup's own wasm32
  //   variants too) ships a real browser build using the same @napi-rs/wasm-runtime shape already
  //   proven for @rolldown/browser. Reaching it needs a POST-INSTALL PATCH (real Node ignores the
  //   legacy "browser" package.json field this build is only ever reached through in real usage;
  //   plus a .js->.mjs rename, since the file's own package has no "type":"module") - done below,
  //   and it genuinely works for a TRIVIAL case (this test).
  // - BUT real Scanner.scan() (native FS globbing/reading) spawns a WASI worker thread whose own
  //   file reads relay back to the creator thread's in-memory filesystem via postMessage +
  //   Atomics.wait - and the creator thread is ITSELF already frozen in its own Atomics.wait,
  //   waiting for that same worker. A genuine, structural deadlock (confirmed via a heartbeat
  //   timer that stops dead the instant scan() is called) - not fixable via asyncWorkPoolSize or
  //   RAYON_NUM_THREADS (a worker is unconditionally created regardless of either).
  // - Scanner.scanFiles()/getCandidatesWithPositions() (content-based, no native FS access) avoid
  //   THAT specific deadlock - proven for a single, trivial HTML string. But real project files
  //   need real content, and a REAL PATCH to @tailwindcss/vite's own plugin (feeding it file
  //   content via wcvm's own real fs.globSync - itself needing internal/deps/minimatch vendored,
  //   a genuine new wcvm capability, see CLAUDE.md's Status) got real Tailwind CSS (theme/base
  //   layers) generating correctly.
  // - THE ACTUAL, FINAL BLOCKER: any JS/TS/JSX content containing a real `import` statement
  //   deadlocks scanFiles() too - confirmed in complete isolation (a fresh Scanner, a single file,
  //   no prior calls). Oxide's own JS/TSX candidate extractor apparently tries to resolve import
  //   specifiers as part of parsing, hitting the identical worker-pool/fs-proxy relay regardless
  //   of which API is used to reach it. Since virtually every real component file (React, Vue,
  //   Svelte, or even plain TypeScript) has at least one import, this isn't a narrow edge case -
  //   only import-free, static HTML/CSS content can be scanned safely. Parked: a genuine
  //   structural dead end in `@napi-rs/wasm-runtime`'s browser build, the same category of finding
  //   as "Real npm: feasibility findings" (PLAN.md) - not a scoped patch away.
  test("Scanner (@tailwindcss/oxide) and transform() (lightningcss) both really run, after a targeted node_modules patch", async ({ page }) => {
    test.skip(!process.env.WCVM_E2E_VITE, "opt-in: set WCVM_E2E_VITE=1 (installs from registry.npmjs.org)");
    test.setTimeout(90_000);

    await page.evaluate(async () => {
      const { fs } = (window as unknown as WcWindow).wc;
      await fs.mkdir("/tw-probe", { recursive: true });
      // "lightningcss" is deliberately NOT a direct dependency here - wcvm's own npm overrides
      // only apply to TRANSITIVE requests (install.ts's readOverrides doc comment: "the project's
      // own direct dependencies keep what they say", matching how the real Tailwind template will
      // actually see it too: @tailwindcss/node depends on lightningcss, wcvm's picker never would).
      await fs.writeFile(
        "/tw-probe/package.json",
        JSON.stringify({
          name: "tw-probe",
          private: true,
          dependencies: { "@tailwindcss/oxide": "4.3.3", "@tailwindcss/node": "4.3.3" },
          overrides: { lightningcss: "npm:lightningcss-wasm@1.30.2" },
        }),
      );
    });

    const install = await spawn(page, "npm", ["install"], "/tw-probe");
    expect(install.code, install.out + install.err).toBe(0);

    const patched = await page.evaluate(async () => {
      const { fs } = (window as unknown as WcWindow).wc;
      const wasiPkgDir = "/tw-probe/node_modules/@tailwindcss/oxide-wasm32-wasi";
      if (!(await fs.exists(wasiPkgDir))) return { ok: false, reason: "oxide-wasm32-wasi not installed" };

      const browserJs = new TextDecoder().decode(await fs.readFile(`${wasiPkgDir}/tailwindcss-oxide.wasi-browser.js`));
      await fs.writeFile(`${wasiPkgDir}/tailwindcss-oxide.wasi-browser.mjs`, browserJs);

      const oxideDir = "/tw-probe/node_modules/@tailwindcss/oxide";
      await fs.writeFile(`${oxideDir}/package.json`, JSON.stringify({ name: "@tailwindcss/oxide", version: "4.3.3", type: "module", main: "index.js" }));
      // A bare `@tailwindcss/oxide-wasm32-wasi/...` subpath specifier hits wcvm's ESM resolver's
      // own simplification (no "exports" map in that package -> subpaths are rejected outright,
      // unlike real Node's legacy any-subpath-resolves fallback) - a plain RELATIVE specifier
      // sidesteps package resolution/"exports" entirely, and both packages are npm-hoisted
      // siblings under the same @tailwindcss/ scope directory.
      await fs.writeFile(
        `${oxideDir}/index.js`,
        [
          'export * from "../oxide-wasm32-wasi/tailwindcss-oxide.wasi-browser.mjs";',
          'export { default } from "../oxide-wasm32-wasi/tailwindcss-oxide.wasi-browser.mjs";',
        ].join("\n"),
      );
      return { ok: true };
    });
    expect(patched.ok, JSON.stringify(patched)).toBe(true);

    await page.evaluate(async () => {
      const { fs } = (window as unknown as WcWindow).wc;
      await fs.writeFile(
        "/tw-probe/test.mjs",
        [
          'import { Scanner } from "@tailwindcss/oxide";',
          'import { transform } from "lightningcss";',
          "const scanner = new Scanner({ sources: [] });",
          'console.log("scanner", typeof scanner.scan);',
          'const out = transform({ filename: "a.css", code: Buffer.from(".a{color:red}") });',
          "console.log(\"lightningcss\", out.code.toString());",
        ].join("\n"),
      );
    });

    const r = await spawn(page, "node", ["test.mjs"], "/tw-probe");
    expect(r, r.out + r.err).toMatchObject({ code: 0 });
    expect(r.out).toContain("scanner function");
    expect(r.out).toMatch(/lightningcss[\s\S]*\.a\s*\{\s*color:\s*red;?\s*\}/);
  });

  // FOUND THE REAL TRIGGER (narrower than first thought): it's not "any content with an import
  // statement" - it's any scanFiles() call whose total input spans MORE than one line, whether
  // that's one multi-line content string OR multiple single-line entries in the same call (both
  // isolated directly: a single entry with a leading blank line, or a leading comment line, or a
  // real `import` line, all deadlock the same way once real class-bearing content lands on line 2
  // or later; two single-line entries in ONE call deadlock too, even though NEITHER entry alone
  // is multi-line). A single scanFiles() call with EXACTLY one entry, EXACTLY one line, never
  // dispatches to the worker pool at all and always returns immediately - confirmed by splitting
  // a real, realistic multi-line file (main.ts-shaped, 20 lines, real Tailwind classes scattered
  // across it) into one scanFiles() call PER non-blank line: no hang, correct candidates found
  // (bg-indigo-600, rounded-xl, shadow-lg, hover:bg-indigo-700, ...), and fast (native calls, not
  // the deadlocking pool path - 20 lines in ~11ms). This is the real, viable workaround
  // @tailwindcss/vite's own plugin patch is built on (see the Studio recipe test below).
  test("scanFiles() called once per line avoids the deadlock, even for realistic multi-line content", async ({ page }) => {
    test.skip(!process.env.WCVM_E2E_VITE, "opt-in: set WCVM_E2E_VITE=1 (installs from registry.npmjs.org)");
    test.setTimeout(60_000);

    await page.evaluate(async () => {
      const { fs } = (window as unknown as WcWindow).wc;
      await fs.mkdir("/tw-strip", { recursive: true });
      await fs.writeFile(
        "/tw-strip/package.json",
        JSON.stringify({ name: "tw-strip", private: true, dependencies: { "@tailwindcss/oxide": "4.3.3" } }),
      );
    });
    const install = await spawn(page, "npm", ["install"], "/tw-strip");
    expect(install.code, install.out + install.err).toBe(0);

    const patched = await page.evaluate(async () => {
      const { fs } = (window as unknown as WcWindow).wc;
      const wasiPkgDir = "/tw-strip/node_modules/@tailwindcss/oxide-wasm32-wasi";
      if (!(await fs.exists(wasiPkgDir))) return { ok: false };
      const browserJs = new TextDecoder().decode(await fs.readFile(`${wasiPkgDir}/tailwindcss-oxide.wasi-browser.js`));
      await fs.writeFile(`${wasiPkgDir}/tailwindcss-oxide.wasi-browser.mjs`, browserJs);
      const oxideDir = "/tw-strip/node_modules/@tailwindcss/oxide";
      await fs.writeFile(`${oxideDir}/package.json`, JSON.stringify({ name: "@tailwindcss/oxide", version: "4.3.3", type: "module", main: "index.js" }));
      await fs.writeFile(
        `${oxideDir}/index.js`,
        [
          'export * from "../oxide-wasm32-wasi/tailwindcss-oxide.wasi-browser.mjs";',
          'export { default } from "../oxide-wasm32-wasi/tailwindcss-oxide.wasi-browser.mjs";',
        ].join("\n"),
      );
      return { ok: true };
    });
    expect(patched.ok).toBe(true);

    await page.evaluate(async () => {
      const { fs } = (window as unknown as WcWindow).wc;
      await fs.writeFile(
        "/tw-strip/test.mjs",
        [
          'setInterval(() => console.log("heartbeat"), 500).unref();',
          'const { Scanner } = await import("@tailwindcss/oxide");',
          "const realFile = [",
          '  \'import "./index.css";\',',
          "  '',",
          '  "const app = document.querySelector<HTMLDivElement>(\\"#app\\")!;",',
          "  'app.innerHTML = `',",
          "  '  <main class=\"flex min-h-screen items-center justify-center bg-slate-100\">',",
          "  '    <div id=\"card\" class=\"max-w-sm rounded-xl bg-white p-8 shadow-lg\">',",
          '  \'      <h1 class="text-2xl font-bold text-slate-900">Vite + Tailwind CSS</h1>\',',
          "  '      <p class=\"mt-2 text-slate-500\">Running inside wcvm.</p>',",
          '  \'      <button id="count" type="button" class="mt-6 rounded-lg bg-indigo-600 px-4 py-2 font-semibold text-white hover:bg-indigo-700">\',',
          "  '        count is 0',",
          "  '      </button>',",
          "  '    </div>',",
          "  '  </main>',",
          "  '`;',",
          "  '',",
          "  'let count = 0;',",
          '  "document.querySelector<HTMLButtonElement>(\\"#count\\")!.addEventListener(\\"click\\", (event) => {",',
          "  '  count++;',",
          '  \'  (event.currentTarget as HTMLButtonElement).textContent = `count is ${count}`;\',',
          "  '});',",
          "].join(\"\\n\");",
          "const start = Date.now();",
          "const scanner = new Scanner({ sources: [] });",
          "const candidates = new Set();",
          "for (const line of realFile.split(\"\\n\")) {",
          '  if (!line.trim()) continue;',
          '  for (const c of scanner.scanFiles([{ content: line, extension: "ts" }])) candidates.add(c);',
          "}",
          'console.log("lines processed:", realFile.split("\\n").length, "in", Date.now() - start, "ms");',
          'console.log("scanned", JSON.stringify([...candidates]));',
        ].join("\n"),
      );
    });

    await page.evaluate(async () => {
      const wc = (window as unknown as WcWindow).wc;
      const proc = await wc.spawn("node", ["test.mjs"], { cwd: "/tw-strip" });
      const w = window as unknown as { __twStrip: string };
      w.__twStrip = "";
      for (const stream of [proc.stdout, proc.stderr]) {
        void (async () => {
          const reader = stream.getReader();
          for (;;) {
            const { value, done } = await reader.read();
            if (done) return;
            w.__twStrip += new TextDecoder().decode(value);
          }
        })();
      }
    });
    await page.waitForTimeout(15_000);
    const out = await page.evaluate(() => (window as unknown as { __twStrip: string }).__twStrip);
    expect(out, out).toContain("scanned");
    expect(out).toContain("bg-indigo-600");
    expect(out).toContain("rounded-xl");
    expect(out).toContain("hover:bg-indigo-700");
  });
});

test.describe("Tailwind CSS v4 template (Studio recipe)", () => {
  // apps/studio's tailwindTemplateProject.ts: scaffold vanilla-ts, wire in @tailwindcss/vite +
  // the node_modules patches proven standalone above (lightningcss -> lightningcss-wasm via
  // overrides, @tailwindcss/oxide's own index.js/package.json rewritten to reach its already-
  // installed -wasm32-wasi sibling's browser build), PLUS a patch to @tailwindcss/vite's OWN
  // plugin code: its stock `this.scanner.scan()` call deadlocks (see the "Tailwind v4 native
  // deps" describe block above for the full story - a real, structural Atomics.wait deadlock
  // between the creator thread and its own spawned WASI worker), and even the content-based
  // `scanFiles()` deadlocks the same way once given more than one line's worth of input in a
  // single call. The fix: read real files via wcvm's own fs.globSync, split each into lines, and
  // call scanFiles() once per non-blank line - proven standalone (the "scanFiles() called once
  // per line..." test above) to avoid the deadlock entirely, with correct candidate detection and
  // negligible overhead (native calls, not the deadlocking pool path).
  const patchTailwindVitePlugin = (source: string): string => {
    const replacements: [string, string][] = [
      [
        'import*as M from"vite";',
        'import*as M from"vite";import{readFileSync as __wcvmReadFileSync,globSync as __wcvmGlobSync}from"node:fs";' +
          "function __wcvmScanSources(sources){" +
          "const files=new Set();" +
          "for(const s of sources){" +
          "if(s.negated)continue;" +
          "let matches=[];" +
          'try{matches=__wcvmGlobSync(s.pattern,{cwd:s.base,exclude:p=>p.split("/").some(seg=>seg==="node_modules"||(seg.startsWith(".")&&seg!=="."&&seg!==".."))});}catch{}' +
          'for(const m of matches)files.add(m.startsWith("/")?m:s.base+"/"+m);' +
          "}" +
          "return[...files];" +
          "}" +
          // Tailwind's own native scan() skips binary assets by extension internally - since this
          // walker replaces that native logic, it needs the same skip.
          'const __wcvmBinaryExt=new Set(["png","jpg","jpeg","gif","webp","avif","ico","bmp","woff","woff2","ttf","otf","eot","mp4","webm","mp3","wav","ogg","pdf","zip","gz","wasm"]);' +
          "function __wcvmScanFiles(scanner,sources){" +
          "const files=__wcvmScanSources(sources||[]);" +
          "const candidates=new Set();" +
          "for(const file of files){" +
          'const dot=file.lastIndexOf(".");' +
          'const extension=dot===-1?"":file.slice(dot+1).toLowerCase();' +
          "if(__wcvmBinaryExt.has(extension))continue;" +
          "let content;" +
          'try{content=__wcvmReadFileSync(file,"utf8");}catch{continue;}' +
          // ONE scanFiles() call per non-blank LINE, never more than one entry per call - see
          // this file's own "Tailwind v4 native deps" describe block for exactly why: any call
          // spanning more than one line (whether as one multi-line entry or multiple entries in
          // one call) deadlocks; exactly one entry, exactly one line, never does.
          'for(const line of content.split("\\n")){' +
          "if(!line.trim())continue;" +
          'for(const c of scanner.scanFiles([{content:line,extension}]))candidates.add(c);' +
          "}" +
          "}" +
          "return{candidates:[...candidates],files};" +
          "}",
      ],
      ["this.scanner=new Y({sources:d})", "this.scanner=new Y({sources:d}),this.__wcvmSources=d"],
      [
        "for(let i of this.scanner.scan())this.candidates.add(i);",
        "{let __r=__wcvmScanFiles(this.scanner,this.__wcvmSources);this.__wcvmScannedFiles=__r.files;for(let i of __r.candidates)this.candidates.add(i);}",
      ],
      ["for(let i of this.scanner.files)c(i)", "for(let i of(this.__wcvmScannedFiles||[]))c(i)"],
      [
        'for(let i of this.scanner.globs){if(i.pattern[0]==="!")continue;',
        'for(let i of(this.__wcvmSources||[])){if(i.negated||i.pattern[0]==="!")continue;',
      ],
      ["get scannedFiles(){return this.scanner?.files??[]}", "get scannedFiles(){return this.__wcvmScannedFiles??[]}"],
    ];
    let patched = source;
    for (const [from, to] of replacements) {
      if (!patched.includes(from)) throw new Error(`Tailwind Vite plugin patch anchor not found: ${JSON.stringify(from.slice(0, 60))}`);
      patched = patched.replace(from, to);
    }
    return patched;
  };

  test("scaffolds, installs and serves a real dev server, and Tailwind's utility classes really apply", async ({ page }) => {
    test.skip(!process.env.WCVM_E2E_VITE, "opt-in: set WCVM_E2E_VITE=1 (installs from registry.npmjs.org)");
    test.setTimeout(90_000);
    await page.click("#preview-enable");

    const created = await spawn(page, "npm", ["create", "vite@latest", "tpl-tailwind", "--", "--template", "vanilla-ts", "--no-interactive"], "/");
    expect(created.code).toBe(0);

    await page.evaluate(async () => {
      const { fs } = (window as unknown as WcWindow).wc;
      const pkg = JSON.parse(new TextDecoder().decode(await fs.readFile("/tpl-tailwind/package.json")));
      pkg.devDependencies["@tailwindcss/vite"] = "4.3.3";
      pkg.devDependencies.vite = "7.3.6";
      pkg.overrides = {
        ...pkg.overrides,
        esbuild: "npm:esbuild-wasm@0.28.2",
        rollup: "npm:@rollup/wasm-node@4.63.4",
        lightningcss: "npm:lightningcss-wasm@1.30.2",
      };
      await fs.writeFile("/tpl-tailwind/package.json", JSON.stringify(pkg));
      await fs.writeFile(
        "/tpl-tailwind/vite.config.ts",
        'import { defineConfig } from "vite";\nimport tailwindcss from "@tailwindcss/vite";\n\nexport default defineConfig({ plugins: [tailwindcss()] });\n',
      );
      await fs.writeFile(
        "/tpl-tailwind/index.html",
        '<!doctype html>\n<html lang="en">\n  <head><meta charset="UTF-8" /><title>Vite + Tailwind CSS</title></head>\n  <body>\n    <div id="app"></div>\n    <script type="module" src="/src/main.ts"></script>\n  </body>\n</html>\n',
      );
      await fs.writeFile("/tpl-tailwind/src/index.css", '@import "tailwindcss";\n');
      await fs.writeFile(
        "/tpl-tailwind/src/main.ts",
        [
          'import "./index.css";',
          "document.querySelector<HTMLDivElement>(\"#app\")!.innerHTML = `",
          '  <div id="card" class="rounded-xl bg-indigo-600 p-8"><h1>Tailwind</h1></div>',
          "`;",
        ].join("\n"),
      );
    });

    const install = await spawn(page, "npm", ["install"], "/tpl-tailwind");
    expect(install.code, install.out + install.err).toBe(0);

    const patched = await page.evaluate(async () => {
      const { fs } = (window as unknown as WcWindow).wc;
      const wasiPkgDir = "/tpl-tailwind/node_modules/@tailwindcss/oxide-wasm32-wasi";
      if (!(await fs.exists(wasiPkgDir))) return { ok: false, reason: "oxide-wasm32-wasi not installed" };
      const browserJs = new TextDecoder().decode(await fs.readFile(`${wasiPkgDir}/tailwindcss-oxide.wasi-browser.js`));
      await fs.writeFile(`${wasiPkgDir}/tailwindcss-oxide.wasi-browser.mjs`, browserJs);
      const oxideDir = "/tpl-tailwind/node_modules/@tailwindcss/oxide";
      await fs.writeFile(`${oxideDir}/package.json`, JSON.stringify({ name: "@tailwindcss/oxide", version: "4.3.3", type: "module", main: "index.js" }));
      await fs.writeFile(
        `${oxideDir}/index.js`,
        [
          'export * from "../oxide-wasm32-wasi/tailwindcss-oxide.wasi-browser.mjs";',
          'export { default } from "../oxide-wasm32-wasi/tailwindcss-oxide.wasi-browser.mjs";',
        ].join("\n"),
      );
      return { ok: true };
    });
    expect(patched.ok, JSON.stringify(patched)).toBe(true);

    // The Vite plugin patch itself is a pure string transform - runs in the OUTER (real Node)
    // Playwright test process, not inside the page, so it's an ordinary function call rather than
    // needing to serialize/reconstruct it inside page.evaluate.
    const viteDir = "/tpl-tailwind/node_modules/@tailwindcss/vite";
    const original = await page.evaluate(async (dir) => {
      const { fs } = (window as unknown as WcWindow).wc;
      return new TextDecoder().decode(await fs.readFile(`${dir}/dist/index.mjs`));
    }, viteDir);
    const patchedSource = patchTailwindVitePlugin(original);
    await page.evaluate(
      async ({ dir, patchedSource }) => {
        const { fs } = (window as unknown as WcWindow).wc;
        await fs.writeFile(`${dir}/dist/index.mjs`, patchedSource);
      },
      { dir: viteDir, patchedSource },
    );

    await page.evaluate(async () => {
      const wc = (window as unknown as WcWindow).wc;
      const vite = await wc.spawn("node", ["node_modules/vite/bin/vite.js", "--port", "5204", "--strictPort"], { cwd: "/tpl-tailwind" });
      const w = window as unknown as { __tw: typeof vite; __twOut: string };
      w.__tw = vite;
      w.__twOut = "";
      for (const stream of [vite.stdout, vite.stderr]) {
        void (async () => {
          const reader = stream.getReader();
          for (;;) {
            const { value, done } = await reader.read();
            if (done) return;
            w.__twOut += new TextDecoder().decode(value);
          }
        })();
      }
    });
    const output = () => page.evaluate(() => (window as unknown as { __twOut: string }).__twOut);
    await expect.poll(output, { timeout: 30_000 }).toMatch(/Local:|error/i);
    const out = await output();
    expect(out, out).toContain("Local:");

    const frame = page.frameLocator("#preview-frame");
    await expect(frame.locator("h1"), await output()).toHaveText("Tailwind", { timeout: 30_000 });
    // The real proof Tailwind's utility classes compiled and applied - a computed style, not just
    // the class names/markup being present (which would pass even with the CSS build silently
    // failing/producing nothing).
    const card = frame.locator("#card");
    await expect(async () => {
      const [bg, radius] = await card.evaluate((el) => {
        const style = getComputedStyle(el);
        return [style.backgroundColor, style.borderRadius];
      });
      // Tailwind v4's default theme declares colors in OKLCH, not RGB - real Chromium reports the
      // computed value back in whatever color space it was declared in (confirmed directly, not
      // assumed: oklch(0.511 0.262 276.966) is Tailwind v4's own published indigo-600 swatch).
      expect(bg).toBe("oklch(0.511 0.262 276.966)"); // indigo-600
      expect(radius).not.toBe("0px");
    }).toPass({ timeout: 30_000 });

    await page.evaluate(async () => {
      const vite = (window as unknown as { __tw: { kill: () => void; exit: Promise<unknown> } }).__tw;
      vite.kill();
      await vite.exit;
    });
  });
});

test.describe("Angular feasibility probe", () => {
  // SCOPING PROBE, not yet a Studio template. vivari's own Angular recipe needs a Rolldown-WASM
  // binding wcvm doesn't have; re-investigated directly rather than trusting that inherited
  // assumption - @angular/build@22.2.0's own package.json does hard-depend on real `rolldown`, but
  // reading its actual source (chunk-optimizer.js, only called from execute-build.js when
  // lazyChunksCount >= optimizeChunksThreshold, default 3) shows it's an OPTIONAL, lazily-
  // require()'d production chunk-merging pass - environment-options.js documents a public
  // NG_BUILD_OPTIMIZE_CHUNKS=false escape hatch (threshold -> Infinity) that skips it entirely, so
  // require("rolldown") never executes at all. wcvm's npm also has no general `npx`/`npm exec`
  // support (only install/run/create/init) - @angular/cli's own "ng new" isn't reachable via
  // `npm create` (no create-angular initializer package), so it's installed as an ordinary
  // dependency and its own bin script run directly via node, the same pattern every other
  // hand-wired template already uses for vite itself.
  // Real findings, from reading the real published source of every package involved directly -
  // not assumed - and testing each fix against the real CLI, one real error at a time:
  // - `require("yargs/helpers")` (a genuine CJS file, @angular/cli's own command-module.js)
  //   against `yargs@18` (the version @angular/cli@22.2.0 actually depends on) threw a SyntaxError
  //   - confirmed this is NOT a wcvm bug: yargs@18 is real ESM-only (`"./helpers":
  //   "./helpers/helpers.mjs"`, no "require" condition at all in its own package.json exports),
  //   and real Node 24 only bridges this via its own `require(esm)` synchronous interop (verified
  //   directly: `require("yargs/helpers")` really does work in real Node 24 against real yargs@18)
  //   - a feature wcvm's own CJS loader doesn't implement. `yargs@17.7.2` (the last major before
  //   the ESM-only jump) has a real, proper dual CJS/ESM "./helpers" export
  //   (`"require": "./helpers/index.js"`) - overriding to it is the same `overrides` trick already
  //   used for esbuild/rollup/lightningcss elsewhere, and @angular/cli's own use of it (just
  //   `hideBin`) is stable across that version gap.
  // - `node:assert/strict` wasn't vendored at all - a real, narrow wcvm gap (not
  //   Angular-specific), fixed the standard way (discover-node-lib.mjs, see CLAUDE.md's Status).
  // - `npm --version`/`-v` weren't implemented by wcvm's own minimal npm at all - @angular/cli's
  //   own package-manager detection (src/package-managers/factory.ts) spawns exactly this via
  //   child_process to confirm npm is "installed" - not a PATH-resolution problem (wcvm's built-in
  //   npm was already found and run just fine via child_process), just this one missing flag,
  //   which surfaced as a misleading "npm ... cannot be found in the PATH" error. Fixed in
  //   programs/npm/npm.ts.
  // - `ng new` (unlike `ng version`) pulls in real schematics execution, which surfaced the exact
  //   same require(esm) gap again, this time inside @angular-devkit/schematics's own CJS
  //   (recorder.js: real "use strict"/exports.-style CJS, `require("magic-string")`) - confirmed by
  //   reading the actual published source, not assumed. magic-string@1.4.1 (the exact version
  //   schematics@22.2.0 depends on) is real ESM-only ("type":"module", single "." export, no
  //   "require" condition at all); magic-string@0.30.x still has a real, proper dual CJS/ESM export
  //   map and the same stable MagicString API surface (.appendLeft/.appendRight/.remove/.original/
  //   .toString()) recorder.js actually calls. A proactive sweep of @angular/cli@22.2.0's other
  //   direct deps for the same "type":"module" + no "require" condition shape (checked against
  //   real published package.json "exports", not guessed) found three more ESM-only-only-in-their-
  //   latest-major packages that a full `ng new` run risks eagerly require()'ing even where
  //   --defaults/--skip-install/--skip-git skip their actual FEATURE (prompts, spinners): a
  //   dependency being unused by the CODE PATH doesn't mean its module isn't require()'d at load
  //   time - the same "eager router construction" shape child_process.ts's own gotcha already
  //   established. Each has a real, still-dual-CJS/ESM last-major-before-the-ESM-only-jump version:
  //   @inquirer/prompts (ESM-only from 8.x; 7.10.1 is dual), ora (ESM-only from 6.x; 5.4.1 is dual,
  //   no "exports" field at all), parse5-html-rewriting-stream (ESM-only from 7.x; 6.0.1 is dual).
  const NG_CLI_OVERRIDES = {
    yargs: "^17.7.2",
    "magic-string": "^0.30.19",
    "@inquirer/prompts": "^7.10.1",
    ora: "^5.4.1",
    "parse5-html-rewriting-stream": "^6.0.1",
  };

  test("ng version runs for real (@angular/cli installs and its own CLI actually runs)", async ({ page }) => {
    test.skip(!process.env.WCVM_E2E_VITE, "opt-in: set WCVM_E2E_VITE=1 (installs from registry.npmjs.org)");
    test.setTimeout(120_000);

    await page.evaluate(
      async (overrides) => {
        const { fs } = (window as unknown as WcWindow).wc;
        await fs.mkdir("/ng-probe", { recursive: true });
        await fs.writeFile(
          "/ng-probe/package.json",
          JSON.stringify({ name: "ng-probe", private: true, devDependencies: { "@angular/cli": "22.2.0" }, overrides }),
        );
      },
      NG_CLI_OVERRIDES,
    );

    const install = await spawn(page, "npm", ["install"], "/ng-probe");
    expect(install.code, install.out + install.err).toBe(0);

    const version = await spawn(page, "node", ["node_modules/@angular/cli/bin/ng.js", "version"], "/ng-probe");
    expect(version.code, version.out + version.err).toBe(0);
    expect(version.out).toContain("Angular CLI");
    expect(version.out).toContain("22.2.0");
  });

  test("ng new scaffolds a real app (schematics, no install/git)", async ({ page }) => {
    test.skip(!process.env.WCVM_E2E_VITE, "opt-in: set WCVM_E2E_VITE=1 (installs from registry.npmjs.org)");
    test.setTimeout(120_000);

    await page.evaluate(
      async (overrides) => {
        const { fs } = (window as unknown as WcWindow).wc;
        await fs.mkdir("/ng-cli", { recursive: true });
        await fs.writeFile(
          "/ng-cli/package.json",
          JSON.stringify({ name: "ng-cli", private: true, devDependencies: { "@angular/cli": "22.2.0" }, overrides }),
        );
      },
      NG_CLI_OVERRIDES,
    );
    const install = await spawn(page, "npm", ["install"], "/ng-cli");
    expect(install.code, install.out + install.err).toBe(0);

    const created = await spawn(
      page,
      "node",
      ["ng-cli/node_modules/@angular/cli/bin/ng.js", "new", "ng-new-app", "--skip-git", "--skip-install", "--defaults"],
      "/",
    );
    expect(created.code, created.out + created.err).toBe(0);

    const files = await page.evaluate(async () => {
      const { fs } = (window as unknown as WcWindow).wc;
      return fs.readdir("/ng-new-app");
    });
    expect(files).toContain("package.json");
    expect(files).toContain("angular.json");
  });

  // The scaffolded app's OWN package.json depends on @angular/build, which pulls in a much bigger
  // native-dependency tree than the CLI itself - checked against the real published package.json
  // of every one of @angular/build@22.2.0's direct dependencies (npm view, not assumed):
  // - vite: pinned EXACTLY to "8.3.0", which (like every other real-scaffold template here -
  //   vitePins.ts's own VITE_PIN comment) hard-depends on real `rolldown` with no wasm32 build
  //   published at all (confirmed: `npm view rolldown@1.2.8 optionalDependencies` lists only real
  //   OS/arch native bindings). Overridden down to vitePins.ts's own VITE_PIN (7.3.6, the same
  //   version every other template already uses) - the same trick, applied to a new consumer.
  // - esbuild: pinned exactly to "0.28.2" - esbuild-wasm@0.28.2 (the exact matching version) is
  //   real and published; same swap-the-package-name trick as every other template's esbuild
  //   override.
  // - sass-embedded: real native Dart-compiled platform binaries selected via optionalDependencies
  //   os/cpu gating - but ALSO ships its own real pure-JS fallback variant
  //   (sass-embedded-all-unknown, cpu: ["!arm","!arm64","!riscv64","!x64"]) that install.ts's
  //   existing PLATFORM={cpu:"wasm32"} fakery already selects "for free", no override needed -
  //   confirmed directly against the real published package.json, not assumed.
  // - @parcel/watcher: real native file-watcher binding, no wasm32 optionalDependency variant of
  //   its own - but @parcel/watcher-wasm@2.6.0 (exact matching version) is a real, separately-
  //   published drop-in with a proper dual CJS/ESM export map of its own. Overridden the same way
  //   as lightningcss/esbuild/rollup elsewhere.
  // - oxc-parser: real native parser binding. A `@oxc-parser/binding-wasm32-wasi` DOES exist on the
  //   registry at the exact matching version (0.150.0) - oxc-parser@0.150.0 itself just stopped
  //   listing it as an optionalDependency (older 0.6x-0.14x versions did) - but per the deadlock
  //   finding below, it's a dead end for this app's dev-serve path regardless, so it's neither
  //   installed nor patched in here.
  // - listr2: pinned exactly to "11.1.0" - a SUBTLER variant of the require(esm) gap: its own
  //   package.json "exports" DOES have a "require" condition (unlike magic-string's), but that
  //   condition points at the exact same real ESM ".mjs" file as "import" does (a "fake dual"
  //   package, confirmed directly via `npm view listr2@11.1.0 exports` - not a genuine separate
  //   CJS build). Checking every 10.x version individually (not just the latest, which was the
  //   first real mistake here) shows the SAME fake-dual shape starting at 10.1.0 - only 10.0.0
  //   itself still has a real, separate ".cjs" build; that exact version is the override target.
  // - vite itself: unlike every other override above, there is NO version of vite (any major) that
  //   isn't real ESM-only ("type":"module" - true since long before Angular 22 existed), so no
  //   override can fix this. @angular/build's own dev-server needs PROGRAMMATIC access to vite's
  //   API (createServer, etc), not just to spawn its CLI bin script the way every other template
  //   here does - confirmed directly in its published, compiled source
  //   (builders/dev-server/vite/{index,server}.js, tools/vite/plugins/{angular-memory,ssr-
  //   transform}-plugin.js): each does `await import('vite')`, which its CommonJS build target
  //   downlevels to `Promise.resolve(\`${'vite'}\`).then(s => __importStar(require(s)))` - still a
  //   real require() under the hood, still hitting the same gap. Real dynamic `import()` from CJS
  //   IS genuinely supported here (see CLAUDE.md's Status) - the fix is a source patch (same idea
  //   as tailwindTemplateProject.ts's patchTailwindVitePlugin): rewrite that exact downleveled
  //   expression back into a real `import('vite')`. The SAME idea, but a SECOND compiled shape
  //   (`Promise.resolve().then(() => __importStar(require('pkg')))` - no template-string wrapper,
  //   a zero-arg arrow, confirmed by reading `javascript-transformer-worker.js`'s own compiled
  //   source directly) appears for the "Babel linker" path's own lazy load of
  //   `@angular/compiler-cli/linker/babel`, `@angular/compiler-cli` and `@babel/core` - a REAL,
  //   PUBLIC escape hatch (`NG_BUILD_BABEL_LINKER=1`, `environment-options.js`'s own
  //   `useBabelLinker`) that routes Angular's own partial-compilation linking through Babel instead
  //   of its newer OXC-based linker - which matters because OXC's own linker needs `oxc-parser`,
  //   a REAL NATIVE WASM parser (`@napi-rs/wasm-runtime`-based, the exact same architecture already
  //   proven, in this project's own PLAN.md, to DEADLOCK on any single native call whose input
  //   spans more than one line (the Tailwind `Scanner.scanFiles()` finding) - PLAN.md's own
  //   writeup explicitly warns this generalizes to "any OTHER future napi-rs[-based binding]" this
  //   way, and a JS parser fundamentally cannot be fed one line at a time (unlike Tailwind's
  //   decomposable class-name scan) - so oxc-parser's `parseSync(filename, code, ...)`, called with
  //   an entire real source file as `code`, is a genuine, structural dead end here, not a "hasn't
  //   been patched yet" gap. Babel has no native/WASM component at all, so it carries none of that
  //   risk - hence routing around OXC entirely rather than trying to fix it. A default `ng new
  //   --defaults` app has no @angular/ssr dependency (SSR isn't the default), so the other
  //   downleveled dynamic imports found in the same source (`@angular/ssr/node`,
  //   `beasties/compiler`, a user's `--proxy-config` path, ...) are dead code for this probe and
  //   deliberately left unpatched.
  const NG_APP_OVERRIDES = {
    ...NG_CLI_OVERRIDES,
    vite: "7.3.6",
    esbuild: "npm:esbuild-wasm@0.28.2",
    "@parcel/watcher": "npm:@parcel/watcher-wasm@2.6.0",
    listr2: "10.0.0",
  };

  /** Walks `root` (real fs, inside the sandbox) and rewrites every real-CJS file that downlevels a
   *  real `await import('pkg')` into a `require()` call (see the doc comment above - TWO different
   *  compiled shapes are known) back into a real dynamic `import()`. Unconditional over ANY package
   *  name found this way (not just the ones this probe cares about) - real dynamic `import()` here
   *  works for a CJS target too (see CLAUDE.md's Status), so this is never a regression, only ever a
   *  fix. Runs INSIDE the page (via page.evaluate at the call site) - this function's own source is
   *  serialized across, so it must be self-contained (no closured references). */
  async function patchAngularBuildDynamicRequires(root: string): Promise<string[]> {
    const { fs } = (window as unknown as WcWindow).wc;
    const patterns: [RegExp, string][] = [
      [/Promise\.resolve\(`\$\{'([^']+)'\}`\)\.then\(s => __importStar\(require\(s\)\)\)/g, "Promise.resolve(import('$1')).then(s => __importStar(s))"],
      [/Promise\.resolve\(\)\.then\(\(\) => __importStar\(require\('([^']+)'\)\)\)/g, "Promise.resolve(import('$1')).then((s) => __importStar(s))"],
    ];
    const patched: string[] = [];
    const walk = async (dir: string): Promise<void> => {
      for (const entry of await fs.readdir(dir)) {
        const full = `${dir}/${entry}`;
        const st = await fs.stat(full);
        if (st.kind === "dir") {
          await walk(full);
        } else if (entry.endsWith(".js")) {
          const text = new TextDecoder().decode(await fs.readFile(full));
          let next = text;
          for (const [pattern, replacement] of patterns) next = next.replace(pattern, replacement);
          if (next !== text) {
            await fs.writeFile(full, next);
            patched.push(full);
          }
        }
      }
    };
    await walk(root);
    return patched;
  }

  // A DEEPER instance of the same gap, found only once `ng build`/`ng serve` actually reach real
  // JS-transform work: `tools/javascript-transformer/javascript-transformer-worker.js` (a real
  // piscina worker-thread entry - confirmed via its own stack trace, `piscina/dist/worker.js`'s
  // `importESMCached`/`getHandler`) requires `tools/oxc/oxc-transform.js` UNCONDITIONALLY at its
  // own module top level, and oxc-transform.js's OWN top level does a PLAIN `require("oxc-parser")`
  // (real ESM-only, confirmed: `"type":"module"`, single non-conditional "main", no CJS build at
  // any version at all - unlike magic-string/listr2) and `require("@angular/compiler-cli/linker")`
  // (also real ESM-only). Worse, oxc-transform.js TRANSITIVELY requires two more local files with
  // the exact same problem at THEIR OWN top level (tools/angular/linker/oxc-linker.js requires
  // "@angular/compiler-cli" AND "@angular/compiler-cli/linker"; oxc-ast-host.js requires
  // "@angular/compiler-cli/linker" again) - and even past all of THAT, oxc-transform.js's own
  // `transform()` calls `oxc-parser`'s `parseSync(filename, code, ...)` on an ENTIRE real source
  // file - a real native WASM parser (`@napi-rs/wasm-runtime`-based), the exact architecture this
  // project's own PLAN.md already proved DEADLOCKS on any single native call whose input spans more
  // than one line (the Tailwind `Scanner.scanFiles()` finding, explicitly flagged there as
  // generalizing to "any OTHER future napi-rs[-based binding]") - and a JS parser fundamentally
  // cannot be fed one line at a time the way Tailwind's class-name scan could. So even fixing every
  // require in this chain would just trade a crash for a hang.
  // First attempted a require() INTERCEPTOR (monkeypatching `node:module`'s `Module.prototype.
  // require`, the mechanism real tools like babel-register/pirates use in real Node) to redirect
  // these three specifiers to pre-warmed real `import()`s - proven, with a small standalone probe
  // (no Angular involved), that this DOESN'T intercept anything here: wcvm's own `require()` is
  // its own hand-written dispatch (`req`/`load`/`resolve`/`compile`, visible in every blob: stack
  // trace throughout this file) layered on top of - not routed through - the vendored `Module`
  // class, so mutating its prototype is a no-op for what guest code's own injected `require`
  // actually calls.
  // The fix that actually works needs neither a monkeypatch nor fixing oxc-parser's own deadlock:
  // `oxc_transform_js_1.transform()` has exactly ONE call site (inside the
  // `if (oxcLink || advancedOptimizations)` branch of transformJavaScriptImpl), and for a plain dev
  // `ng serve` with NG_BUILD_BABEL_LINKER=1 (oxcLink=false) and no production
  // advancedOptimizations (module-level, defaults false, off for `serve`), that branch is NEVER
  // ENTERED - meaning oxc-transform.js's own require is never actually reached IF it's moved from
  // the file's top level into that specific branch instead. A plain `require()` call has no special
  // hoisting semantics - moving it doesn't change anything about how it works, just WHEN (and
  // whether) it runs - so this sidesteps the entire chain (oxc-parser's deadlock included) rather
  // than trying to fix any part of it, for exactly the scenario this probe cares about (a dev
  // server, not a production optimizing build).
  async function patchJavascriptTransformerLazyOxc(root: string): Promise<boolean> {
    const { fs } = (window as unknown as WcWindow).wc;
    const workerPath = `${root}/src/tools/javascript-transformer/javascript-transformer-worker.js`;
    const topLevelNeedle = 'const oxc_transform_js_1 = require("../oxc/oxc-transform.js");\n';
    const callSiteNeedle = "const result = (0, oxc_transform_js_1.transform)(filename, code, {";
    const callSiteReplacement = 'const oxc_transform_js_1 = require("../oxc/oxc-transform.js");\n        const result = (0, oxc_transform_js_1.transform)(filename, code, {';

    const source = new TextDecoder().decode(await fs.readFile(workerPath));
    const applicable = source.includes(topLevelNeedle) && source.includes(callSiteNeedle);
    if (applicable) {
      const patched = source.replace(topLevelNeedle, "").replace(callSiteNeedle, callSiteReplacement);
      await fs.writeFile(workerPath, patched);
    }
    return applicable;
  }

  // Isolates the leading theory for `ng serve`'s own "instant, silent, clean exit(0)" symptom,
  // stripped of every bit of Angular/npm-install complexity: bin/ng.js's own top-level body is
  // `void import('../lib/init.js')` (bootstrap.js) - a real dynamic import with no `.catch()` and
  // nothing else in the script to keep the event loop alive while it resolves. If this sandbox's
  // event loop doesn't REF itself for an in-flight top-level dynamic import the way it already
  // has to for a connecting TCP socket or a `fs.watch()` (see CLAUDE.md's own gotchas for both),
  // the whole process could go idle and fire `beforeExit`/`exit` before the import ever settles -
  // exactly matching what was observed. Two local files, no registry, no npm install.
  test("a bare top-level `void import(...)` keeps the process alive until it resolves", async ({ page }) => {
    const result = await page.evaluate(async () => {
      const { fs } = (window as unknown as WcWindow).wc;
      await fs.mkdir("/import-repro", { recursive: true });
      await fs.writeFile("/import-repro/late.mjs", "console.log('late module ran');\n");
      await fs.writeFile("/import-repro/main.js", "void import('./late.mjs');\n");
      const wc = (window as unknown as WcWindow).wc;
      const proc = await wc.spawn("node", ["main.js"], { cwd: "/import-repro" });
      const [out, err, exit] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exit]);
      return { code: exit.exitCode, out, err };
    });
    console.log("DEBUG bare void-import repro out:", result.out);
    console.log("DEBUG bare void-import repro err:", result.err);
    console.log("DEBUG bare void-import repro code:", result.code);
    expect(result.out, result.out + result.err).toContain("late module ran");
  });

  test("ng new + npm install + ng serve (real Angular dev server)", async ({ page }) => {
    test.skip(!process.env.WCVM_E2E_VITE, "opt-in: set WCVM_E2E_VITE=1 (installs from registry.npmjs.org)");
    test.setTimeout(300_000);
    page.on("console", (msg) => console.log("DEBUG page console:", msg.type(), msg.text()));
    page.on("pageerror", (error) => console.log("DEBUG pageerror:", error.message, error.stack));

    await page.evaluate(
      async (overrides) => {
        const { fs } = (window as unknown as WcWindow).wc;
        await fs.mkdir("/ng-cli2", { recursive: true });
        await fs.writeFile(
          "/ng-cli2/package.json",
          JSON.stringify({ name: "ng-cli2", private: true, devDependencies: { "@angular/cli": "22.2.0" }, overrides }),
        );
      },
      NG_CLI_OVERRIDES,
    );
    const cliInstall = await spawn(page, "npm", ["install"], "/ng-cli2");
    expect(cliInstall.code, cliInstall.out + cliInstall.err).toBe(0);

    const created = await spawn(
      page,
      "node",
      ["ng-cli2/node_modules/@angular/cli/bin/ng.js", "new", "ng-serve-app", "--skip-git", "--skip-install", "--defaults"],
      "/",
    );
    expect(created.code, created.out + created.err).toBe(0);

    await page.evaluate(
      async (overrides) => {
        const { fs } = (window as unknown as WcWindow).wc;
        const raw = new TextDecoder().decode(await fs.readFile("/ng-serve-app/package.json"));
        const pkg = JSON.parse(raw);
        pkg.overrides = { ...pkg.overrides, ...overrides };
        await fs.writeFile("/ng-serve-app/package.json", JSON.stringify(pkg, null, 2));
      },
      NG_APP_OVERRIDES,
    );

    const appInstall = await spawn(page, "npm", ["install"], "/ng-serve-app");
    expect(appInstall.code, appInstall.out + appInstall.err).toBe(0);

    const dynamicRequirePatched = await page.evaluate(patchAngularBuildDynamicRequires, "/ng-serve-app/node_modules/@angular/build");
    console.log("DEBUG dynamic-require patched files:", JSON.stringify(dynamicRequirePatched));

    const oxcLazyPatched = await page.evaluate(patchJavascriptTransformerLazyOxc, "/ng-serve-app/node_modules/@angular/build");
    console.log("DEBUG lazy-oxc patch applied:", oxcLazyPatched);

    // NG_BUILD_BABEL_LINKER routes Angular's own partial-compilation linking through Babel instead
    // of the OXC-based linker's own oxc-parser (a real native WASM parser that deadlocks here on
    // any real, multi-line source file - see the doc comment above) - for a dev `ng serve` (no
    // production `advancedOptimizations`), this avoids calling into oxc-parser's own parseSync at
    // all, sidestepping the deadlock rather than fixing it (a genuinely unfixed, structural gap).
    const ngEnv = { NG_BUILD_OPTIMIZE_CHUNKS: "false", NG_BUILD_BABEL_LINKER: "true" };

    // `ng serve` was observed exiting almost instantly with code 0 and NOT ONE byte on either
    // stream - not even the very first listr2-rendered "Building..." line a real local run (real
    // Node 24.18.0, verified directly) always prints immediately. bin/ng.js's own bootstrap.js
    // does `void import('../lib/init.js')` - a real dynamic import with NO `.catch()` at all -
    // meaning if anything anywhere in the whole CLI's own module graph rejects, it becomes a
    // genuinely unhandled rejection with no guarantee this sandbox's own top-level handling (proven
    // to work in Vitest for the MAIN thread - runtime.test.ts's own "unhandled rejection" test)
    // also covers whatever specific async context this happens in. Wrapping the entry point in an
    // explicit trap installed BEFORE requiring it - rather than trying to trace every layer of
    // Angular's own source to find the exact silent-drop point - forces visibility either way.
    await page.evaluate(async () => {
      const { fs } = (window as unknown as WcWindow).wc;
      await fs.writeFile(
        "/ng-serve-app/__ng_trap.js",
        [
          "console.log('WCVM_TRAP: alive, argv=' + JSON.stringify(process.argv));",
          "process.on('exit', (code) => { console.log('WCVM_TRAP: process exit event, code=' + code); });",
          "process.on('beforeExit', (code) => { console.log('WCVM_TRAP: beforeExit event, code=' + code); });",
          "process.on('unhandledRejection', (reason) => { console.error('WCVM_TRAP unhandledRejection:', reason && reason.stack ? reason.stack : reason); });",
          "process.on('uncaughtException', (error) => { console.error('WCVM_TRAP uncaughtException:', error && error.stack ? error.stack : error); });",
          "console.log('WCVM_TRAP: about to require ng.js');",
          "require('./node_modules/@angular/cli/bin/ng.js');",
          "console.log('WCVM_TRAP: require of ng.js returned synchronously');",
        ].join("\n"),
      );

      // Direct tracing INSIDE @angular/cli's own async chain (lib/init.js) - the IIFE that
      // resolves the local `cli` module, then `.then(cli => cli?.({cliArgs}))` (the actual command
      // dispatch), then a final `.then`/`.catch`. Pinpoints exactly how far execution gets before
      // things go quiet, rather than continuing to guess.
      const initPath = "/ng-serve-app/node_modules/@angular/cli/lib/init.js";
      const initSource = new TextDecoder().decode(await fs.readFile(initPath));
      const patched = initSource
        .replace(
          ".then((cli) => cli?.({\n    cliArgs: process.argv.slice(2),\n}))",
          ".then((cli) => { console.error('WCVM_TRAP: got cli =', typeof cli, '- calling now'); return cli?.({\n    cliArgs: process.argv.slice(2),\n}); })",
        )
        .replace(
          ".then((exitCode = 0) => {\n    if (forceExit) {",
          ".then((exitCode = 0) => {\n    console.error('WCVM_TRAP: cli() resolved, exitCode =', exitCode);\n    if (forceExit) {",
        )
        .replace(
          ".catch((err) => {\n    // eslint-disable-next-line  no-console\n    console.error('Unknown error: ' + err.toString());",
          ".catch((err) => {\n    console.error('WCVM_TRAP: caught in chain:', err && err.stack ? err.stack : err);\n    // eslint-disable-next-line  no-console\n    console.error('Unknown error: ' + err.toString());",
        );
      await fs.writeFile(initPath, patched);

      // `@angular/cli`'s own main entry (lib/cli/index.js) REDIRECTS console.log/warn/error into an
      // RxJS-observable-backed `IndentLogger` right before dispatching the real command - flushed
      // asynchronously via `logger.forEach(...)`'s own subscription, awaited in a `finally` block
      // only at the very end. Testing directly whether THAT redirection/flush pipeline is what's
      // swallowing output: patch it out so console.log/error stay real for this one run.
      const cliIndexPath = "/ng-serve-app/node_modules/@angular/cli/lib/cli/index.js";
      const cliIndexSource = new TextDecoder().decode(await fs.readFile(cliIndexPath));
      const cliIndexPatched = cliIndexSource
        .replace(
          "    // Redirect console to logger\n    console.info = console.log = function (...args) {\n        logger.info((0, node_util_1.format)(...args));\n    };\n    console.warn = function (...args) {\n        logger.warn((0, node_util_1.format)(...args));\n    };\n    console.error = function (...args) {\n        logger.error((0, node_util_1.format)(...args));\n    };",
          "    process.stderr.write('WCVM_TRAP: console redirection disabled for this probe\\n');",
        )
        .replace(
          "    try {\n        return await (0, command_runner_1.runCommand)(options.cliArgs, logger);\n    }",
          "    try {\n        process.stderr.write('WCVM_TRAP: about to call runCommand\\n');\n        const __wcvmResult = (0, command_runner_1.runCommand)(options.cliArgs, logger);\n        process.stderr.write('WCVM_TRAP: runCommand() called, got a ' + typeof __wcvmResult + (__wcvmResult && typeof __wcvmResult.then === 'function' ? ' thenable' : '') + '\\n');\n        const __wcvmAwaited = await __wcvmResult;\n        process.stderr.write('WCVM_TRAP: runCommand() resolved with ' + JSON.stringify(__wcvmAwaited) + '\\n');\n        return __wcvmAwaited;\n    }",
        );
      const cliIndexApplicable = cliIndexPatched !== cliIndexSource;
      await fs.writeFile(cliIndexPath, cliIndexPatched);
      console.log("DEBUG cli-index console-redirect patch applied:", cliIndexApplicable);

      // runCommand()'s own promise never settles - narrowing further: its FIRST real async work is
      // reading workspace config (`getWorkspace('local'/'global')`), then `createPackageManager()`
      // (already known, from earlier in this probe, to spawn `npm --version` via child_process to
      // confirm npm is "installed"). Tracing both boundaries directly.
      const runnerPath = "/ng-serve-app/node_modules/@angular/cli/src/command-builder/command-runner.js";
      const runnerSource = new TextDecoder().decode(await fs.readFile(runnerPath));
      const runnerPatched = runnerSource
        .replace(
          "    try {\n        [workspace, globalConfiguration] = await Promise.all([\n            (0, config_1.getWorkspace)('local'),\n            (0, config_1.getWorkspace)('global'),\n        ]);\n    }",
          "    try {\n        process.stderr.write('WCVM_TRAP: about to read workspace config\\n');\n        [workspace, globalConfiguration] = await Promise.all([\n            (0, config_1.getWorkspace)('local'),\n            (0, config_1.getWorkspace)('global'),\n        ]);\n        process.stderr.write('WCVM_TRAP: workspace config read OK\\n');\n    }",
        )
        .replace(
          "    const packageManager = await (0, package_managers_1.createPackageManager)({",
          "    process.stderr.write('WCVM_TRAP: about to createPackageManager\\n');\n    const packageManager = await (0, package_managers_1.createPackageManager)({",
        )
        .replace(
          "    const localYargs = (0, yargs_1.default)(args);",
          "    process.stderr.write('WCVM_TRAP: createPackageManager resolved OK\\n');\n    const localYargs = (0, yargs_1.default)(args);",
        )
        .replace(
          "    for (const CommandModule of await getCommandsToRegister(positional[0])) {\n        (0, command_1.addCommandModuleToYargs)(CommandModule, context);\n    }",
          "    process.stderr.write('WCVM_TRAP: about to getCommandsToRegister\\n');\n    for (const CommandModule of await getCommandsToRegister(positional[0])) {\n        (0, command_1.addCommandModuleToYargs)(CommandModule, context);\n    }\n    process.stderr.write('WCVM_TRAP: commands registered with yargs\\n');",
        )
        .replace(
          "    await localYargs\n        .scriptName('ng')",
          "    process.stderr.write('WCVM_TRAP: about to run yargs parseAsync chain\\n');\n    await localYargs\n        .scriptName('ng')",
        )
        .replace(
          "        .wrap(localYargs.terminalWidth())\n        .parseAsync();\n    return +(process.exitCode ?? 0);",
          "        .wrap(localYargs.terminalWidth())\n        .parseAsync();\n    process.stderr.write('WCVM_TRAP: yargs parseAsync chain resolved\\n');\n    return +(process.exitCode ?? 0);",
        );
      const runnerApplicable = runnerPatched !== runnerSource;
      await fs.writeFile(runnerPath, runnerPatched + "\n// WCVM_TRAP: patch applied end marker\n");
      console.log("DEBUG command-runner trace patch applied:", runnerApplicable);
    });

    const served = await page.evaluate(async (env) => {
      const wc = (window as unknown as WcWindow).wc;
      const proc = await wc.spawn("node", ["__ng_trap.js", "serve", "--port", "4300"], { cwd: "/ng-serve-app", env });
      const [out, err, exit] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exit]);
      return { code: exit.exitCode, out, err };
    }, ngEnv);
    console.log("DEBUG ng serve out:", served.out);
    console.log("DEBUG ng serve err:", served.err);
    console.log("DEBUG ng serve code:", served.code);

    expect(served.out + served.err, served.out + served.err).toContain("Application bundle generation complete");
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

  test("fs.reset() clears the persisted copy too, so a reload starts empty", async ({ page }) => {
    const root = `e2e-persist-${Date.now()}-${Math.random().toString(36).slice(2)}`;

    await page.evaluate(async (persistRoot) => {
      const wc = (window as unknown as WcWindow).wcvmBoot({ persist: { root: persistRoot } });
      await wc.ready;
      await wc.fs.mkdir("/proj", { recursive: true });
      await wc.fs.writeFile("/proj/a.txt", "will be reset");
      await new Promise((resolve) => setTimeout(resolve, 300));
      await wc.fs.reset();
      // reset() answers synchronously against the vfs, same write-behind lag before OPFS itself
      // actually reflects the removal.
      await new Promise((resolve) => setTimeout(resolve, 300));
    }, root);

    await page.reload();
    await expect(page.locator("#app")).toHaveText("wcvm ready", { timeout: 15000 });

    const result = await page.evaluate(async (persistRoot) => {
      const wc = (window as unknown as WcWindow).wcvmBoot({ persist: { root: persistRoot } });
      await wc.ready;
      return wc.fs.readdir("/");
    }, root);

    expect(result).toEqual([]);
  });

  // OPT-IN: a real npm install (registry.npmjs.org), queuing far more OPFS writes than the other
  // tests' own single small file - proves wc.fs.sync() (not an arbitrary delay) is what actually
  // makes "reload right after a big write finishes" safe. Confirmed this fails without sync():
  // temporarily removing the call below drops from 2 mirrored node_modules files to 1 on reload,
  // the exact race sync() exists to close.
  test("wc.fs.sync() makes a real npm install's files survive a reload with no other delay", async ({ page }) => {
    test.skip(!process.env.WCVM_E2E_VITE, "opt-in: set WCVM_E2E_VITE=1 (installs a real package from registry.npmjs.org)");
    test.setTimeout(60_000);
    const root = `e2e-persist-sync-${Date.now()}-${Math.random().toString(36).slice(2)}`;

    const countFiles = `async function countFiles(wc, path) {
      if (!(await wc.fs.exists(path))) return 0;
      let count = 0;
      for (const name of await wc.fs.readdir(path)) {
        const full = path + "/" + name;
        const stat = await wc.fs.stat(full);
        count += stat.kind === "directory" ? await countFiles(wc, full) : 1;
      }
      return count;
    }`;

    const before = await page.evaluate(
      async ({ persistRoot, countFilesSrc }) => {
        const countFiles = new Function(`return ${countFilesSrc}`)();
        const wc = (window as unknown as WcWindow).wcvmBoot({ persist: { root: persistRoot } });
        await wc.ready;
        await wc.fs.mkdir("/proj", { recursive: true });
        await wc.fs.writeFile("/proj/package.json", JSON.stringify({ name: "sync-e2e", private: true, dependencies: { "is-odd": "^3.0.1" } }));
        const install = await wc.spawn("npm", ["install"], { cwd: "/proj" });
        await Promise.all(
          [install.stdout, install.stderr].map(async (stream: ReadableStream<Uint8Array>) => {
            const reader = stream.getReader();
            for (;;) {
              const { done } = await reader.read();
              if (done) return;
            }
          }),
        );
        const exit = await install.exit;
        await wc.fs.sync(); // the fix - no other delay follows
        return { exitCode: exit.exitCode, fileCount: await countFiles(wc, "/proj/node_modules") };
      },
      { persistRoot: root, countFilesSrc: countFiles },
    );
    expect(before.exitCode).toBe(0);
    expect(before.fileCount).toBeGreaterThan(0);

    await page.reload();
    await expect(page.locator("#app")).toHaveText("wcvm ready", { timeout: 15000 });

    const after = await page.evaluate(
      async ({ persistRoot, countFilesSrc }) => {
        const countFiles = new Function(`return ${countFilesSrc}`)();
        const wc = (window as unknown as WcWindow).wcvmBoot({ persist: { root: persistRoot } });
        await wc.ready;
        return countFiles(wc, "/proj/node_modules");
      },
      { persistRoot: root, countFilesSrc: countFiles },
    );
    expect(after).toBe(before.fileCount);
  });

  // OPT-IN: a real npm install of a package with a real bin (cowsay) - proves npm's own
  // bin-linking symlink (node_modules/.bin/cowsay) survives a reload and still actually runs
  // afterward, not just that it's present. This is the real regression a Studio user hit: `npm run
  // dev` worked, a reload happened, and the next `npm run dev` failed with a plain
  // "command not found" - the package itself was still there, only its bin symlink was gone (OPFS
  // itself has no symlinks; wcvm now tracks them in a small side-channel manifest instead - see
  // CLAUDE.md's "Status").
  test("a real npm install's bin symlink survives a reload and still runs afterward", async ({ page }) => {
    test.skip(!process.env.WCVM_E2E_VITE, "opt-in: set WCVM_E2E_VITE=1 (installs a real package with a bin from registry.npmjs.org)");
    test.setTimeout(60_000);
    const root = `e2e-persist-bin-${Date.now()}-${Math.random().toString(36).slice(2)}`;

    const before = await page.evaluate(async (persistRoot) => {
      const wc = (window as unknown as WcWindow).wcvmBoot({ persist: { root: persistRoot } });
      await wc.ready;
      await wc.fs.mkdir("/proj", { recursive: true });
      await wc.fs.writeFile("/proj/package.json", JSON.stringify({ name: "bin-e2e", private: true, dependencies: { cowsay: "^1.6.0" } }));
      const install = await wc.spawn("npm", ["install"], { cwd: "/proj" });
      await Promise.all(
        [install.stdout, install.stderr].map(async (stream: ReadableStream<Uint8Array>) => {
          const reader = stream.getReader();
          for (;;) {
            const { done } = await reader.read();
            if (done) return;
          }
        }),
      );
      const exit = await install.exit;
      const lstatKind = (await wc.fs.lstat("/proj/node_modules/.bin/cowsay")).kind;
      await wc.fs.sync();
      return { exitCode: exit.exitCode, lstatKind };
    }, root);
    expect(before.exitCode).toBe(0);
    expect(before.lstatKind).toBe("symlink");

    await page.reload();
    await expect(page.locator("#app")).toHaveText("wcvm ready", { timeout: 15000 });

    const after = await page.evaluate(async (persistRoot) => {
      const wc = (window as unknown as WcWindow).wcvmBoot({ persist: { root: persistRoot } });
      await wc.ready;
      const lstatKind = (await wc.fs.lstat("/proj/node_modules/.bin/cowsay")).kind;
      // The actual real-world check: run the bin through sh, exactly like `npm run <script>` would.
      const run = await wc.spawn("sh", ["-c", "node_modules/.bin/cowsay --help"], { cwd: "/proj" });
      const exit = await run.exit;
      return { lstatKind, runExitCode: exit.exitCode };
    }, root);

    expect(after.lstatKind).toBe("symlink");
    expect(after.runExitCode).toBe(0);
  });

  // A real, reproduced regression the symlink-manifest fix itself introduced: a page reload
  // interrupting a manifest write mid-flight left corrupted JSON in OPFS, and reading it back on
  // the next boot threw uncaught inside the FS Worker's own boot() - which never sent "ready", so
  // the whole kernel hung until the host's own 10s ERR_BOOT_TIMEOUT fired, with nothing pointing
  // at the real cause. Fixed by treating an unreadable manifest as "no known symlinks" (logged),
  // the same best-effort philosophy the rest of write-behind persistence already has - never able
  // to block booting at all.
  test("a corrupted symlink manifest in real OPFS no longer hangs boot", async ({ page }) => {
    test.setTimeout(30000);
    const root = `e2e-persist-corrupt-${Date.now()}-${Math.random().toString(36).slice(2)}`;

    await page.evaluate(async (persistRoot) => {
      const wc = (window as unknown as WcWindow).wcvmBoot({ persist: { root: persistRoot } });
      await wc.ready;
      await wc.fs.writeFile("/a.txt", "hello");
      await wc.fs.sync();

      const opfsRoot = await navigator.storage.getDirectory();
      const dir = await opfsRoot.getDirectoryHandle(persistRoot, { create: true });
      const fileHandle = await dir.getFileHandle("__wcvm_symlinks__.json", { create: true });
      const writable = await fileHandle.createWritable();
      await writable.write(new TextEncoder().encode('{"/link": "/a.tx')); // truncated, invalid JSON
      await writable.close();
    }, root);

    await page.reload();
    // The real regression was a 10s hang - a normal boot here (well under that) is the actual
    // assertion; expect()'s own timeout would otherwise mask exactly this failure mode.
    await expect(page.locator("#app")).toHaveText("wcvm ready", { timeout: 5000 });

    const fileStillThere = await page.evaluate(async (persistRoot) => {
      const wc = (window as unknown as WcWindow).wcvmBoot({ persist: { root: persistRoot } });
      await wc.ready;
      return new TextDecoder().decode(await wc.fs.readFile("/a.txt"));
    }, root);
    expect(fileStillThere).toBe("hello");
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

test.describe("example: Vite + Vue", () => {
  // The playground's #example-vue section (src/vueExample.ts): shares its actual run/stop/edit
  // machinery with the React example above via viteExample.ts - the second proof that pipeline is
  // generic. Also shares the one #preview-frame with the React example, so the two are mutually
  // exclusive: starting either one stops the other first.
  test("the example section is the Vue app, with App.vue ready to edit", async ({ page }) => {
    await expect(page.locator("#example-vue-label")).toContainText("Vite + Vue");
    await expect(page.locator("#example-vue-run")).toHaveText("run Vue example");
    await expect(page.locator("#example-vue-editor")).toHaveValue(/const count = ref\(0\)[\s\S]*count is \{\{ count \}\}/);
    await expect(page.locator("#example-vue-status")).toHaveText("Not running.");
  });

  // OPT-IN, like the React one: it installs Vue and Vite from the real registry.
  test("runs it end to end: install, Vite, the app in the preview, an edit hot-reloading, and starting React stops it (shared preview pane)", async ({ page }) => {
    test.skip(!process.env.WCVM_E2E_VITE, "opt-in: set WCVM_E2E_VITE=1 (installs Vue + Vite from registry.npmjs.org)");
    test.setTimeout(240_000);
    await page.click("#example-vue-run");
    await expect(page.locator("#example-vue-status")).toHaveText(/Vite is running on virtual port 5174/, { timeout: 180_000 });
    await expect(page.locator("#preview-frame")).toHaveAttribute("src", "/__wcvm_preview__/5174/");

    const frame = page.frameLocator("#preview-frame");
    const count = frame.locator("#count");
    await expect(count).toHaveText("count is 0", { timeout: 60_000 });
    await count.click();
    await count.click();
    await expect(count).toHaveText("count is 2");

    // Typing in the editor writes src/App.vue; Vite hot-updates the component in place.
    const edited = (await page.locator("#example-vue-editor").inputValue()).replace("<h1>Vite + Vue</h1>", "<h1>Edited live</h1>");
    await page.locator("#example-vue-editor").fill(edited);
    await expect(frame.locator("h1")).toHaveText("Edited live", { timeout: 30_000 });
    await expect(count).toHaveText("count is 2");

    // The four examples share the one preview pane - starting React stops Vue first, immediately
    // (before React's own install even begins), not just once React finishes starting.
    await page.click("#example-run");
    await expect(page.locator("#example-vue-status")).toHaveText("Stopped (switched to the React example).");
    await expect(page.locator("#example-vue-run")).toHaveText("run Vue example");
  });
});

test.describe("example: Node + Express", () => {
  // The playground's #example-express section (src/expressExample.ts): a plain `node server.js`
  // process installed from npm - no bundler/dev-server at all, and NOT Svelte: Svelte's own real
  // compiler has genuine circular static ESM imports (confirmed across svelte@5.0.0-5.57.1, so
  // it's structural, not a version-pinning problem), which wcvm's ESM loader can't support yet -
  // parked, see PLAN.md. Shares the one #preview-frame with the other examples (mutually
  // exclusive) but not viteExample.ts's own machinery: there's no HMR for a plain server, so every
  // edit restarts the whole process instead.
  test("the example section is the Express app, with server.js ready to edit", async ({ page }) => {
    await expect(page.locator("#example-express-label")).toContainText("Node + Express");
    await expect(page.locator("#example-express-run")).toHaveText("run Express example");
    await expect(page.locator("#example-express-editor")).toHaveValue(/app\.listen\(port/);
    await expect(page.locator("#example-express-status")).toHaveText("Not running.");
  });

  // OPT-IN, like the others: it installs Express from the real registry.
  test("runs it end to end: install, a real Express server in the preview, editing restarts it, and starting React stops it (shared preview pane)", async ({ page }) => {
    test.skip(!process.env.WCVM_E2E_VITE, "opt-in: set WCVM_E2E_VITE=1 (installs Express from registry.npmjs.org)");
    test.setTimeout(180_000);
    await page.click("#example-express-run");
    await expect(page.locator("#example-express-status")).toHaveText(/Express is running on virtual port 5176/, { timeout: 120_000 });
    await expect(page.locator("#preview-frame")).toHaveAttribute("src", "/__wcvm_preview__/5176/");

    const frame = page.frameLocator("#preview-frame");
    const count = frame.locator("#count");
    await expect(count).toHaveText("count is 0", { timeout: 30_000 });
    // No client JS at all - this button submits a real <form method="post">, a full navigation.
    await count.click();
    await expect(count).toHaveText("count is 1");
    await count.click();
    await expect(count).toHaveText("count is 2");

    // Editing server.js restarts the whole process (no HMR for a plain server) - the preview pane
    // blanks and re-renders once it relistens, and the in-memory counter resets to 0.
    const edited = (await page.locator("#example-express-editor").inputValue()).replace("<h1>Node + Express</h1>", "<h1>Edited live</h1>");
    await page.locator("#example-express-editor").fill(edited);
    await expect(frame.locator("h1")).toHaveText("Edited live", { timeout: 30_000 });
    await expect(count).toHaveText("count is 0");

    // The four examples share the one preview pane - starting React stops Express first.
    await page.click("#example-run");
    await expect(page.locator("#example-express-status")).toHaveText("Stopped (switched to the React example).");
    await expect(page.locator("#example-express-run")).toHaveText("run Express example");
  });
});

test.describe("example: npm create vite", () => {
  // The playground's #example-create section (src/createViteExample.ts): the direct showcase of
  // wcvm's own `npm create`/`npm exec` capability (programs/npm/exec.ts) - it scaffolds a REAL
  // project with `npm create vite@latest -- --template react-ts`, not a hand-written template
  // like the other examples, then shares their same install/run/edit machinery
  // (viteExample.ts) and the one shared preview pane (mutually exclusive with the others).
  test("the example section shows a placeholder until the real scaffold runs", async ({ page }) => {
    await expect(page.locator("#example-create-label")).toContainText("npm create vite@latest");
    await expect(page.locator("#example-create-run")).toHaveText("run Create Vite example");
    await expect(page.locator("#example-create-editor")).toHaveValue(/npm create vite@latest/);
    await expect(page.locator("#example-create-status")).toHaveText("Not running.");
  });

  // OPT-IN: installs create-vite itself, then React + Vite, all from the real registry.
  test("scaffolds, installs and runs a REAL project, seeds the editor from its real App.tsx, and starting Vue stops it", async ({ page }) => {
    test.skip(!process.env.WCVM_E2E_VITE, "opt-in: set WCVM_E2E_VITE=1 (installs create-vite, then React + Vite, from registry.npmjs.org)");
    test.setTimeout(240_000);
    await page.click("#example-create-run");
    await expect(page.locator("#example-create-status")).toHaveText(/Vite is running on virtual port 5175/, { timeout: 180_000 });
    await expect(page.locator("#preview-frame")).toHaveAttribute("src", "/__wcvm_preview__/5175/");

    // The editor was seeded from the real scaffolded src/App.tsx - real create-vite's own
    // default template, not anything wcvm wrote itself.
    await expect(page.locator("#example-create-editor")).toHaveValue(/function App/);
    await expect(page.locator("#example-create-editor")).not.toHaveValue(/npm create vite@latest/);

    const frame = page.frameLocator("#preview-frame");
    const counter = frame.locator("button.counter");
    await expect(counter).toHaveText("Count is 0", { timeout: 60_000 });
    await counter.click();
    await counter.click();
    await expect(counter).toHaveText("Count is 2");

    // Typing in the editor writes the real src/App.tsx; Vite hot-updates the component in place.
    const edited = (await page.locator("#example-create-editor").inputValue()).replace("<h1>Get started</h1>", "<h1>Edited live</h1>");
    await page.locator("#example-create-editor").fill(edited);
    await expect(frame.locator("h1")).toHaveText("Edited live", { timeout: 30_000 });
    await expect(counter).toHaveText("Count is 2");

    // All four examples share the one preview pane - starting Vue stops this one first.
    await page.click("#example-vue-run");
    await expect(page.locator("#example-create-status")).toHaveText("Stopped (switched to the Vue example).");
    await expect(page.locator("#example-create-run")).toHaveText("run Create Vite example");
  });

  // OPT-IN: create-vite's own REAL interactive prompts, driven by genuine Playwright keyboard
  // events (not synthetic stdin writes) - proves interactiveTerminal.ts's raw, unbuffered
  // keystroke forwarding really works through the actual UI, checked directly against a real
  // spawn beforehand (wcvm's vendored readline.emitKeypressEvents correctly decodes a forwarded
  // arrow-key escape sequence). Picks Vue - a different framework than the example's own default
  // (react-ts) - to also prove findEditableFile's own fallback (src/App.tsx doesn't exist for a
  // Vue scaffold) and the generalized version-pin logic (only known-safe pins are applied).
  test("interactive mode shows create-vite's own real prompts, driven by real keyboard input, and picking Vue scaffolds a real Vue app", async ({ page }) => {
    test.skip(!process.env.WCVM_E2E_VITE, "opt-in: set WCVM_E2E_VITE=1 (installs create-vite, then Vue + Vite, from registry.npmjs.org)");
    test.setTimeout(240_000);

    await page.check("#example-create-interactive");
    await page.click("#example-create-run");

    // The raw terminal attaches once create-vite's own process starts.
    await expect(page.locator("#example-create-terminal .xterm")).toBeVisible({ timeout: 60_000 });
    await page.waitForTimeout(2500); // let the first real prompt (framework list) actually render

    // Framework list order: Vanilla, Vue, React, ... - one Down press then Enter picks Vue.
    await page.keyboard.press("ArrowDown");
    await page.waitForTimeout(800);
    await page.keyboard.press("Enter");
    await page.waitForTimeout(1200);
    // Variant list: TypeScript (vue-ts) is first/default - just Enter. Vue has no ESLint/Oxlint
    // prompt (react-only), so scaffolding starts right after this.
    await page.keyboard.press("Enter");

    await expect(page.locator("#example-create-status")).toHaveText(/Vite is running on virtual port 5175/, { timeout: 180_000 });
    await expect(page.locator("#preview-frame")).toHaveAttribute("src", "/__wcvm_preview__/5175/");

    // The editor was seeded from the REAL scaffolded src/App.vue - findEditableFile fell through
    // past the example's own configured default (src/App.tsx, which doesn't exist here).
    await expect(page.locator("#example-create-editor")).toHaveValue(/<template>/);

    const pkg = await page.evaluate(async () => {
      const { fs } = (window as unknown as WcWindow).wc;
      return JSON.parse(new TextDecoder().decode(await fs.readFile("/created-app/package.json")));
    });
    expect(pkg.dependencies).toHaveProperty("vue");
    expect(pkg.devDependencies.vite).toBe("7.3.6"); // the always-safe pin, applied regardless of framework
    if (pkg.devDependencies["@vitejs/plugin-vue"]) expect(pkg.devDependencies["@vitejs/plugin-vue"]).toBe("^6.0.0");
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

test.describe("terminal color", () => {
  // The playground's terminal (src/terminal.ts) is a real xterm.js instance, which already
  // renders ANSI color codes natively - the missing piece was real Node's own color-aware paths
  // (console.log's colorized util.inspect, and most CLI color libraries) staying colorless since
  // there's no real TTY here for them to detect (`tty_wrap`'s isatty() is always false).
  // terminal.ts now spawns with FORCE_COLOR=3, which Node's own internal/tty.js's getColorDepth()
  // (vendored verbatim, pure env-var logic - no native binding involved at all) honors regardless
  // of isTTY. Checked directly against a real spawn, not through xterm's own rendering (a
  // well-tested third-party concern, not wcvm's).
  test("FORCE_COLOR makes a real node process's own console.log colorize its output", async ({ page }) => {
    const r = await page.evaluate(async () => {
      const wc = (window as unknown as WcWindow).wc;
      const proc = await wc.spawn("node", ["-e", "console.log(42)"], { env: { FORCE_COLOR: "3" } });
      return new Response(proc.stdout).text();
    });
    expect(r).toContain("\u001b[");
    expect(r).toContain("42");
  });

  test("without it, the same process's output has no color codes at all", async ({ page }) => {
    const r = await spawn(page, "node", ["-e", "console.log(42)"]);
    expect(r).toEqual({ code: 0, out: "42\n", err: "" });
  });
});

test.describe("raw native Worker (the browser's own Worker global, not worker_threads)", () => {
  const writeFiles = (page: import("@playwright/test").Page, files: Record<string, string>) =>
    page.evaluate(async (files) => {
      const { fs } = (window as unknown as WcWindow).wc;
      for (const [path, contents] of Object.entries(files)) {
        await fs.mkdir(path.slice(0, path.lastIndexOf("/")) || "/", { recursive: true });
        await fs.writeFile(path, contents);
      }
    }, files);

  test("new Worker(new URL(..., import.meta.url)) loads from the VFS instead of throwing", async ({ page }) => {
    await writeFiles(page, {
      "/rawworker/src/worker.mjs": "postMessage('hello from worker');",
      "/rawworker/src/main.mjs": `
        const url = new URL('./worker.mjs', import.meta.url);
        const w = new Worker(url, { type: 'module' });
        w.onerror = (e) => { console.log('error', e.message || String(e)); process.nextTick(() => process.exit(1)); };
        w.onmessage = (e) => { console.log('message', e.data); process.nextTick(() => process.exit(0)); };
      `,
    });
    const r = await spawn(page, "node", ["src/main.mjs"], "/rawworker");
    expect(r).toEqual({ code: 0, out: "message hello from worker\n", err: "" });
  });

  test("keeps the process alive until the worker's message arrives (ref counting)", async ({ page }) => {
    await writeFiles(page, {
      "/rawworker2/src/worker.mjs": "setTimeout(() => postMessage('late'), 200);",
      "/rawworker2/src/main.mjs": `
        const url = new URL('./worker.mjs', import.meta.url);
        new Worker(url, { type: 'module' }).onmessage = (e) => { console.log(e.data); process.nextTick(() => process.exit(0)); };
      `,
    });
    const r = await spawn(page, "node", ["src/main.mjs"], "/rawworker2");
    expect(r).toEqual({ code: 0, out: "late\n", err: "" });
  });

  test("terminate() releases the ref, letting a process with no other work exit", async ({ page }) => {
    await writeFiles(page, {
      "/rawworker3/src/worker.mjs": "// never posts anything",
      "/rawworker3/src/main.mjs": `
        const url = new URL('./worker.mjs', import.meta.url);
        const w = new Worker(url, { type: 'module' });
        setTimeout(() => { console.log('terminating'); w.terminate(); }, 50);
      `,
    });
    const r = await spawn(page, "node", ["src/main.mjs"], "/rawworker3");
    expect(r).toEqual({ code: 0, out: "terminating\n", err: "" });
  });

  test("ref()/unref()/on()/once()/off() are safe to call, bridging real events for a Node-shaped listener", async ({ page }) => {
    await writeFiles(page, {
      "/rawworker4/src/worker.mjs": "postMessage('one'); setTimeout(() => postMessage('two'), 20);",
      "/rawworker4/src/main.mjs": `
        const url = new URL('./worker.mjs', import.meta.url);
        const w = new Worker(url, { type: 'module' });
        w.unref();
        w.ref();
        const seen = [];
        const onMessage = (data) => {
          seen.push(data);
          if (data === 'two') {
            w.off('message', onMessage);
            console.log(seen.join(','));
            process.nextTick(() => process.exit(0));
          }
        };
        w.on('message', onMessage);
        w.once('exit', () => { throw new Error('should never fire - no browser equivalent'); });
      `,
    });
    const r = await spawn(page, "node", ["src/main.mjs"], "/rawworker4");
    expect(r).toEqual({ code: 0, out: "one,two\n", err: "" });
  });
});

test.describe("raw fetch() of a file: URL (the browser's own fetch, not wc.fs.fetch)", () => {
  test("fetch(new URL(..., import.meta.url)) reads the VFS file as a real Response", async ({ page }) => {
    await page.evaluate(async () => {
      const { fs } = (window as unknown as WcWindow).wc;
      await fs.mkdir("/rawfetch/src", { recursive: true });
      await fs.writeFile("/rawfetch/src/asset.bin", "hello from the vfs");
      await fs.writeFile(
        "/rawfetch/src/main.mjs",
        `
        const url = new URL('./asset.bin', import.meta.url);
        const res = await fetch(url);
        const text = await res.text();
        console.log(res.status, text);
      `,
      );
    });
    const r = await spawn(page, "node", ["src/main.mjs"], "/rawfetch");
    expect(r).toEqual({ code: 0, out: "200 hello from the vfs\n", err: "" });
  });

  test("fetch(file: URL) for a missing path resolves 404, not a rejection", async ({ page }) => {
    await page.evaluate(async () => {
      const { fs } = (window as unknown as WcWindow).wc;
      await fs.mkdir("/rawfetch2/src", { recursive: true });
      await fs.writeFile(
        "/rawfetch2/src/main.mjs",
        `
        const url = new URL('./missing.bin', import.meta.url);
        const res = await fetch(url);
        console.log(res.status, res.ok);
      `,
      );
    });
    const r = await spawn(page, "node", ["src/main.mjs"], "/rawfetch2");
    expect(r).toEqual({ code: 0, out: "404 false\n", err: "" });
  });

  test("fetch() of a real http(s) URL still passes straight through unchanged", async ({ page }) => {
    // Two pre-existing gaps unrelated to this fix, not attempted here: (1) a bare native fetch()
    // doesn't ref wcvm's own event loop on its own - a live timer keeps the process open long
    // enough for a fast same-origin fetch to actually resolve before the process would otherwise
    // exit idle; (2) a Process Worker's own base URL is a `blob:` one (how every process script is
    // loaded - see esm/loader.ts), which doesn't support a path-absolute relative URL the way a
    // real http(s) page does ("/index.html" alone fails to parse there) - an explicit absolute URL
    // sidesteps it.
    const r = await spawn(page, "node", [
      "-e",
      "const t = setInterval(() => {}, 50); fetch(new URL('/index.html', location.origin)).then((r) => { console.log(r.status); clearInterval(t); })",
    ]);
    expect(r).toEqual({ code: 0, out: "200\n", err: "" });
  });
});

import { expect, test } from "@playwright/test";

type WcWindow = Window & { wc: import("wcvm").IWcvm };

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
    const r = await page.evaluate(async () => {
      const wc = (window as unknown as WcWindow).wc;
      const proc = await wc.spawn("sh", []);
      const writer = proc.stdin.getWriter();
      const encoder = new TextEncoder();
      const send = async (line: string) => {
        await writer.write(encoder.encode(`${line}\n`));
        await new Promise((resolve) => setTimeout(resolve, 100));
      };
      await send("node"); // starts a nested interactive node REPL, in the same process
      await send("1 + 1"); // evaluated by node, not sh
      await send(".exit"); // node exits normally - does NOT end the whole process's stdin
      await send("echo still alive"); // must reach sh's REPL, not a now-defunct handler
      await writer.close();
      const [out, err, exit] = await Promise.all([
        new Response(proc.stdout).text(),
        new Response(proc.stderr).text(),
        proc.exit,
      ]);
      return { out, err, code: exit.exitCode };
    });
    expect(r.out).toContain("2\n");
    expect(r.out).toContain("still alive\n");
    expect(r.code).toBe(0);
  });
});

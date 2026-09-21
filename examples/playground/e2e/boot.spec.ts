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
});

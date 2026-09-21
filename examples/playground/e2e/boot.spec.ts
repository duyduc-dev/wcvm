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
      return { code: exit.errorCode, out, err, signal: exit.signal } as Result;
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
        code: (await p.exit).errorCode,
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
  expect(result.exit).toMatchObject({ errorCode: 143, signal: "SIGTERM" });
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

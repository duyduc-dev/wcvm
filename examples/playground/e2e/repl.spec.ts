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

// Runs `command` interactively: writes each of `lines` to stdin (one write per line, so
// they arrive as separate chunks - a real REPL can't assume line-aligned chunk boundaries),
// closes stdin, and collects everything the process produced.
const runInteractive = (page: import("@playwright/test").Page, command: string, lines: string[]) =>
  page.evaluate(
    async ({ command, lines }) => {
      const wc = (window as unknown as WcWindow).wc;
      const proc = await wc.spawn(command, []);
      const writer = proc.stdin.getWriter();
      const encoder = new TextEncoder();
      for (const line of lines) await writer.write(encoder.encode(`${line}\n`));
      await writer.close();
      const [out, err, exit] = await Promise.all([
        new Response(proc.stdout).text(),
        new Response(proc.stderr).text(),
        proc.exit,
      ]);
      return { code: exit.exitCode, out, err };
    },
    { command, lines },
  );

test.describe("node REPL", () => {
  test("persists variables across lines - real indirect eval against the process's own global", async ({ page }) => {
    const r = await runInteractive(page, "node", ["let x = 40 + 2", "x"]);
    expect(r.code).toBe(0);
    expect(r.out).toContain("42");
  });

  test("prints Uncaught for a thrown error and keeps the session going", async ({ page }) => {
    const r = await runInteractive(page, "node", ["throw new Error('boom')", "1 + 1"]);
    expect(r.code).toBe(0);
    expect(r.out).toContain("Uncaught");
    expect(r.out).toContain("boom");
    expect(r.out).toContain("2");
  });

  test("require works inside the session", async ({ page }) => {
    const r = await runInteractive(page, "node", ["require('path').join('a', 'b')"]);
    expect(r.code).toBe(0);
    expect(r.out).toContain("a/b");
  });

  test(".exit ends the session immediately", async ({ page }) => {
    const r = await runInteractive(page, "node", [".exit", "this line is never reached"]);
    expect(r.code).toBe(0);
    expect(r.out).not.toContain("never reached");
  });
});

test.describe("sh REPL", () => {
  test("cd persists across lines, like a real interactive shell", async ({ page }) => {
    const r = await runInteractive(page, "sh", ["mkdir /tmp", "cd /tmp", "pwd"]);
    expect(r.code).toBe(0);
    expect(r.out).toContain("/tmp");
  });

  test("a syntax error on one line doesn't end the session", async ({ page }) => {
    const r = await runInteractive(page, "sh", ["echo a |", "echo still alive"]);
    expect(r.code).toBe(0);
    expect(r.err).toContain("sh:");
    expect(r.out).toContain("still alive");
  });

  test("exit N ends the session with that status", async ({ page }) => {
    const r = await runInteractive(page, "sh", ["exit 7"]);
    expect(r.code).toBe(7);
  });
});

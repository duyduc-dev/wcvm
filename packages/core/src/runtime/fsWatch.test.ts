import { describe, expect, it } from "vitest";
import { runScript } from "./harness";

const run = (source: string, cwd = "/") => runScript({ "/main.js": source }, "/main.js", { cwd });

describe("fs.watch", () => {
  it("fires 'change' for a content rewrite and 'rename' for a new file, with a filename relative to the watched dir", async () => {
    const r = await run(`
      const fs = require("fs");
      fs.mkdirSync("/proj");
      fs.writeFileSync("/proj/a.txt", "one");
      const seen = [];
      const watcher = fs.watch("/proj", (eventType, filename) => {
        seen.push([eventType, filename]);
        if (seen.length === 2) {
          watcher.close();
          console.log(JSON.stringify(seen));
        }
      });
      fs.writeFileSync("/proj/a.txt", "two");
      fs.writeFileSync("/proj/b.txt", "new");
    `);
    expect(r.code).toBe(0);
    expect(JSON.parse(r.stdout)).toEqual([["change", "a.txt"], ["rename", "b.txt"]]);
  });

  it("a non-recursive watch ignores a nested grandchild; recursive: true catches it, with a nested relative filename", async () => {
    const r = await run(`
      const fs = require("fs");
      fs.mkdirSync("/proj/src", { recursive: true });
      const seen = [];
      const w1 = fs.watch("/proj", (eventType, filename) => seen.push(["non-recursive", eventType, filename]));
      const w2 = fs.watch("/proj", { recursive: true }, (eventType, filename) => {
        seen.push(["recursive", eventType, filename]);
        w1.close();
        w2.close();
        console.log(JSON.stringify(seen));
      });
      fs.writeFileSync("/proj/src/deep.txt", "hi");
    `);
    expect(r.code).toBe(0);
    expect(JSON.parse(r.stdout)).toEqual([["recursive", "rename", "src/deep.txt"]]);
  });

  it("watching a single file reports its own basename and ignores a sibling", async () => {
    const r = await run(`
      const fs = require("fs");
      fs.writeFileSync("/a.txt", "one");
      fs.writeFileSync("/a.txt.bak", "one");
      const seen = [];
      const watcher = fs.watch("/a.txt", (eventType, filename) => {
        seen.push([eventType, filename]);
        watcher.close();
        console.log(JSON.stringify(seen));
      });
      fs.writeFileSync("/a.txt.bak", "changed");
      fs.writeFileSync("/a.txt", "changed");
    `);
    expect(r.code).toBe(0);
    expect(JSON.parse(r.stdout)).toEqual([["change", "a.txt"]]);
  });

  it("keeps the process alive by default (persistent: true) until close(), and throws for a missing path", async () => {
    const r = await run(`
      const fs = require("fs");
      try { fs.watch("/nope", () => {}); } catch (e) { console.error(e.code); }
      fs.writeFileSync("/a.txt", "one");
      const watcher = fs.watch("/a.txt", () => {});
      setTimeout(() => { watcher.close(); console.log("closed"); }, 10);
    `);
    expect(r.code).toBe(0);
    expect(r.stdout).toBe("closed\n");
    expect(r.stderr).toBe("ENOENT\n");
  });
});

describe("fs.watchFile / fs.unwatchFile", () => {
  it("fires 'change' with the new and old Stats once the content actually differs from the baseline poll", async () => {
    const r = await run(`
      const fs = require("fs");
      fs.writeFileSync("/a.txt", "one");
      fs.watchFile("/a.txt", { interval: 5 }, (curr, prev) => {
        fs.unwatchFile("/a.txt");
        console.log(JSON.stringify({ currSize: curr.size, prevSize: prev.size }));
      });
      setTimeout(() => fs.writeFileSync("/a.txt", "a much longer body"), 20);
    `);
    expect(r.code).toBe(0);
    expect(JSON.parse(r.stdout)).toEqual({ currSize: 18, prevSize: 3 });
  }, 10000);

  it("fires once when a watched-but-missing file is created, transitioning from absent to present", async () => {
    const r = await run(`
      const fs = require("fs");
      fs.watchFile("/new.txt", { interval: 5 }, (curr, prev) => {
        fs.unwatchFile("/new.txt");
        console.log(JSON.stringify({ currSize: curr.size, prevNlink: prev.nlink }));
      });
      setTimeout(() => fs.writeFileSync("/new.txt", "hi"), 20);
    `);
    expect(r.code).toBe(0);
    expect(JSON.parse(r.stdout)).toEqual({ currSize: 2, prevNlink: 0 });
  }, 10000);
});

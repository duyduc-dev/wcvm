import { describe, expect, it } from "vitest";
import { runScript } from "./harness";

const run = (source: string, files: Record<string, string> = {}) =>
  runScript({ "/app/main.js": source, ...files }, "/app/main.js", { cwd: "/app" });

describe("fs sync API", () => {
  it("reads and writes text and binary files", async () => {
    const r = await run(`
      const fs = require("fs");
      fs.writeFileSync("/t.txt", "héllo");
      console.log(fs.readFileSync("/t.txt", "utf8"), fs.readFileSync("/t.txt").length, fs.readFileSync("/t.txt", "hex"));
      fs.writeFileSync("/b.bin", Buffer.from([0, 255, 1]));
      console.log(fs.readFileSync("/b.bin"), fs.readFileSync("/b.bin", "base64"));
      fs.appendFileSync("/t.txt", "!");
      console.log(fs.readFileSync("/t.txt", { encoding: "utf8" }));
    `);
    expect(r.stdout).toBe("héllo 6 68c3a96c6c6f\n<Buffer 00 ff 01> AP8B\nhéllo!\n");
  });

  it("relative paths resolve against the process cwd", async () => {
    const r = await run(`
      const fs = require("fs"); fs.writeFileSync("rel.txt", "r"); console.log(fs.readFileSync("/app/rel.txt", "utf8"), fs.existsSync("rel.txt"));
    `);
    expect(r.stdout).toBe("r true\n");
  });

  it("reports existence without throwing", async () => {
    const r = await run(`const fs = require("fs"); console.log(fs.existsSync("/app/main.js"), fs.existsSync("/nope"), fs.existsSync("/app"))`);
    expect(r.stdout).toBe("true false true\n");
  });

  it("stat describes files, directories and symlinks", async () => {
    const r = await run(`
      const fs = require("fs");
      fs.writeFileSync("/f", "abc"); fs.mkdirSync("/d"); fs.symlinkSync("/f", "/l");
      const f = fs.statSync("/f"), d = fs.statSync("/d"), l = fs.lstatSync("/l");
      console.log(f.isFile(), f.size, d.isDirectory(), l.isSymbolicLink(), fs.statSync("/l").isFile());
      console.log((f.mode & 0o777).toString(8), f.mtime instanceof Date, f.mtimeMs > 0, f.nlink, typeof f.ino);
      console.log(typeof fs.statSync("/f", { bigint: true }).size, fs.statSync("/nope", { throwIfNoEntry: false }));
    `);
    expect(r.stdout).toBe("true 3 true true true\n644 true true 1 number\nbigint undefined\n");
  });

  it("readdir lists names, entry types and recursion", async () => {
    const r = await run(`
      const fs = require("fs");
      fs.mkdirSync("/d/sub", { recursive: true }); fs.writeFileSync("/d/b", ""); fs.writeFileSync("/d/a", ""); fs.writeFileSync("/d/sub/c", "");
      console.log(fs.readdirSync("/d"));
      console.log(fs.readdirSync("/d", { withFileTypes: true }).map((e) => e.name + ":" + (e.isDirectory() ? "dir" : "file")).join());
      console.log(fs.readdirSync("/d", { recursive: true }).sort());
      console.log(fs.readdirSync("/d", "buffer")[0]);
    `);
    expect(r.stdout).toBe("[ 'a', 'b', 'sub' ]\na:file,b:file,sub:dir\n[ 'a', 'b', 'sub', 'sub/c' ]\n<Buffer 61>\n");
  });

  it("mkdir returns the first directory created when recursive", async () => {
    const r = await run(`
      const fs = require("fs");
      console.log(fs.mkdirSync("/a/b/c", { recursive: true }), fs.mkdirSync("/a/b/c", { recursive: true }), fs.mkdirSync("/a/b/d", { recursive: true }), fs.mkdirSync("/plain"));
    `);
    expect(r.stdout).toBe("/a undefined /a/b/d undefined\n");
  });

  it("removes files and directories", async () => {
    const r = await run(`
      const fs = require("fs");
      fs.mkdirSync("/d/e", { recursive: true }); fs.writeFileSync("/d/e/f", ""); fs.writeFileSync("/x", "");
      fs.unlinkSync("/x");
      try { fs.rmdirSync("/d") } catch (e) { console.log(e.code) }
      try { fs.rmSync("/d") } catch (e) { console.log(e.code) }
      fs.rmSync("/d", { recursive: true });
      fs.rmSync("/missing", { force: true });
      try { fs.rmSync("/missing") } catch (e) { console.log(e.code) }
      console.log(fs.existsSync("/d"), fs.existsSync("/x"));
    `);
    expect(r.stdout).toBe("ENOTEMPTY\nERR_FS_EISDIR\nENOENT\nfalse false\n");
  });

  it("renames, copies (with EXCL), links and truncates", async () => {
    const r = await run(`
      const fs = require("fs");
      fs.writeFileSync("/a", "hello");
      fs.renameSync("/a", "/b");
      fs.copyFileSync("/b", "/c");
      try { fs.copyFileSync("/b", "/c", fs.constants.COPYFILE_EXCL) } catch (e) { console.log(e.code) }
      fs.linkSync("/b", "/h");
      fs.truncateSync("/c", 2);
      console.log(fs.existsSync("/a"), fs.readFileSync("/b", "utf8"), fs.readFileSync("/c", "utf8"), fs.statSync("/b").nlink, fs.readFileSync("/h", "utf8"));
    `);
    expect(r.stdout).toBe("EEXIST\nfalse hello he 2 hello\n");
  });

  it("symlinks: create, read, resolve", async () => {
    const r = await run(`
      const fs = require("fs");
      fs.mkdirSync("/real"); fs.writeFileSync("/real/f", "x"); fs.symlinkSync("/real", "/link");
      console.log(fs.readlinkSync("/link"), fs.realpathSync("/link/f"), fs.readFileSync("/link/f", "utf8"), fs.realpathSync.native("/link"));
    `);
    expect(r.stdout).toBe("/real /real/f x /real\n");
  });

  it("file descriptors: open, read at positions, write, fstat, ftruncate, close", async () => {
    const r = await run(`
      const fs = require("fs");
      const fd = fs.openSync("/f", "w+");
      fs.writeSync(fd, "hello world");
      fs.writeSync(fd, "HELLO", 0);
      const buf = Buffer.alloc(5);
      console.log(fs.readSync(fd, buf, 0, 5, 6), buf.toString(), fs.fstatSync(fd).size);
      fs.ftruncateSync(fd, 5);
      fs.closeSync(fd);
      console.log(fs.readFileSync("/f", "utf8"));
      try { fs.closeSync(fd) } catch (e) { console.log(e.code, e.syscall) }
    `);
    expect(r.stdout).toBe("5 world 11\nHELLO\nEBADF close\n");
  });

  it("open flags: append, exclusive create, read-only", async () => {
    const r = await run(`
      const fs = require("fs");
      fs.writeFileSync("/f", "a");
      fs.writeFileSync("/f", "b", { flag: "a" });
      try { fs.writeFileSync("/f", "c", { flag: "wx" }) } catch (e) { console.log(e.code) }
      console.log(fs.readFileSync("/f", "utf8"));
      const fd = fs.openSync("/f", "r");
      try { fs.writeSync(fd, "z") } catch (e) { console.log(e.code) }
      fs.closeSync(fd);
    `);
    expect(r.stdout).toBe("EEXIST\nab\nEBADF\n");
  });

  it("mkdtemp makes a unique directory with the given prefix", async () => {
    const r = await run(`
      const fs = require("fs"); fs.mkdirSync("/tmp");
      const a = fs.mkdtempSync("/tmp/x-"), b = fs.mkdtempSync("/tmp/x-");
      console.log(/^\\/tmp\\/x-[A-Za-z0-9]{6}$/.test(a), a !== b, fs.statSync(a).isDirectory());
    `);
    expect(r.stdout).toBe("true true true\n");
  });

  it("access checks existence and permission bits; chmod and utimes take effect", async () => {
    const r = await run(`
      const fs = require("fs");
      fs.writeFileSync("/f", "");
      fs.accessSync("/f");
      try { fs.accessSync("/f", fs.constants.X_OK) } catch (e) { console.log(e.code) }
      fs.chmodSync("/f", 0o755); fs.accessSync("/f", fs.constants.X_OK);
      console.log((fs.statSync("/f").mode & 0o777).toString(8));
      try { fs.accessSync("/nope") } catch (e) { console.log(e.code) }
      fs.utimesSync("/f", 1000, 2000);
      const s = fs.statSync("/f"); console.log(s.atimeMs, s.mtimeMs);
    `);
    expect(r.stdout).toBe("EACCES\n755\nENOENT\n1000000 2000000\n");
  });

  it("fd 1 and 2 write to the process's stdout and stderr", async () => {
    const r = await run(`const fs = require("fs"); fs.writeSync(1, "out\\n"); fs.writeSync(2, "err\\n"); fs.writeFileSync(1, "again\\n")`);
    expect(r.stdout).toBe("out\nagain\n");
    expect(r.stderr).toBe("err\n");
  });

  it("reading stdin's fd yields end of file", async () => {
    const r = await run(`console.log(JSON.stringify(require("fs").readFileSync(0, "utf8")))`);
    expect(r.stdout).toBe('""\n');
  });

  it("files far larger than the syscall window round-trip", async () => {
    const r = await run(`
      const fs = require("fs"); const big = Buffer.alloc(3_000_000, "ab");
      fs.writeFileSync("/big", big);
      const back = fs.readFileSync("/big");
      console.log(back.length, back.equals(big), fs.readFileSync("/big", "utf8").length);
    `);
    expect(r.stdout).toBe("3000000 true 3000000\n");
  });
});

describe("fs errors match Node's exceptions", () => {
  const catchAll = `
    const fs = require("fs");
    const show = (fn) => { try { fn() } catch (e) { console.log(e.message, "|", e.errno, e.code, e.syscall, e.path, e.dest) } };
  `;

  it("carries message, errno, code, syscall, path and dest", async () => {
    {
      const r = await run(`${catchAll}
        fs.mkdirSync("/d"); fs.writeFileSync("/f", "");
        show(() => fs.readFileSync("/nope"));
        show(() => fs.statSync("/nope"));
        show(() => fs.readdirSync("/nope"));
        show(() => fs.readdirSync("/f"));
        show(() => fs.mkdirSync("/d"));
        show(() => fs.mkdirSync("/nope/deeper"));
        show(() => fs.rmdirSync("/nope"));
        show(() => fs.unlinkSync("/d"));
        show(() => fs.renameSync("/nope", "/x"));
        show(() => fs.readFileSync("/d"));
        show(() => fs.writeFileSync("/d", "x"));
        show(() => fs.symlinkSync("/f", "/f"));
        show(() => fs.readlinkSync("/f"));
        show(() => fs.copyFileSync("/nope", "/y"));
        show(() => fs.openSync("/nope/x/y", "r"));
      `);
      expect(r.stdout.trimEnd().split("\n")).toEqual([
        "ENOENT: no such file or directory, open '/nope' | -2 ENOENT open /nope undefined",
        "ENOENT: no such file or directory, stat '/nope' | -2 ENOENT stat /nope undefined",
        "ENOENT: no such file or directory, scandir '/nope' | -2 ENOENT scandir /nope undefined",
        "ENOTDIR: not a directory, scandir '/f' | -20 ENOTDIR scandir /f undefined",
        "EEXIST: file already exists, mkdir '/d' | -17 EEXIST mkdir /d undefined",
        "ENOENT: no such file or directory, mkdir '/nope/deeper' | -2 ENOENT mkdir /nope/deeper undefined",
        "ENOENT: no such file or directory, rmdir '/nope' | -2 ENOENT rmdir /nope undefined",
        "EISDIR: illegal operation on a directory, unlink '/d' | -21 EISDIR unlink /d undefined",
        "ENOENT: no such file or directory, rename '/nope' -> '/x' | -2 ENOENT rename /nope /x",
        "EISDIR: illegal operation on a directory, read | -21 EISDIR read undefined undefined",
        "EISDIR: illegal operation on a directory, open '/d' | -21 EISDIR open /d undefined",
        "EEXIST: file already exists, symlink '/f' -> '/f' | -17 EEXIST symlink /f /f",
        "EINVAL: invalid argument, readlink '/f' | -22 EINVAL readlink /f undefined",
        "ENOENT: no such file or directory, copyfile '/nope' -> '/y' | -2 ENOENT copyfile /nope /y",
        "ENOENT: no such file or directory, open '/nope/x/y' | -2 ENOENT open /nope/x/y undefined",
      ]);
    }
  });

  it("are real Error instances with the stack Node prints", async () => {
    const r = await run(`
      try { require("fs").readFileSync("/nope") } catch (e) { console.log(e instanceof Error, e.stack.split("\\n")[0], Object.keys(e).join()) }
    `);
    expect(r.stdout).toBe("true Error: ENOENT: no such file or directory, open '/nope' errno,code,syscall,path\n");
  });

  it("argument validation throws Node's own TypeErrors", async () => {
    const r = await run(`
      const fs = require("fs");
      for (const fn of [() => fs.readFileSync(123456), () => fs.readFileSync({}), () => fs.writeFileSync("/x"), () => fs.readFileSync("/x", { encoding: "nope" }), () => fs.mkdirSync(null)]) {
        try { fn() } catch (e) { console.log(e.code) }
      }
    `);
    expect(r.stdout).toBe("EBADF\nERR_INVALID_ARG_TYPE\nERR_INVALID_ARG_TYPE\nERR_INVALID_ARG_VALUE\nERR_INVALID_ARG_TYPE\n");
  });
});

describe("fs callback API", () => {
  it("delivers results after the current tick, keeps the process alive, and reports errors", async () => {
    const r = await run(`
      const fs = require("fs");
      fs.writeFile("/f", "data", (err) => {
        console.log("written", err);
        fs.readFile("/f", "utf8", (err, text) => {
          console.log("read", err, text);
          fs.readFile("/nope", (err) => { console.log(err.code, err.syscall); });
        });
      });
      console.log("sync done");
    `);
    expect(r.stdout).toBe("sync done\nwritten null\nread null data\nENOENT open\n");
  });

  it("stat, readdir, mkdir, rename, unlink, access, exists", async () => {
    const r = await run(`
      const fs = require("fs");
      fs.mkdir("/d/e", { recursive: true }, (err, first) => {
        console.log("mkdir", err, first);
        fs.writeFile("/d/e/f", "x", () => {
          fs.readdir("/d/e", (err, names) => {
            console.log("readdir", names);
            fs.stat("/d/e/f", (err, s) => {
              console.log("stat", s.size, s.isFile());
              fs.rename("/d/e/f", "/d/g", (err) => {
                fs.unlink("/d/g", (err) => {
                  fs.access("/d/g", (err) => console.log("access", err.code));
                  fs.exists("/d/e", (yes) => console.log("exists", yes));
                });
              });
            });
          });
        });
      });
    `);
    expect(r.stdout).toBe("mkdir null /d\nreaddir [ 'f' ]\nstat 1 true\naccess ENOENT\nexists true\n");
  });

  it("fs.read / fs.write with descriptors", async () => {
    const r = await run(`
      const fs = require("fs");
      fs.open("/f", "w+", (err, fd) => {
        fs.write(fd, "abcdef", (err, n) => {
          const buf = Buffer.alloc(3);
          fs.read(fd, buf, 0, 3, 2, (err, bytes) => {
            console.log(n, bytes, buf.toString());
            fs.close(fd, (err) => console.log("closed", err));
          });
        });
      });
    `);
    expect(r.stdout).toBe("6 3 cde\nclosed null\n");
  });

  it("many operations in flight complete in order of submission", async () => {
    const r = await run(`
      const fs = require("fs"); const seen = [];
      for (let i = 0; i < 20; i++) fs.writeFile("/f" + i, String(i), () => seen.push(i));
      setTimeout(() => console.log(seen.length, seen.every((v, i) => v === i)), 20);
    `);
    expect(r.stdout).toBe("20 true\n");
  });

  it("an in-flight operation keeps the process alive until it completes", async () => {
    const r = await run(`require("fs").readFile("/app/main.js", () => console.log("done"))`);
    expect(r.stdout).toBe("done\n");
  });
});

describe("fs.promises", () => {
  it("reads, writes, stats, lists, copies, renames and removes", async () => {
    const r = await run(`
      const fsp = require("fs/promises");
      (async () => {
        await fsp.mkdir("/p/q", { recursive: true });
        await fsp.writeFile("/p/q/a.txt", "one");
        await fsp.appendFile("/p/q/a.txt", "two");
        console.log(await fsp.readFile("/p/q/a.txt", "utf8"), (await fsp.stat("/p/q/a.txt")).size);
        await fsp.copyFile("/p/q/a.txt", "/p/b.txt");
        await fsp.rename("/p/b.txt", "/p/c.txt");
        console.log(await fsp.readdir("/p"), (await fsp.readdir("/p", { withFileTypes: true })).map((e) => e.isDirectory()));
        console.log(await fsp.access("/p/c.txt"), await fsp.realpath("/p/c.txt"));
        await fsp.rm("/p", { recursive: true });
        console.log(await fsp.stat("/p").catch((e) => e.code));
      })();
    `);
    expect(r.stdout).toBe("onetwo 6\n[ 'c.txt', 'q' ] [ false, true ]\nundefined /p/c.txt\nENOENT\n");
  });

  it("rejects with Node's exception shape", async () => {
    const r = await run(`
      require("fs/promises").readFile("/nope").catch((e) => console.log(e.code, e.syscall, e.path, e.message));
    `);
    expect(r.stdout).toBe("ENOENT open /nope ENOENT: no such file or directory, open '/nope'\n");
  });

  it("FileHandle: read, write, stat, truncate, close", async () => {
    const r = await run(`
      const fsp = require("fs/promises");
      (async () => {
        const h = await fsp.open("/f", "w+");
        await h.write("hello world");
        await h.write("HELLO", 0);
        const { bytesRead, buffer } = await h.read(Buffer.alloc(5), 0, 5, 6);
        console.log(bytesRead, buffer.toString(), (await h.stat()).size);
        await h.truncate(5);
        console.log(await h.readFile("utf8").catch(() => "n/a"));
        await h.close();
        console.log(await fsp.readFile("/f", "utf8"));
      })();
    `);
    expect(r.stdout).toContain("5 world 11\n");
    expect(r.stdout.endsWith("HELLO\n")).toBe(true);
  });

  it("opendir and for-await iteration", async () => {
    const r = await run(`
      const fs = require("fs"); fs.mkdirSync("/d"); fs.writeFileSync("/d/a", ""); fs.mkdirSync("/d/b");
      (async () => { const names = []; for await (const e of await fs.promises.opendir("/d")) names.push(e.name + (e.isDirectory() ? "/" : "")); console.log(names.sort()); })();
    `);
    expect(r.stdout).toBe("[ 'a', 'b/' ]\n");
  });

  it("works with util.promisify on callback fs and with Promise.all", async () => {
    const r = await run(`
      const fs = require("fs"); const { promisify } = require("util");
      (async () => {
        await Promise.all([1, 2, 3].map((n) => fs.promises.writeFile("/f" + n, "x".repeat(n))));
        const sizes = await Promise.all([1, 2, 3].map((n) => promisify(fs.stat)("/f" + n).then((s) => s.size)));
        console.log(sizes);
      })();
    `);
    expect(r.stdout).toBe("[ 1, 2, 3 ]\n");
  });
});

describe("fs streams", () => {
  it("createReadStream emits chunks, honours encoding and start/end", async () => {
    const r = await run(`
      const fs = require("fs"); fs.writeFileSync("/f", "0123456789");
      let text = ""; fs.createReadStream("/f", { encoding: "utf8", highWaterMark: 4 }).on("data", (c) => text += c + "|").on("end", () => {
        console.log(text);
        fs.createReadStream("/f", { start: 2, end: 5, encoding: "utf8" }).on("data", (c) => console.log(c));
      });
    `);
    expect(r.stdout).toBe("0123|4567|89|\n2345\n");
  });

  it("createReadStream on a missing file emits an error", async () => {
    const r = await run(`require("fs").createReadStream("/nope").on("error", (e) => console.log(e.code))`);
    expect(r.stdout).toBe("ENOENT\n");
  });

  it("createWriteStream writes, finishes and reports bytesWritten", async () => {
    const r = await run(`
      const fs = require("fs"); const ws = fs.createWriteStream("/out");
      ws.write("hello "); ws.write(Buffer.from("world")); ws.end("!");
      ws.on("finish", () => console.log("finish", ws.bytesWritten, fs.readFileSync("/out", "utf8")));
    `);
    expect(r.stdout).toBe("finish 12 hello world!\n");
  });

  it("pipeline copies a file through a Transform", async () => {
    const r = await run(`
      const fs = require("fs"); const { pipeline, Transform } = require("stream");
      fs.writeFileSync("/in", "make me loud");
      pipeline(fs.createReadStream("/in"), new Transform({ transform(c, e, cb) { cb(null, c.toString().toUpperCase()) } }), fs.createWriteStream("/out"), (err) => {
        console.log(err, fs.readFileSync("/out", "utf8"));
      });
    `);
    expect(r.stdout).toBe("undefined MAKE ME LOUD\n");
  });

  it("streams a multi-megabyte file without losing bytes", async () => {
    const r = await run(`
      const fs = require("fs"); fs.writeFileSync("/big", Buffer.alloc(2_500_000, 7));
      let n = 0; fs.createReadStream("/big").on("data", (c) => n += c.length).on("end", () => console.log(n));
    `);
    expect(r.stdout).toBe("2500000\n");
  });
});

describe("os", () => {
  it("describes a single-user linux machine", async () => {
    const r = await run(`
      const os = require("os");
      console.log(os.platform(), os.type(), os.EOL === "\\n", os.homedir(), os.tmpdir(), os.hostname(), os.endianness(), os.cpus().length > 0, typeof os.totalmem(), os.userInfo().username);
    `);
    expect(r.stdout).toBe("linux Linux true /home/user /tmp wcvm LE true number user\n");
  });

  it("os.homedir follows the process environment", async () => {
    const r = await runScript({ "/a.js": `console.log(require("os").homedir(), require("os").tmpdir())` }, "/a.js", { env: { HOME: "/h", TMPDIR: "/scratch" } });
    expect(r.stdout).toBe("/h /scratch\n");
  });
});

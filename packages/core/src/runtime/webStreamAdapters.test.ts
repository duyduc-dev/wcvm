import { describe, expect, it } from "vitest";
import type { IChildProcessHost } from "./bindings/childProcess";
import { runScript } from "./harness";

// Readable/Writable/Duplex .toWeb()/.fromWeb() - they used to throw "Builtin module
// 'internal/webstreams/adapters' is not vendored yet", which is what destroyed every Next.js page response.

const noopChildProcessHost: IChildProcessHost = {
  spawn: () => {}, kill: () => {}, writeStdin: () => {}, endStdin: () => {},
  writeIpc: () => {}, endIpc: () => {}, onEvent: () => {},
};
const run = (source: string) =>
  runScript({ "/app/main.js": source }, "/app/main.js", { cwd: "/app", childProcess: noopChildProcessHost });

describe("Node <-> web stream adapters", () => {
  it("Readable.toWeb yields a real ReadableStream of Uint8Arrays, honouring pull-based reads", async () => {
    const r = await run(`
      const { Readable } = require("stream");
      (async () => {
        const web = Readable.toWeb(Readable.from([Buffer.from("he"), Buffer.from("llo"), "!"], { objectMode: false }));
        console.log(web instanceof ReadableStream);
        const reader = web.getReader(); let text = ""; let kinds = new Set();
        for (;;) { const { value, done } = await reader.read(); if (done) break; kinds.add(value.constructor.name); text += new TextDecoder().decode(value); }
        console.log(text, [...kinds].join());
      })();
    `);
    expect(r).toEqual(expect.objectContaining({ code: 0, stdout: "true\nhello! Uint8Array\n" }));
  });

  it("Readable.fromWeb yields a Node Readable of Buffers (and works with stream/consumers)", async () => {
    const r = await run(`
      const { Readable } = require("stream");
      const { text } = require("stream/consumers");
      (async () => {
        const make = () => new ReadableStream({ start(c) { c.enqueue(new TextEncoder().encode("ab")); c.enqueue(new TextEncoder().encode("cd")); c.close(); } });
        const node = Readable.fromWeb(make());
        console.log(node instanceof Readable);
        const parts = []; for await (const chunk of node) parts.push(Buffer.isBuffer(chunk) + ":" + chunk);
        console.log(parts.join(","));
        console.log(await text(Readable.fromWeb(make())));
      })();
    `);
    expect(r).toEqual(expect.objectContaining({ code: 0, stdout: "true\ntrue:ab,true:cd\nabcd\n" }));
  });

  it("errors and cancellation cross the boundary both ways", async () => {
    const r = await run(`
      const { Readable } = require("stream");
      (async () => {
        const failing = new Readable({ read() { this.destroy(new Error("node side broke")); } });
        try { await Readable.toWeb(failing).getReader().read(); } catch (e) { console.log("toWeb rejected:", e.message); }
        const web = new ReadableStream({ start(c) { c.error(new Error("web side broke")); } });
        try { for await (const _ of Readable.fromWeb(web)) {} } catch (e) { console.log("fromWeb threw:", e.message); }
        const src = new Readable({ read() {} });
        const reader = Readable.toWeb(src).getReader();
        await reader.cancel(new Error("not interested"));
        await new Promise((r) => setTimeout(r, 10));
        console.log("cancel destroyed node stream:", src.destroyed);
      })();
    `);
    expect(r).toEqual(expect.objectContaining({ code: 0, stdout: "toWeb rejected: node side broke\nfromWeb threw: web side broke\ncancel destroyed node stream: true\n" }));
  });

  it("Writable.toWeb and Writable.fromWeb carry writes, end and abort", async () => {
    const r = await run(`
      const { Writable } = require("stream");
      (async () => {
        const seen = [];
        const node = new Writable({ write(chunk, enc, cb) { seen.push(String(chunk)); cb(); }, final(cb) { seen.push("[final]"); cb(); } });
        const writer = Writable.toWeb(node).getWriter();
        await writer.write(new TextEncoder().encode("a")); await writer.write(new TextEncoder().encode("b")); await writer.close();
        console.log(seen.join());
        const got = [];
        const web = new WritableStream({ write(chunk) { got.push(String(chunk)); }, close() { got.push("[closed]"); } });
        const nodeW = Writable.fromWeb(web);
        console.log(nodeW instanceof Writable);
        await new Promise((resolve) => { nodeW.write("x"); nodeW.end("y", resolve); });
        console.log(got.join());
      })();
    `);
    expect(r).toEqual(expect.objectContaining({ code: 0, stdout: "a,b,[final]\ntrue\nx,y,[closed]\n" }));
  });

  it("Duplex.fromWeb / Duplex.toWeb round-trip through a TransformStream", async () => {
    const r = await run(`
      const { Duplex } = require("stream");
      (async () => {
        const upper = new TransformStream({ transform(chunk, c) { c.enqueue(new TextEncoder().encode(new TextDecoder().decode(chunk).toUpperCase())); } });
        const duplex = Duplex.fromWeb({ readable: upper.readable, writable: upper.writable });
        duplex.end("shout");
        let out = ""; for await (const c of duplex) out += c;
        console.log(out);
        const echo = new Duplex({ read() {}, write(chunk, enc, cb) { this.push(String(chunk) + "!"); cb(); }, final(cb) { this.push(null); cb(); } });
        const { readable, writable } = Duplex.toWeb(echo);
        const w = writable.getWriter(); await w.write(new TextEncoder().encode("hey")); await w.close();
        const reader = readable.getReader(); let back = ""; for (;;) { const { value, done } = await reader.read(); if (done) break; back += new TextDecoder().decode(value); }
        console.log(back);
      })();
    `);
    expect(r).toEqual(expect.objectContaining({ code: 0, stdout: "SHOUT\nhey!\n" }));
  });
});

// The projects the embedded editor playground can open (see EmbedPlayground.vue). Unlike the lightweight
// demo's single file, each is a small project with a package.json, loaded into Studio through @wcvm/sdk.
import type { EmbedView } from "@wcvm/sdk";

export interface IEmbedExample {
  id: string;
  title: string;
  view: EmbedView;
  files: Record<string, string>;
  openFile: string;
  startCommand: string;
}

export const EMBED_EXAMPLES: IEmbedExample[] = [
  {
    id: "script",
    title: "A Node script",
    view: "editor",
    openFile: "index.js",
    startCommand: "node index.js",
    files: {
      "package.json": JSON.stringify({ name: "script", private: true, type: "module" }, null, 2),
      "index.js": `import os from "node:os";
import { createHash } from "node:crypto";

console.log("Node", process.version);
console.log("platform:", os.platform(), "(in a browser tab)");

const digest = createHash("sha256").update("hello from wcvm").digest("hex");
console.log("sha256:", digest.slice(0, 32) + "...");
`,
    },
  },
  {
    id: "server",
    title: "An HTTP server with live preview",
    view: "both",
    openFile: "server.js",
    startCommand: "node server.js",
    files: {
      "package.json": JSON.stringify({ name: "server", private: true, type: "module" }, null, 2),
      "server.js": `import http from "node:http";

const server = http.createServer((req, res) => {
  res.setHeader("content-type", "text/html");
  res.end("<h1>Hello from a server inside your tab</h1><p>" + new Date().toISOString() + "</p>");
});

server.listen(3000, () => console.log("listening on http://localhost:3000"));
`,
    },
  },
];

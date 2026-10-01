// The examples the live demo can run. Each is a file the visitor can edit and run again. Lines are kept short
// (about 60 columns) so they fit the editor without sideways scrolling.
export interface IDemoExample {
  id: string;
  title: string;
  file: string;
  code: string;
}

export const EXAMPLES: IDemoExample[] = [
  {
    id: "hello",
    title: "Hello, Node",
    file: "index.js",
    code: `import os from "node:os";
import { createHash } from "node:crypto";

console.log("Node", process.version);
console.log("platform:", os.platform(), "(in a browser tab)");

const hash = createHash("sha256");
const digest = hash.update("hello from wcvm").digest("hex");
console.log("sha256:", digest.slice(0, 32) + "...");

let total = 0;
for (let i = 1; i <= 5; i++) {
  total += i;
  console.log("tick", i, "sum", total);
}

console.log("done - edit me and hit Run again!");
`,
  },
  {
    id: "http",
    title: "An HTTP server",
    file: "server.js",
    code: `import http from "node:http";

// A real http server and a real http client,
// both running inside this tab.
const server = http.createServer((req, res) => {
  console.log("server got", req.method, req.url);
  res.setHeader("content-type", "application/json");
  res.end(JSON.stringify({
    message: "hello from a server in your browser",
    url: req.url,
  }));
});

server.listen(3000, () => {
  console.log("listening on port 3000");

  http.get("http://localhost:3000/api/hello", (res) => {
    let body = "";
    res.on("data", (chunk) => (body += chunk));
    res.on("end", () => {
      console.log("client got", res.statusCode, body);
      server.close();
    });
  });
});
`,
  },
  {
    id: "files",
    title: "Files and streams",
    file: "files.js",
    code: `import fs from "node:fs";
import readline from "node:readline";

// The filesystem is in memory (it can be saved to OPFS).
fs.mkdirSync("/demo/data", { recursive: true });

const words = ["wasm", "worker", "node", "browser", "tab"];
fs.writeFileSync("/demo/data/words.txt", words.join("\\n"));
console.log("files:", fs.readdirSync("/demo/data"));

const input = fs.createReadStream("/demo/data/words.txt");
const lines = readline.createInterface({ input });

let count = 0;
lines.on("line", (line) => {
  console.log(++count, line.toUpperCase());
});
lines.on("close", () => {
  console.log("read", count, "lines from a stream");
});
`,
  },
  {
    id: "child",
    title: "Child processes",
    file: "parent.js",
    code: `import { spawn, execSync } from "node:child_process";

// Every process is its own Web Worker.
const echoed = execSync("echo hello from a child process");
console.log("sync:", echoed.toString().trim());

const script = "console.log('child pid', process.pid);" +
  "setTimeout(() => process.exit(3), 100)";
const child = spawn("node", ["-e", script]);

child.stdout.on("data", (chunk) => {
  console.log("child says:", chunk.toString().trim());
});
child.on("exit", (code) => {
  console.log("child exited with", code);
});
`,
  },
];

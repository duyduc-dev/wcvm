import { getWcvmInstance } from "@/lib/wcvm";

export interface StaticTemplateCreationResult {
  isFailure: boolean;
  message: string;
  type?: string;
}

/** Plain HTML/CSS/JS served by a zero-dependency Node http server - no bundler, no framework, no
 * real npm install needed (its own package.json has no dependencies at all). Ported from vivari's
 * own "static" template (~/workspace/vivari/packages/studio/src/vv/templates.ts). */
const SERVER_JS = `// A tiny static file server — no dependencies, nothing to install.
const http = require("http");
const fs = require("fs");
const path = require("path");

const ROOT = path.join(__dirname, "public");
const PORT = Number(process.env.PORT ?? 3000);
const TYPES = {
  ".html": "text/html", ".css": "text/css", ".js": "text/javascript",
  ".json": "application/json", ".svg": "image/svg+xml", ".png": "image/png",
  ".jpg": "image/jpeg", ".ico": "image/x-icon",
};

http.createServer((req, res) => {
  let urlPath = decodeURIComponent((req.url || "/").split("?")[0]);
  if (urlPath.endsWith("/")) urlPath += "index.html";
  const file = path.join(ROOT, path.normalize(urlPath));
  if (!file.startsWith(ROOT)) { res.writeHead(403).end("Forbidden"); return; }
  fs.readFile(file, (err, data) => {
    if (err) { res.writeHead(404, { "content-type": "text/html" }).end("<h1>404</h1>"); return; }
    res.writeHead(200, { "content-type": TYPES[path.extname(file)] || "application/octet-stream" });
    res.end(data);
  });
}).listen(PORT, () => console.log("Static server on http://localhost:" + PORT));
`;

const INDEX_HTML = `<!doctype html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>Static site</title>
    <link rel="stylesheet" href="/styles.css" />
  </head>
  <body>
    <main>
      <h1>Static HTML/CSS/JS</h1>
      <p>Served by a zero-dependency Node server inside wcvm.</p>
      <button id="btn" type="button">Click me</button>
    </main>
    <script src="/main.js"></script>
  </body>
</html>
`;

const STYLES_CSS = `body { font-family: system-ui, sans-serif; margin: 0; min-height: 100vh; display: grid; place-items: center; background: #0a0a0a; color: #ededed; }
main { text-align: center; padding: 2rem; }
button { padding: .6rem 1.2rem; border-radius: 8px; border: 1px solid #646cff; background: #646cff; color: #fff; font-size: 1rem; cursor: pointer; }
`;

const MAIN_JS = `let n = 0;
const btn = document.getElementById("btn");
btn.addEventListener("click", () => { n++; btn.textContent = "Clicked " + n + "\\u00d7"; });
`;

const createStaticTemplateProject = async (
  projectPath: string,
): Promise<StaticTemplateCreationResult> => {
  const wc = getWcvmInstance();

  const isExisting = await wc.fs.exists(projectPath);
  if (isExisting) {
    return {
      isFailure: true,
      message: `A project already exists at ${projectPath}`,
      type: "projectName",
    };
  }

  const projectName = projectPath.split("/").at(-1);

  await wc.fs.mount(
    {
      "package.json": {
        file: {
          contents: `{
  "name": "${projectName}",
  "private": true,
  "version": "0.0.0",
  "type": "commonjs",
  "scripts": { "dev": "node server.js", "start": "node server.js" }
}
`,
        },
      },
      "server.js": { file: { contents: SERVER_JS } },
      public: {
        directory: {
          "index.html": { file: { contents: INDEX_HTML } },
          "styles.css": { file: { contents: STYLES_CSS } },
          "main.js": { file: { contents: MAIN_JS } },
        },
      },
    },
    projectPath,
  );

  // OPFS persistence (boot({persist})) is write-behind - without this, a reload right after
  // "created" reports success could still lose files that hadn't finished mirroring yet (see
  // wc.fs.sync()'s own doc comment). A no-op when persistence isn't enabled.
  await wc.fs.sync();

  return { isFailure: false, message: "ok" };
};

export { createStaticTemplateProject };

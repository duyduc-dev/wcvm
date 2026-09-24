// A fake npm registry for the Playwright tests, on its own origin - the same cross-origin,
// `Access-Control-Allow-Origin: *` shape as the real registry.npmjs.org, which a wcvm Process
// Worker's CORS-mode fetch() needs to pass the page's COEP. Serves core's own in-memory fake
// registry (real packuments, real gzipped tarballs, real sha512 integrity) over real HTTP.
// Started by playwright.config.ts: node --import <core>/src/testing/registerTsResolve.mjs <this>.

import { createServer } from "node:http";
import { createFakeRegistry } from "../../../packages/core/src/testing/fakeRegistry.ts";

export const FIXTURE_REGISTRY_PORT = 5184;
const base = `http://localhost:${FIXTURE_REGISTRY_PORT}/`;

const { deps } = createFakeRegistry(
  {
    "colors-lite": {
      versions: {
        "1.0.0": { files: { "index.js": "exports.tag = 'colors@1';" } },
        "2.0.0": { files: { "index.js": "exports.tag = 'colors@2';" } },
      },
    },
    "@demo/util": { versions: { "1.0.0": { files: { "index.js": "exports.wrap = (s) => '[' + s + ']';" } } } },
    "@demo/native-linux-x64": { versions: { "1.0.0": { os: ["linux"], cpu: ["x64"], files: { "index.js": "" } } } },
    greet: {
      versions: {
        "1.2.0": {
          dependencies: { "colors-lite": "^2.0.0", "@demo/util": "^1.0.0" },
          optionalDependencies: { "@demo/native-linux-x64": "1.0.0" },
          bin: { greet: "bin/greet.js" },
          files: {
            "index.js": "const util = require('@demo/util'); module.exports = (name) => util.wrap('hello ' + name) + ' ' + require('colors-lite').tag;",
            "bin/greet.js": "#!/usr/bin/env node\nconsole.log(require('../index.js')(process.argv[2]));",
          },
        },
      },
    },
    "esm-only": {
      versions: { "1.0.0": { packageJson: { type: "module", exports: "./index.js" }, files: { "index.js": "export const answer = 42;" } } },
    },
  },
  base,
);

createServer(async (req, res) => {
  const cors = { "access-control-allow-origin": "*", "access-control-allow-headers": "*" };
  if (req.method === "OPTIONS") {
    res.writeHead(204, cors).end();
    return;
  }
  if (req.url === "/-/ping") {
    res.writeHead(200, cors).end("pong");
    return;
  }
  const response = await deps.fetch(new URL(req.url ?? "/", base).href);
  res.writeHead(response.status, { ...cors, "content-type": response.headers.get("content-type") ?? "application/octet-stream" });
  res.end(Buffer.from(await response.arrayBuffer()));
}).listen(FIXTURE_REGISTRY_PORT);

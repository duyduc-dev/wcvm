import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: "./e2e",
  webServer: [
    {
      // A production build, not `vite dev`: dev serves worker scripts (any
      // `new Worker(url, {type:"module"})`, which is how every wcvm worker is
      // created) through Vite's own transform pipeline, which injects the HMR
      // client into them. That client's WebSocket-reconnect `setInterval` runs
      // in the worker's global scope, where our runtime has installed Node's
      // own `setInterval` over the real one (`globalObject: self`) - so the
      // call gets intercepted and permanently refs our event loop, hanging any
      // process that exits by going idle rather than calling `process.exit()`.
      // Real usage (the built dist/, no dev server) never has this problem;
      // building for tests here just matches that and avoids the flake.
      command: "pnpm build && pnpm preview --port 5183 --strictPort",
      url: "http://localhost:5183/",
      reuseExistingServer: false,
    },
    {
      // A fake npm registry on its own origin, for `npm install` (e2e/fixtureRegistry.ts).
      command: "node --import ../../packages/core/src/testing/registerTsResolve.mjs e2e/fixtureRegistry.ts",
      url: "http://localhost:5184/-/ping",
      reuseExistingServer: false,
    },
  ],
  use: {
    baseURL: "http://localhost:5183/",
  },
});

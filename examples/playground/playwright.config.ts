import { defineConfig } from "@playwright/test";

const viteProxy = process.env.HTTPS_PROXY ?? process.env.https_proxy;

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
    // The opt-in real-Vite test (WCVM_E2E_VITE=1, e2e/boot.spec.ts's "Vite dev server") installs
    // from the real npm registry; on a machine that only reaches the internet through a proxy,
    // Chromium needs to be told about it. Every other test only ever talks to localhost.
    ...(process.env.WCVM_E2E_VITE && viteProxy ? { launchOptions: { proxy: { server: viteProxy, bypass: "localhost,127.0.0.1" } } } : {}),
  },
});

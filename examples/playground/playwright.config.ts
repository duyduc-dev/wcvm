import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: "./e2e",
  webServer: {
    command: "pnpm dev --port 5183 --strictPort",
    url: "http://localhost:5183/",
    reuseExistingServer: false,
  },
  use: {
    baseURL: "http://localhost:5183/",
  },
});

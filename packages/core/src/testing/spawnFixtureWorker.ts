import { Worker } from "node:worker_threads";

/**
 * Starts a plain-.mjs fixture in a real worker thread that can import this
 * package's TypeScript sources directly (type stripping + extensionless hook).
 */
export const spawnFixtureWorker = (fixture: URL, workerData: unknown): Worker =>
  new Worker(fixture, {
    workerData,
    execArgv: [
      "--import",
      new URL("./registerTsResolve.mjs", import.meta.url).href,
    ],
  });

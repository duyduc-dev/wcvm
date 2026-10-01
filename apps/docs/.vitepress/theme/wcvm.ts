// One wcvm instance per page, booted on first use and only in the browser (never during the build's
// server-side render: it needs workers and SharedArrayBuffer).
import type { IWcvm } from "wcvm";

let instance: Promise<IWcvm> | undefined;

export const isolated = (): boolean => typeof self !== "undefined" && self.crossOriginIsolated === true;

export const getWcvm = (): Promise<IWcvm> => {
  instance ??= (async () => {
    const { boot } = await import("wcvm");
    const wc = boot();
    await wc.ready;
    await wc.fs.mkdir("/demo", { recursive: true });
    return wc;
  })();
  return instance;
};

import { describe, expect, it } from "vitest";
import { type ICallSite, installCallSiteFileNames, parseStackFrame } from "./callSiteFileNames";

type FakeError = {
  prepareStackTrace?: (error: Error, sites: ICallSite[]) => unknown;
  captureStackTrace: (target: { stack?: unknown }) => void;
};

// An engine like Safari's: captureStackTrace fills a string and never calls prepareStackTrace.
const safariLikeError = (): FakeError => ({
  captureStackTrace(target) {
    target.stack = "captureHere@/app/a.js:3:9\n/app/b.js:10:2\nrun@[native code]";
  },
});

describe("installCallSiteFileNames on an engine that ignores prepareStackTrace", () => {
  it("hands captureStackTrace's frames to the guest's prepareStackTrace as call sites", () => {
    const error = safariLikeError();
    installCallSiteFileNames(error);
    error.prepareStackTrace = (_error, sites) => sites;

    const holder: { stack?: unknown } = {};
    error.captureStackTrace(holder);
    const sites = holder.stack as ICallSite[];

    expect(sites.map((site) => site.getFileName())).toEqual(["/app/a.js", "/app/b.js", undefined]);
    expect(sites[0]!.getLineNumber()).toBe(3);
    expect(sites[0]!.getColumnNumber()).toBe(9);
    expect(sites[0]!.getFunctionName()).toBe("captureHere");
    expect(sites[2]!.isNative()).toBe(true);
  });

  it("leaves the string alone while the guest has not set prepareStackTrace", () => {
    const error = safariLikeError();
    installCallSiteFileNames(error);
    const holder: { stack?: unknown } = {};
    error.captureStackTrace(holder);
    expect(typeof holder.stack).toBe("string");
  });

  it("does not wrap an engine that already honours prepareStackTrace", () => {
    const error: FakeError = {
      captureStackTrace(target) {
        target.stack = this.prepareStackTrace ? this.prepareStackTrace(new Error(), []) : "plain";
      },
    };
    const before = error.captureStackTrace;
    installCallSiteFileNames(error);
    expect(error.captureStackTrace).toBe(before);
  });
});

describe("parseStackFrame", () => {
  it("reads a frame with no function name", () => {
    const site = parseStackFrame("@blob:https://x.test/abc:12:5");
    expect(site.getFileName()).toBe("blob:https://x.test/abc");
    expect(site.getLineNumber()).toBe(12);
    expect(site.getFunctionName()).toBeNull();
  });
});

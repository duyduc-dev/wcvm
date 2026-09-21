import { describe, expect, it } from "vitest";
import { toErrorReply } from "./errors";

describe("toErrorReply", () => {
  it("replies to a request with its reqId and keeps a string errno", () => {
    expect(
      toErrorReply("fs:readFile", 7, Object.assign(new Error("ENOENT"), { code: "ENOENT" })),
    ).toEqual({
      type: "kernel-response",
      reqId: 7,
      errorMessage: "ENOENT",
      errorCode: "ENOENT",
    });
  });

  it("reports a fire-and-forget failure as kernel:error naming the message type", () => {
    expect(toErrorReply("boot", undefined, new Error("boom"))).toEqual({
      type: "kernel:error",
      messageType: "boot",
      errorMessage: "boom",
    });
  });

  it("stringifies non-Error throws and ignores non-string codes", () => {
    expect(toErrorReply("x", 1, "plain")).toEqual({
      type: "kernel-response",
      reqId: 1,
      errorMessage: "plain",
    });
    expect(toErrorReply("x", 1, { code: 5 })).not.toHaveProperty("errorCode");
  });
});

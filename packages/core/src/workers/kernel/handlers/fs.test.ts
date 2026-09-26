import { describe, expect, it } from "vitest";
import { IKernelHost } from "../../../kernel";
import { createState } from "../../../protocols/state";
import { createLoopbackFs } from "../../../testing/loopbackFs";
import { createRouter } from "../router";
import { IWorkerState } from "../models";
import { registerFsHandlers } from "./fs";

const setup = (ready = true) => {
  const { fs, vfs } = createLoopbackFs();
  const stateManager = createState<IWorkerState>({
    kernel: ready ? ({ fs, dispose() {} } as IKernelHost) : null,
  });
  const router = createRouter();
  registerFsHandlers(router);
  const send = (type: string, data: Record<string, unknown> = {}) =>
    router.dispatch(type, {
      event: { data: { type, ...data } } as MessageEvent,
      stateManager,
      onPostMessage: () => {},
    });
  return { send, vfs };
};

describe("kernel fs handlers", () => {
  it("routes requests to the kernel fs client", async () => {
    const { send, vfs } = setup();
    await send("fs:mkdir", { path: "/p/q", recursive: true });
    await send("fs:writeFile", { path: "/p/q/f", contents: "hello" });

    expect(new TextDecoder().decode(vfs.readFile("/p/q/f"))).toBe("hello");
    expect(await send("fs:exists", { path: "/p/q/f" })).toBe(true);
    expect(await send("fs:readdir", { path: "/p" })).toEqual(["q"]);
    expect(await send("fs:stat", { path: "/p/q/f" })).toMatchObject({
      kind: "file",
      size: 5,
    });
    expect(await send("fs:readFile", { path: "/p/q/f" })).toBeInstanceOf(
      Uint8Array,
    );
  });

  it("covers rename, symlink, readlink, realpath, chmod and lstat", async () => {
    const { send } = setup();
    await send("fs:writeFile", { path: "/a", contents: "x" });
    await send("fs:rename", { from: "/a", to: "/b" });
    await send("fs:symlink", { target: "/b", path: "/l" });
    await send("fs:chmod", { path: "/b", mode: 0o600 });

    expect(await send("fs:readlink", { path: "/l" })).toBe("/b");
    expect(await send("fs:realpath", { path: "/l" })).toBe("/b");
    expect(await send("fs:lstat", { path: "/l" })).toMatchObject({
      kind: "symlink",
    });
    expect(await send("fs:stat", { path: "/b" })).toMatchObject({
      mode: 0o100600,
    });
  });

  it("rm needs recursive for directories, like Node", async () => {
    const { send, vfs } = setup();
    await send("fs:mkdir", { path: "/d/e", recursive: true });
    await expect(send("fs:rm", { path: "/d" })).rejects.toMatchObject({
      code: "EISDIR",
    });
    await send("fs:rm", { path: "/d", recursive: true });
    expect(vfs.exists("/d")).toBe(false);
  });

  it("mounts a tree", async () => {
    const { send, vfs } = setup();
    await send("fs:mount", {
      tree: { "a.txt": { file: { contents: "A" } } },
      basePath: "/m",
    });
    expect(vfs.exists("/m/a.txt")).toBe(true);
  });

  it("resets the whole filesystem", async () => {
    const { send, vfs } = setup();
    await send("fs:mkdir", { path: "/p/q", recursive: true });
    await send("fs:reset");
    expect(vfs.readdir("/")).toEqual([]);
  });

  it("rejects with the errno code, and before the kernel is ready", async () => {
    await expect(setup().send("fs:readFile", { path: "/nope" })).rejects.toMatchObject(
      { code: "ENOENT" },
    );
    await expect(
      setup(false).send("fs:readFile", { path: "/x" }),
    ).rejects.toMatchObject({ type: "ERR_WORKER", message: "Kernel isn't ready" });
  });
});

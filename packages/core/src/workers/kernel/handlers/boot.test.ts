import { describe, expect, it } from "vitest";
import { createState } from "../../../protocols/state";
import { createFakeFetcherWorker } from "../../../testing/fakeFetcherWorker";
import { createFakeFsWorker } from "../../../testing/fakeFsWorker";
import { createFakeProcessWorker } from "../../../testing/fakeProcessWorker";
import { IWorkerState } from "../models";
import { createBootHandler } from "./boot";

const run = (handler: ReturnType<typeof createBootHandler>) => {
  const stateManager = createState<IWorkerState>({ kernel: null });
  const posted: unknown[] = [];
  const done = handler({
    event: { data: { type: "boot" } } as MessageEvent,
    stateManager,
    onPostMessage: (m) => posted.push(m),
  });
  return { stateManager, posted, done: Promise.resolve(done) };
};

describe("boot handler", () => {
  it("installs the kernel and only then announces ready", async () => {
    const { worker } = createFakeFsWorker();
    const { stateManager, posted, done } = run(
      createBootHandler({
        createFsWorker: () => worker,
        createProcessWorker: () => createFakeProcessWorker(),
        createFetcherWorker: () => createFakeFetcherWorker(),
      }),
    );
    expect(posted).toEqual([]);
    await done;
    expect(stateManager.getState().kernel).not.toBeNull();
    expect(posted).toEqual([{ type: "ready" }]);
  });

  it("does not announce ready when the fs worker fails", async () => {
    const { worker } = createFakeFsWorker(undefined, { fail: "boom" });
    const { posted, done } = run(
      createBootHandler({
        createFsWorker: () => worker,
        createProcessWorker: () => createFakeProcessWorker(),
        createFetcherWorker: () => createFakeFetcherWorker(),
      }),
    );
    await expect(done).rejects.toThrow("boom");
    expect(posted).toEqual([]);
  });

  it("does not announce ready when the fetcher worker fails", async () => {
    const { worker } = createFakeFsWorker();
    const { posted, done } = run(
      createBootHandler({
        createFsWorker: () => worker,
        createProcessWorker: () => createFakeProcessWorker(),
        createFetcherWorker: () => createFakeFetcherWorker({ fail: "boom" }),
      }),
    );
    await expect(done).rejects.toThrow("boom");
    expect(posted).toEqual([]);
  });
});

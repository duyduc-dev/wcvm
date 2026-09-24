import { describe, expect, it, vi } from "vitest";
import { FD_CHUNK } from "../../protocols/syscall";
import { createLoopbackFs } from "../../testing/loopbackFs";
import { createFetcherRuntime, MAX_CONCURRENT } from "./fetcherRuntime";
import type { FetcherEvent } from "./messages";

/** A minimal fake Response - only the surface fetcherRuntime.ts actually reads. */
const fakeResponse = (body: Uint8Array | null, init: { status?: number; statusText?: string; headers?: [string, string][] } = {}) => {
  const { status = 200, statusText = "OK", headers = [] } = init;
  let read = false;
  return {
    ok: status >= 200 && status < 300,
    status,
    statusText,
    headers: { entries: () => headers[Symbol.iterator]() },
    body: body === null ? null : {
      getReader: () => ({
        read: async () => {
          if (read) return { done: true, value: undefined };
          read = true;
          return { done: false, value: body };
        },
      }),
    },
  } as unknown as Response;
};

const setup = () => {
  const { fs } = createLoopbackFs();
  const posted: FetcherEvent[] = [];
  const post = (event: FetcherEvent) => posted.push(event);
  return { fs, posted, post };
};

describe("fetcherRuntime", () => {
  it("writes a successful response's body to the given path and posts fetch:done", async () => {
    const { fs, posted, post } = setup();
    const fetchImpl = vi.fn().mockResolvedValue(fakeResponse(new TextEncoder().encode("hello"), { headers: [["content-type", "text/plain"]] }));
    const runtime = createFetcherRuntime({ fs, post, fetchImpl });

    runtime.enqueue({ type: "fetch", id: 1, url: "https://example.test/a", path: "/a.txt" });
    await vi.waitFor(() => expect(posted).toHaveLength(1));

    expect(fetchImpl).toHaveBeenCalledWith("https://example.test/a");
    expect(posted[0]).toEqual({ type: "fetch:done", id: 1, status: 200, headers: [["content-type", "text/plain"]] });
    expect(new TextDecoder().decode(fs.readFile("/a.txt"))).toBe("hello");
  });

  it("a non-ok response posts fetch:error and never writes the destination file", async () => {
    const { fs, posted, post } = setup();
    const fetchImpl = vi.fn().mockResolvedValue(fakeResponse(null, { status: 404, statusText: "Not Found" }));
    const runtime = createFetcherRuntime({ fs, post, fetchImpl });

    runtime.enqueue({ type: "fetch", id: 1, url: "https://example.test/missing", path: "/missing.txt" });
    await vi.waitFor(() => expect(posted).toHaveLength(1));

    expect(posted[0]).toMatchObject({ type: "fetch:error", id: 1, code: "EHTTP404" });
    expect(fs.exists("/missing.txt")).toBe(false);
  });

  it("a rejected fetch() (network error) posts fetch:error with its message", async () => {
    const { fs, posted, post } = setup();
    const fetchImpl = vi.fn().mockRejectedValue(new Error("network down"));
    const runtime = createFetcherRuntime({ fs, post, fetchImpl });

    runtime.enqueue({ type: "fetch", id: 1, url: "https://example.test/a", path: "/a.txt" });
    await vi.waitFor(() => expect(posted).toHaveLength(1));

    expect(posted[0]).toEqual({ type: "fetch:error", id: 1, message: "network down", code: undefined });
  });

  it("a response with no body still creates an empty file", async () => {
    const { fs, posted, post } = setup();
    const fetchImpl = vi.fn().mockResolvedValue(fakeResponse(null));
    const runtime = createFetcherRuntime({ fs, post, fetchImpl });

    runtime.enqueue({ type: "fetch", id: 1, url: "https://example.test/empty", path: "/empty.txt" });
    await vi.waitFor(() => expect(posted).toHaveLength(1));

    expect(fs.readFile("/empty.txt")).toHaveLength(0);
  });

  it("a single chunk bigger than the syscall window is split across multiple fd writes", async () => {
    const { fs, posted, post } = setup();
    // Just over one FD_CHUNK, so this still forces exactly two fs.write() calls without paying
    // for several megabytes of typed-array fill/compare under Vitest's slower instrumented
    // module transforms (the same logic takes single-digit milliseconds outside Vitest).
    const big = new Uint8Array(FD_CHUNK + 100);
    for (let i = 0; i < big.length; i++) big[i] = i % 256;
    const fetchImpl = vi.fn().mockResolvedValue(fakeResponse(big));
    const runtime = createFetcherRuntime({ fs, post, fetchImpl });

    runtime.enqueue({ type: "fetch", id: 1, url: "https://example.test/big", path: "/big.bin" });
    await vi.waitFor(() => expect(posted).toHaveLength(1));

    expect(fs.readFile("/big.bin")).toEqual(big);
  }, 20_000); // pushes >1 MiB through the syscall window: ~2s alone, occasionally past 5s under load

  it("runs at most MAX_CONCURRENT fetches at once, starting the next once one finishes", async () => {
    const { fs, posted, post } = setup();
    const resolvers: Array<() => void> = [];
    // Phase 1 (`controlled`): every fetchImpl call parks on a manually-triggered resolver, so the
    // test can prove the cap by counting how many calls happen before anything is allowed to
    // finish. Phase 2 lets every call - already-parked or still to come - resolve on its own, so
    // the remaining queue drains without the test having to keep re-draining new resolvers as
    // they appear (which a naive one-shot splice() would miss).
    let controlled = true;
    const fetchImpl = vi.fn().mockImplementation(
      () =>
        new Promise<Response>((resolve) => {
          const respond = () => resolve(fakeResponse(new Uint8Array(0)));
          if (controlled) resolvers.push(respond);
          else respond();
        }),
    );
    const runtime = createFetcherRuntime({ fs, post, fetchImpl });

    const total = MAX_CONCURRENT + 3;
    for (let i = 0; i < total; i++) {
      runtime.enqueue({ type: "fetch", id: i, url: `https://example.test/${i}`, path: `/${i}.txt` });
    }
    await vi.waitFor(() => expect(fetchImpl).toHaveBeenCalledTimes(MAX_CONCURRENT));
    // Still only MAX_CONCURRENT calls, even though `total` (more) were queued - the rest are
    // waiting their turn, not already in flight.
    expect(resolvers).toHaveLength(MAX_CONCURRENT);

    controlled = false;
    for (const resolve of resolvers.splice(0)) resolve();

    await vi.waitFor(() => expect(posted).toHaveLength(total));
    expect(fetchImpl).toHaveBeenCalledTimes(total);
  });
});

import { describe, expect, it } from "vitest";
import { createFetcher } from "./fetcher";
import type { FetcherEvent } from "../workers/fetcher/messages";

const setup = () => {
  const posted: unknown[] = [];
  const fetcher = createFetcher({ postMessage: (m) => posted.push(m) });
  return { fetcher, posted };
};

describe("kernel fetcher", () => {
  it("posts a fetch request with an incrementing id, and resolves on fetch:done", async () => {
    const { fetcher, posted } = setup();
    const p = fetcher.fetch("https://example.test/a", "/a.txt");
    expect(posted).toEqual([{ type: "fetch", id: 1, url: "https://example.test/a", path: "/a.txt" }]);

    fetcher.dispatch({ type: "fetch:done", id: 1, status: 200, headers: [["x", "y"]] });
    await expect(p).resolves.toEqual({ status: 200, headers: [["x", "y"]] });
  });

  it("rejects with the error's message and code on fetch:error", async () => {
    const { fetcher } = setup();
    const p = fetcher.fetch("https://example.test/missing", "/m.txt");
    fetcher.dispatch({ type: "fetch:error", id: 1, message: "fetch failed: 404 Not Found", code: "EHTTP404" });
    await expect(p).rejects.toMatchObject({ message: "fetch failed: 404 Not Found", code: "EHTTP404" });
  });

  it("each concurrent fetch gets its own id, and resolves independently regardless of reply order", async () => {
    const { fetcher, posted } = setup();
    const p1 = fetcher.fetch("https://example.test/1", "/1.txt");
    const p2 = fetcher.fetch("https://example.test/2", "/2.txt");
    expect(posted).toEqual([
      { type: "fetch", id: 1, url: "https://example.test/1", path: "/1.txt" },
      { type: "fetch", id: 2, url: "https://example.test/2", path: "/2.txt" },
    ]);

    fetcher.dispatch({ type: "fetch:done", id: 2, status: 200, headers: [] });
    fetcher.dispatch({ type: "fetch:done", id: 1, status: 200, headers: [] });
    await expect(p1).resolves.toEqual({ status: 200, headers: [] });
    await expect(p2).resolves.toEqual({ status: 200, headers: [] });
  });

  it("ignores a ready event and a reply for an unknown/already-resolved id", () => {
    const { fetcher } = setup();
    const events: FetcherEvent[] = [
      { type: "ready" },
      { type: "fetch:done", id: 999, status: 200, headers: [] },
    ];
    for (const event of events) expect(() => fetcher.dispatch(event)).not.toThrow();
  });
});

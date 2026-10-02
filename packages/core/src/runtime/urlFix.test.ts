import { describe, expect, it } from "vitest";
import { withFileUrlFix } from "./fileUrlFix";

// A URL that parses "file:/a/b" the way the affected browsers do (host "a"), built on the real one.
class BrokenURL extends URL {
  constructor(input: string | URL, base?: string | URL) {
    const text = String(input);
    super(/^file:\/(?!\/)/.test(text) ? `file://x${text.slice(5)}` : input, base);
    if (/^file:\/(?!\/)/.test(text)) Object.defineProperty(this, "hostname", { value: text.slice(6).split("/")[0] });
  }
}

describe("withFileUrlFix", () => {
  it("returns the native URL untouched when the browser parses file:/a/b correctly", () => {
    expect(withFileUrlFix(URL)).toBe(URL);
  });

  it("rewrites a single-slash file: URL where the browser would invent a host", () => {
    const Fixed = withFileUrlFix(BrokenURL as unknown as typeof URL);
    expect(Fixed).not.toBe(BrokenURL);
    expect(new Fixed("file:/home/user/x.cjs").hostname).toBe("");
    expect(new Fixed("file:/home/user/x.cjs").href).toBe("file:///home/user/x.cjs");
    expect(new Fixed("file:///home/user/x.cjs").href).toBe("file:///home/user/x.cjs");
    expect(new Fixed("https://example.com/a").href).toBe("https://example.com/a");
    expect(Fixed.canParse("file:/a/b")).toBe(true);
    // The other shape: a pathname set on `file://` came out as `file:////home/...` in the same browsers.
    expect(new Fixed("file:////home/user/x.mjs").href).toBe("file:///home/user/x.mjs");
    expect(new Fixed("file:////home/user/x.mjs").hostname).toBe("");
  });
});

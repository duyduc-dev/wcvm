/**
 * Some browsers (Chrome on Windows, found for real) parse `new URL("file:/a/b")` with "a" as the
 * HOST (`file://a/b`) instead of the spec's `file:///a/b`. Node's `fileURLToPath` then throws ERR_INVALID_FILE_URL_HOST - hit for real
 * by `babel-dead-code-elimination`'s `new URL("file:" + __filename)` (React Router 7's dev server
 * loads it). Where the browser has that bug, wrap URL so a single-slash `file:` URL is rewritten to
 * the three-slash form first; a browser that parses it correctly gets its own URL back untouched.
 */
export const withFileUrlFix = (Native: typeof URL): typeof URL => {
  try {
    // Both shapes the affected browsers get wrong: a single slash, and a pathname set on `file://`.
    const viaPathname = new Native("file://");
    viaPathname.pathname = "/a/b";
    if (new Native("file:/a/b").hostname === "" && viaPathname.href === "file:///a/b") return Native;
  } catch {
    return Native;
  }
  const fix = (input: string | URL): string | URL => {
    const text = String(input);
    // `file:/a/b` -> `file:///a/b`; and `file:////a/b` (an empty segment before the path, which
    // the same browsers produce when a pathname is set on `file://`) -> `file:///a/b`.
    if (/^file:\/(?!\/)/i.test(text)) return `file://${text.slice(5)}`;
    return /^file:\/{4,}/i.test(text) ? text.replace(/^file:\/+/i, "file:///") : input;
  };
  const Fixed = class extends Native {
    constructor(input: string | URL, base?: string | URL) {
      super(fix(input), base === undefined ? undefined : fix(base));
    }
    static canParse(input: string | URL, base?: string | URL): boolean {
      return Native.canParse(fix(input), base === undefined ? undefined : fix(base));
    }
  };
  Object.defineProperty(Fixed, "name", { value: "URL" });
  return Fixed;
};

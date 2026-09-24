// What Node's public `url` module (lib/url.js, vendored verbatim) reaches for in C++: real Node
// backs all three with ada, its C++ WHATWG URL parser. The platform ships the same standard, so
// each is a thin layer over the browser's own URL/URLPattern - captured at module load, since
// `globalObject: self` later puts Node's own same-named globals over the platform's (CLAUDE.md's
// "never call a global by its bare name" gotcha).

const NativeURL = globalThis.URL;
const NativeURLPattern = (globalThis as { URLPattern?: unknown }).URLPattern;

/** The host a WHATWG URL parser would produce (punycode for IDNs) - or "" if it isn't a valid
 *  host at all, which is what ada's own `to_ascii` reports for a failure. */
const toASCII = (input: string): string => {
  if (input === "") return "";
  try {
    return new NativeURL(`http://${input}`).hostname;
  } catch {
    return "";
  }
};

/** `internalBinding('encoding_binding')`: only the IDNA half - TextEncoder/TextDecoder's own half
 *  is `internal/encoding`, shimmed over the platform's (runtime/shims.ts), so nothing asks for it. */
export const createEncodingBinding = () => ({ toASCII });

/** `internalBinding('url_pattern')`: the platform's own WHATWG URLPattern, where there is one
 *  (Chromium has shipped it since v95; Node's is the same standard). */
export const createUrlPatternBinding = () => ({
  URLPattern:
    NativeURLPattern ??
    class URLPattern {
      constructor() {
        throw new TypeError("URLPattern is not supported by this browser");
      }
    },
});

/**
 * `internalBinding('url')`: just `format`, what `url.format(urlObject, options)` calls for a
 * WHATWG URL - reparse `href`, then drop whichever parts the options turned off. `unicode` (show an
 * IDN host in Unicode rather than punycode) isn't honoured: the platform URL has no punycode
 * decoder to ask, so the host stays in its ASCII form.
 */
export const createUrlBinding = () => ({
  format: (href: string, fragment: boolean, _unicode: boolean, search: boolean, auth: boolean): string => {
    const url = new NativeURL(href);
    if (!fragment) url.hash = "";
    if (!search) url.search = "";
    if (!auth) {
      url.username = "";
      url.password = "";
    }
    return url.href;
  },
});

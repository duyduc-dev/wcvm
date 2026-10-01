import { describe, expect, it } from "vitest";
import { chooseHost, previewPortOf, routePreviewRequest, type IHostCandidate, type IRoutableRequest, type PreviewClientPorts } from "./previewRouting";

const ORIGIN = "http://localhost:4173";

const request = (overrides: Partial<IRoutableRequest>): IRoutableRequest => ({
  url: `${ORIGIN}/`,
  mode: "cors",
  referrer: "",
  clientId: "",
  resultingClientId: "",
  ...overrides,
});

describe("previewPortOf", () => {
  it("is the port of a same-origin preview URL, and undefined for anything else", () => {
    expect(previewPortOf(`${ORIGIN}/__wcvm_preview__/5173/src/a.ts`, ORIGIN)).toBe(5173);
    expect(previewPortOf(`${ORIGIN}/src/a.ts`, ORIGIN)).toBeUndefined();
    expect(previewPortOf("http://elsewhere.test/__wcvm_preview__/5173/", ORIGIN)).toBeUndefined();
  });
});

describe("routePreviewRequest", () => {
  it("relays a preview URL to its guest port, query included", () => {
    const ports: PreviewClientPorts = new Map();
    expect(routePreviewRequest(request({ url: `${ORIGIN}/__wcvm_preview__/3000/api/x?y=1` }), ORIGIN, ports)).toEqual({
      kind: "guest",
      port: 3000,
      path: "/api/x?y=1",
    });
  });

  it("remembers which port a previewed document was served from, keyed by its new client id", () => {
    const ports: PreviewClientPorts = new Map();
    routePreviewRequest(request({ url: `${ORIGIN}/__wcvm_preview__/5173/`, mode: "navigate", resultingClientId: "frame-1" }), ORIGIN, ports);
    expect(ports.get("frame-1")).toBe(5173);
  });

  it("redirects that document's own absolute-path requests into its port's prefix", () => {
    const ports: PreviewClientPorts = new Map([["frame-1", 5173]]);
    for (const path of ["/@vite/client", "/src/main.ts?t=123", "/node_modules/.vite/deps/react.js?v=1"]) {
      expect(routePreviewRequest(request({ url: `${ORIGIN}${path}`, clientId: "frame-1" }), ORIGIN, ports)).toEqual({
        kind: "redirect",
        location: `${ORIGIN}/__wcvm_preview__/5173${path}`,
      });
    }
  });

  it("leaves a known non-preview client's requests alone", () => {
    const ports: PreviewClientPorts = new Map([["host-page", null]]);
    expect(routePreviewRequest(request({ url: `${ORIGIN}/assets/app.js`, clientId: "host-page" }), ORIGIN, ports)).toEqual({ kind: "passthrough" });
  });

  it("asks for a lookup when the client has never been seen (e.g. after a Service Worker restart)", () => {
    const ports: PreviewClientPorts = new Map();
    expect(routePreviewRequest(request({ url: `${ORIGIN}/src/a.ts`, clientId: "unknown" }), ORIGIN, ports)).toEqual({ kind: "lookup", clientId: "unknown" });
  });

  it("a request with no client at all is left alone", () => {
    expect(routePreviewRequest(request({ url: `${ORIGIN}/x` }), ORIGIN, new Map())).toEqual({ kind: "passthrough" });
  });

  it("a cross-origin request is always left alone, even from a previewed document", () => {
    const ports: PreviewClientPorts = new Map([["frame-1", 5173]]);
    expect(routePreviewRequest(request({ url: "https://cdn.example/lib.js", clientId: "frame-1" }), ORIGIN, ports)).toEqual({ kind: "passthrough" });
  });

  it("a previewed page navigating to one of its own absolute paths is redirected into its prefix", () => {
    const ports: PreviewClientPorts = new Map();
    const route = routePreviewRequest(
      request({ url: `${ORIGIN}/about?tab=2`, mode: "navigate", referrer: `${ORIGIN}/__wcvm_preview__/3000/`, resultingClientId: "next" }),
      ORIGIN,
      ports,
    );
    expect(route).toEqual({ kind: "redirect", location: `${ORIGIN}/__wcvm_preview__/3000/about?tab=2` });
    expect(ports.has("next")).toBe(false); // the redirected-to navigation records it instead
  });

  it("an ordinary navigation is left alone and its client remembered as not a preview", () => {
    const ports: PreviewClientPorts = new Map();
    const route = routePreviewRequest(request({ url: `${ORIGIN}/`, mode: "navigate", referrer: `${ORIGIN}/other`, resultingClientId: "host" }), ORIGIN, ports);
    expect(route).toEqual({ kind: "passthrough" });
    expect(ports.get("host")).toBeNull();
  });

  it("a navigation to a bare preview port gets its trailing slash first, so its relative URLs stay inside it", () => {
    const ports: PreviewClientPorts = new Map();
    expect(routePreviewRequest(request({ url: `${ORIGIN}/__wcvm_preview__/3000?x=1`, mode: "navigate" }), ORIGIN, ports)).toEqual({
      kind: "redirect",
      location: `${ORIGIN}/__wcvm_preview__/3000/?x=1`,
    });
    // A fetch() of the same bare URL is just relayed - only a document's own base URL matters.
    expect(routePreviewRequest(request({ url: `${ORIGIN}/__wcvm_preview__/3000` }), ORIGIN, ports)).toEqual({ kind: "guest", port: 3000, path: "/" });
  });
});

describe("chooseHost", () => {
  const host = (client: string, overrides: Partial<IHostCandidate<string>> = {}): IHostCandidate<string> => ({
    client,
    listening: false,
    visible: false,
    focused: false,
    ...overrides,
  });

  it("picks the only page that has a server on the port, even when another is focused", () => {
    // The reported bug: the first/focused tab has nothing on :3000, the other tab runs the server.
    expect(chooseHost([host("a", { visible: true, focused: true }), host("b", { listening: true })])).toBe("b");
  });

  it("among several that listen, prefers the focused one, then a visible one, then the first", () => {
    expect(chooseHost([host("a", { listening: true }), host("b", { listening: true, visible: true, focused: true })])).toBe("b");
    expect(chooseHost([host("a", { listening: true }), host("b", { listening: true, visible: true })])).toBe("b");
    expect(chooseHost([host("a", { listening: true }), host("b", { listening: true })])).toBe("a");
    expect(chooseHost([host("a", { listening: true, visible: true }), host("b", { listening: true, focused: true })])).toBe("b");
  });

  it("ignores focus and visibility of pages that are not listening when another one is", () => {
    expect(chooseHost([host("a", { visible: true, focused: true }), host("b", { listening: true }), host("c", { listening: true, visible: true })])).toBe("c");
  });

  it("when nobody listens, still picks one (the guest's own ECONNREFUSED comes back), the visible one first", () => {
    expect(chooseHost([host("a"), host("b", { visible: true })])).toBe("b");
    expect(chooseHost([host("a"), host("b")])).toBe("a");
  });

  it("has nothing to choose from no pages", () => {
    expect(chooseHost([])).toBeUndefined();
  });
});

import type { IPreviewApi } from "wcvm";
import type { PreviewTab } from "./types";

export function createPreviewTab(id: string, port: number, path = "/"): PreviewTab {
  return { id, port, path, url: `localhost:${port}${path}` };
}

export function createEmptyPreviewTab(id: string): PreviewTab {
  return { id, port: null, path: "/", url: "" };
}

export const previewSrc = (preview: IPreviewApi, tab: PreviewTab): string =>
  tab.port == null ? "about:blank" : preview.url(tab.port, tab.path);

/** Parses what the user typed into the address bar — "3000", "3000/api", "localhost:3000/api" —
 * into a virtual port + path. Anything that isn't a bare port (an external URL, garbage input)
 * is rejected: only a local dev server this VM is actually running can be previewed. */
export function parseAddress(raw: string): { port: number; path: string } | null {
  const withoutScheme = raw.trim().replace(/^https?:\/\//, "");
  const withoutHost = withoutScheme.replace(/^(localhost|127\.0\.0\.1)(?=[:/]|$)/, "");
  const stripped = withoutHost.startsWith(":") ? withoutHost.slice(1) : withoutHost;
  const match = /^(\d+)(\/.*)?$/.exec(stripped);
  if (!match) return null;
  const port = Number(match[1]);
  if (!Number.isFinite(port) || port <= 0) return null;
  return { port, path: match[2] || "/" };
}

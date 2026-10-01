import { isOverlay } from "../service/highlight";

export const VOID_TAGS = new Set(["area", "base", "br", "col", "embed", "hr", "img", "input", "link", "meta", "source", "track", "wbr"]);

/** Child nodes worth a row: elements, comments and non-blank text; never our own highlight box. */
export const visibleChildren = (node: Node): Node[] =>
  Array.from(node.childNodes).filter((n) => {
    if (isOverlay(n)) return false;
    if (n.nodeType === 1 || n.nodeType === 8) return true;
    return n.nodeType === 3 && (n.textContent ?? "").trim() !== "";
  });

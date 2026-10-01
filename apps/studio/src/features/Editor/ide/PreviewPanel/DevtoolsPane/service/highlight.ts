const OVERLAY_ID = "__wcvm_inspector_overlay";

export const isOverlay = (node: Node | null): boolean => (node as Element | null)?.id === OVERLAY_ID;

/** Draws DevTools' blue "this is the node" box over `el` inside its own page (an absolutely
 * positioned, click-through div - the preview is same-origin, so the host can add it directly).
 * `null` hides it. */
export function highlightElement(doc: Document, el: Element | null): void {
  let box = doc.getElementById(OVERLAY_ID) as HTMLElement | null;
  if (!el || !el.isConnected) {
    if (box) box.style.display = "none";
    return;
  }
  if (!box) {
    box = doc.createElement("div");
    box.id = OVERLAY_ID;
    box.style.cssText =
      "position:absolute;pointer-events:none;z-index:2147483647;box-sizing:border-box;" +
      "background:rgba(111,168,220,.35);border:1px solid #3b82f6;";
    doc.documentElement.appendChild(box);
  }
  const rect = el.getBoundingClientRect();
  const win = doc.defaultView;
  box.style.display = "block";
  box.style.left = `${rect.left + (win?.scrollX ?? 0)}px`;
  box.style.top = `${rect.top + (win?.scrollY ?? 0)}px`;
  box.style.width = `${rect.width}px`;
  box.style.height = `${rect.height}px`;
}

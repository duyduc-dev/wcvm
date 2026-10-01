import { CursorClickIcon } from "@phosphor-icons/react";
import { useEffect, useState, useSyncExternalStore } from "react";
import { cn } from "@/lib/utils";
import type { FrameConsole } from "../service/frameConsole";
import { highlightElement, isOverlay } from "../service/highlight";
import { Details } from "./Details";
import { TreeNode, type TreeContext } from "./TreeNode";

interface View {
  doc: Document | null;
  /** Nodes whose open/closed state the user flipped away from its default. */
  toggled: Set<Node>;
  selected: Element | null;
  picking: boolean;
}

const freshView = (doc: Document | null): View => ({ doc, toggled: new Set(), selected: null, picking: false });

/** `html`, `head` and `body` start open; everything else starts closed. Defaults are derived, not
 * seeded once: the document is hooked while still parsing, so any of them may not exist yet. */
const isDefaultOpen = (doc: Document, n: Node): boolean =>
  n === doc.documentElement || n === doc.head || n === doc.body;

const isOpenIn = (view: View, n: Node): boolean =>
  view.doc != null && isDefaultOpen(view.doc, n) !== view.toggled.has(n);

/** Selects `el` and opens every closed ancestor so it's visible in the tree. */
const selectIn = (v: View, el: Element): View => {
  const toggled = new Set(v.toggled);
  for (let p = el.parentNode; p; p = p.parentNode) {
    if (!isOpenIn(v, p)) {
      if (toggled.has(p)) toggled.delete(p);
      else toggled.add(p);
    }
  }
  return { ...v, toggled, selected: el };
};

export function ElementsPane({ store }: { store: FrameConsole }) {
  useSyncExternalStore(store.subscribe, store.getVersion);
  const doc = store.document;
  const [stored, setView] = useState<View>(() => freshView(doc));
  // The tree reads a DOM React doesn't own: bumping `version` is what tells the (compiler-
  // memoized) rows and details pane that the page changed underneath them.
  const [version, setTick] = useState(0);

  // A new document (navigation / full reload) invalidates every node we held on to.
  let view = stored;
  if (stored.doc !== doc) {
    view = freshView(doc);
    setView(view);
  }
  const { selected, picking } = view;

  // Live DOM: re-render (coalesced to one per frame) whenever the page mutates.
  useEffect(() => {
    if (!doc) return;
    let raf = 0;
    const observer = new MutationObserver((records) => {
      // Ignore our own highlight box (an attribute record has no added/removed nodes at all).
      const ours = (r: MutationRecord): boolean => {
        const moved = [...r.addedNodes, ...r.removedNodes];
        return isOverlay(r.target) || (moved.length > 0 && moved.every(isOverlay));
      };
      if (records.every(ours)) return;
      cancelAnimationFrame(raf);
      raf = requestAnimationFrame(() => setTick((n) => n + 1));
    });
    observer.observe(doc, { subtree: true, childList: true, attributes: true, characterData: true });
    return () => {
      observer.disconnect();
      cancelAnimationFrame(raf);
    };
  }, [doc]);

  const select = (el: Element): void => {
    setView((v) => selectIn(v, el));
    store.setInspected(el);
  };

  const setPicking = (next: boolean): void => setView((v) => ({ ...v, picking: next }));

  // Inspect mode: hover highlights, click selects (and swallows the page's own click handler).
  useEffect(() => {
    if (!picking || !doc) return;
    const onMove = (e: MouseEvent): void => highlightElement(doc, e.target as Element);
    const onClick = (e: MouseEvent): void => {
      e.preventDefault();
      e.stopPropagation();
      const el = e.target as Element;
      setView((v) => ({ ...selectIn(v, el), picking: false }));
      store.setInspected(el);
    };
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === "Escape") setView((v) => ({ ...v, picking: false }));
    };
    doc.addEventListener("mousemove", onMove, true);
    doc.addEventListener("click", onClick, true);
    doc.addEventListener("keydown", onKey, true);
    return () => {
      doc.removeEventListener("mousemove", onMove, true);
      doc.removeEventListener("click", onClick, true);
      doc.removeEventListener("keydown", onKey, true);
      highlightElement(doc, selected);
    };
  }, [picking, doc, store, selected]);

  useEffect(() => {
    if (!doc) return;
    highlightElement(doc, null);
    return () => highlightElement(doc, null);
  }, [doc]);

  const ctx: TreeContext = {
    version,
    isOpen: (n) => isOpenIn(view, n),
    selected,
    toggle: (n) =>
      setView((v) => {
        const toggled = new Set(v.toggled);
        if (toggled.has(n)) toggled.delete(n);
        else toggled.add(n);
        return { ...v, toggled };
      }),
    select,
    hover: (el) => doc && highlightElement(doc, el ?? selected),
  };

  if (!doc?.documentElement) {
    return <div className="p-2 text-xs text-muted-foreground">No page loaded.</div>;
  }

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex h-7 shrink-0 items-center gap-1 border-b px-1.5">
        <button
          title="Select an element in the page"
          aria-label="Select an element in the page"
          aria-pressed={picking}
          onClick={() => setPicking(!picking)}
          className={cn(
            "flex size-5 items-center justify-center rounded hover:bg-accent hover:text-foreground",
            picking ? "bg-accent text-primary" : "text-muted-foreground",
          )}
        >
          <CursorClickIcon className="size-3.5" />
        </button>
        <span className="text-[11px] text-muted-foreground">{picking ? "Click an element in the page (Esc to cancel)" : ""}</span>
      </div>
      <div className="flex min-h-0 flex-1">
        <div className="min-w-0 flex-1 overflow-auto font-mono text-xs">
          <TreeNode node={doc.documentElement} depth={0} ctx={ctx} />
        </div>
        {selected && (
          <div className="w-64 shrink-0 overflow-auto border-l">
            <Details
              el={selected}
              version={version}
              refresh={() => {
                setView((v) => ({ ...v, selected: null }));
                setTick((n) => n + 1);
              }}
            />
          </div>
        )}
      </div>
    </div>
  );
}

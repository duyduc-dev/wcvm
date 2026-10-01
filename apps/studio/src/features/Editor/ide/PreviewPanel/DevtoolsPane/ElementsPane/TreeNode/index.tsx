import { CaretDownIcon, CaretRightIcon } from "@phosphor-icons/react";
import { cn } from "@/lib/utils";
import { VOID_TAGS, visibleChildren } from "../utils";

export interface TreeContext {
  /** Changes whenever the page's DOM does, so memoized rows re-read it. */
  version: number;
  isOpen: (n: Node) => boolean;
  selected: Element | null;
  toggle: (n: Node) => void;
  select: (el: Element) => void;
  hover: (el: Element | null) => void;
}

// `_version` keeps the compiler from caching the result on `el` alone: attributes mutate in place.
function openTag(el: Element, _version: number): React.ReactNode {
  void _version;
  return (
    <>
      <span className="text-purple-600 dark:text-purple-400">&lt;{el.localName}</span>
      {Array.from(el.attributes).map((a) => (
        <span key={a.name}>
          {" "}
          <span className="text-amber-700 dark:text-amber-300">{a.name}</span>
          {a.value !== "" && (
            <>
              =<span className="text-sky-700 dark:text-sky-300">"{a.value.length > 60 ? a.value.slice(0, 60) + "…" : a.value}"</span>
            </>
          )}
        </span>
      ))}
      <span className="text-purple-600 dark:text-purple-400">&gt;</span>
    </>
  );
}

export function TreeNode({ node, depth, ctx }: { node: Node; depth: number; ctx: TreeContext }) {
  const pad = { paddingLeft: depth * 12 + 4 };
  if (node.nodeType === 3) {
    return (
      <div style={pad} className="truncate py-px pl-4 text-muted-foreground">
        {(node.textContent ?? "").trim()}
      </div>
    );
  }
  if (node.nodeType === 8) {
    return (
      <div style={pad} className="truncate py-px pl-4 text-green-700 dark:text-green-400">
        {`<!--${node.textContent ?? ""}-->`}
      </div>
    );
  }
  const el = node as Element;
  const kids = VOID_TAGS.has(el.localName) ? [] : visibleChildren(el);
  const open = ctx.isOpen(el);
  const isSelected = ctx.selected === el;
  return (
    <>
      <div
        style={pad}
        onClick={() => ctx.select(el)}
        onMouseEnter={() => ctx.hover(el)}
        onMouseLeave={() => ctx.hover(null)}
        className={cn("flex cursor-default items-center whitespace-nowrap py-px", isSelected ? "bg-accent" : "hover:bg-accent/50")}
      >
        {kids.length > 0 ? (
          <button
            aria-label={open ? "Collapse" : "Expand"}
            onClick={(e) => {
              e.stopPropagation();
              ctx.toggle(el);
            }}
            className="flex size-4 shrink-0 items-center justify-center text-muted-foreground"
          >
            {open ? <CaretDownIcon className="size-3" /> : <CaretRightIcon className="size-3" />}
          </button>
        ) : (
          <span className="size-4 shrink-0" />
        )}
        <span>{openTag(el, ctx.version)}</span>
        {kids.length > 0 && !open && <span className="text-muted-foreground">…</span>}
        {kids.length > 0 && !open && <span className="text-purple-600 dark:text-purple-400">&lt;/{el.localName}&gt;</span>}
      </div>
      {open && kids.map((k, i) => <TreeNode key={i} node={k} depth={depth + 1} ctx={ctx} />)}
      {open && (
        <div style={{ paddingLeft: depth * 12 + 4 + 16 }} className="py-px text-purple-600 dark:text-purple-400">
          &lt;/{el.localName}&gt;
        </div>
      )}
    </>
  );
}

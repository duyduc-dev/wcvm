import { TrashIcon } from "@phosphor-icons/react";

// `version` is unused in the body on purpose: it only makes the props differ when the page's DOM
// changes, which would otherwise be invisible to the memoized render.
export function Details({ el, refresh }: { el: Element; version: number; refresh: () => void }) {
  const rect = el.getBoundingClientRect();
  const outer = el.outerHTML;
  return (
    <div className="space-y-2 p-2 text-xs">
      <div className="flex items-center justify-between">
        <span className="font-mono font-medium">
          {el.localName}
          {el.id ? `#${el.id}` : ""}
        </span>
        <button
          title="Delete element"
          aria-label="Delete element"
          onClick={() => {
            el.remove();
            refresh();
          }}
          className="flex size-5 items-center justify-center rounded text-muted-foreground hover:bg-accent hover:text-foreground"
        >
          <TrashIcon className="size-3.5" />
        </button>
      </div>
      <div className="text-muted-foreground">
        {Math.round(rect.width)} × {Math.round(rect.height)} px
      </div>
      <div>
        <div className="mb-1 font-medium text-muted-foreground">Attributes</div>
        {el.attributes.length === 0 && <div className="text-muted-foreground">none</div>}
        {Array.from(el.attributes).map((a) => (
          <label key={a.name} className="mb-0.5 flex items-center gap-1 font-mono">
            <span className="w-20 shrink-0 truncate text-amber-700 dark:text-amber-300">{a.name}</span>
            <input
              key={a.value}
              defaultValue={a.value}
              spellCheck={false}
              onBlur={(e) => {
                if (e.target.value !== a.value) el.setAttribute(a.name, e.target.value);
              }}
              onKeyDown={(e) => e.key === "Enter" && (e.target as HTMLInputElement).blur()}
              className="min-w-0 flex-1 rounded bg-background px-1 outline-none ring-1 ring-border focus:ring-primary"
            />
          </label>
        ))}
      </div>
      <div>
        <div className="mb-1 font-medium text-muted-foreground">HTML</div>
        <pre className="max-h-40 overflow-auto whitespace-pre-wrap break-all rounded bg-background p-1 font-mono">
          {outer.length > 4000 ? outer.slice(0, 4000) + "…" : outer}
        </pre>
      </div>
      <div className="text-muted-foreground">
        Available in the Console as <code className="font-mono">$0</code>.
      </div>
    </div>
  );
}

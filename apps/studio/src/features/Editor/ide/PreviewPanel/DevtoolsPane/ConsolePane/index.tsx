import { ProhibitIcon } from "@phosphor-icons/react";
import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import { cn } from "@/lib/utils";
import { FrameConsole, type ConsoleLevel } from "../service/frameConsole";

const LEVEL_STYLE: Record<ConsoleLevel, string> = {
  log: "",
  info: "text-sky-600 dark:text-sky-400",
  debug: "text-muted-foreground",
  warn: "bg-yellow-500/10 text-yellow-700 dark:text-yellow-300",
  error: "bg-red-500/10 text-red-600 dark:text-red-400",
  input: "text-muted-foreground",
  result: "text-muted-foreground",
};

const LEVEL_PREFIX: Record<ConsoleLevel, string> = {
  log: "",
  info: "",
  debug: "",
  warn: "⚠ ",
  error: "✖ ",
  input: "› ",
  result: "‹ ",
};

const FILTERS: { id: ConsoleLevel | "all"; label: string }[] = [
  { id: "all", label: "All" },
  { id: "error", label: "Errors" },
  { id: "warn", label: "Warnings" },
  { id: "log", label: "Logs" },
];

export function ConsolePane({ store }: { store: FrameConsole }) {
  useSyncExternalStore(store.subscribe, store.getVersion);
  const [filter, setFilter] = useState<ConsoleLevel | "all">("all");
  const [input, setInput] = useState("");
  const history = useRef<string[]>([]);
  const historyIndex = useRef(0);
  const scroller = useRef<HTMLDivElement | null>(null);
  const stick = useRef(true);

  const entries = store
    .getEntries()
    .filter((e) => filter === "all" || e.level === filter || e.level === "input" || e.level === "result");

  useEffect(() => {
    const el = scroller.current;
    if (el && stick.current) el.scrollTop = el.scrollHeight;
  });

  const submit = (): void => {
    const expression = input.trim();
    if (!expression) return;
    if (history.current.at(-1) !== expression) history.current.push(expression);
    historyIndex.current = history.current.length;
    setInput("");
    store.evaluate(expression);
  };

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex h-7 shrink-0 items-center gap-1 border-b px-1.5">
        <button
          title="Clear console"
          aria-label="Clear console"
          onClick={() => store.clear()}
          className="flex size-5 items-center justify-center rounded text-muted-foreground hover:bg-accent hover:text-foreground"
        >
          <ProhibitIcon className="size-3.5" />
        </button>
        {FILTERS.map((f) => (
          <button
            key={f.id}
            onClick={() => setFilter(f.id)}
            className={cn(
              "rounded px-1.5 py-0.5 text-[11px]",
              filter === f.id ? "bg-accent text-foreground" : "text-muted-foreground hover:text-foreground",
            )}
          >
            {f.label}
          </button>
        ))}
      </div>
      <div
        ref={scroller}
        onScroll={(e) => {
          const el = e.currentTarget;
          stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < 24;
        }}
        className="min-h-0 flex-1 overflow-auto font-mono text-xs"
      >
        {entries.length === 0 && (
          <div className="p-2 text-muted-foreground">
            {store.document ? "Console is empty." : "No page loaded."}
          </div>
        )}
        {entries.map((e) => (
          <div
            key={e.id}
            className={cn("whitespace-pre-wrap break-words border-b border-border/40 px-2 py-0.5", LEVEL_STYLE[e.level])}
          >
            {LEVEL_PREFIX[e.level]}
            {e.text}
          </div>
        ))}
      </div>
      <div className="flex shrink-0 items-center gap-1 border-t px-2 font-mono text-xs">
        <span className="text-muted-foreground">›</span>
        <input
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") submit();
            else if (e.key === "ArrowUp" && historyIndex.current > 0) {
              e.preventDefault();
              historyIndex.current--;
              setInput(history.current[historyIndex.current]);
            } else if (e.key === "ArrowDown" && historyIndex.current < history.current.length) {
              e.preventDefault();
              historyIndex.current++;
              setInput(history.current[historyIndex.current] ?? "");
            }
          }}
          placeholder="Evaluate JavaScript in the page"
          spellCheck={false}
          className="h-7 w-full bg-transparent outline-none placeholder:text-muted-foreground"
        />
      </div>
    </div>
  );
}

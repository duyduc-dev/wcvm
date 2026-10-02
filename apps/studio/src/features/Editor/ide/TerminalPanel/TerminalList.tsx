import { SpinnerIcon, TerminalWindowIcon, TrashIcon } from "@phosphor-icons/react";
import { cn } from "@/lib/utils";
import type { TerminalEntry } from "../controller/types";
import { useIde } from "../controller/useIde";

export function TerminalList({ terminals }: { terminals: TerminalEntry[] }) {
  const { c, snap } = useIde();

  return (
    <ul className="h-full overflow-y-auto border-l bg-sidebar py-1 text-xs">
      {terminals.map((t) => {
        const active = t.id === snap.activeTermId;
        return (
          <li key={t.id}>
            <div
              onClick={() => c.switchTerminal(t.id)}
              className={cn(
                "group flex cursor-pointer items-center gap-1.5 px-2 py-1",
                active ? "bg-accent text-foreground" : "text-muted-foreground hover:text-foreground",
                !t.alive && "italic opacity-60",
              )}
            >
              {t.task ? (
                <SpinnerIcon className="size-3.5 shrink-0 animate-spin" aria-label={t.task} />
              ) : (
                <TerminalWindowIcon className="size-3.5 shrink-0 opacity-70" />
              )}
              <span className="truncate">{t.label}</span>
              <button
                title="Kill terminal"
                className="ml-auto hidden size-4 items-center justify-center rounded text-muted-foreground hover:bg-background hover:text-foreground group-hover:flex"
                onClick={(e) => {
                  e.stopPropagation();
                  c.closeTerminal(t.id);
                }}
              >
                <TrashIcon className="size-3" />
              </button>
            </div>
          </li>
        );
      })}
    </ul>
  );
}

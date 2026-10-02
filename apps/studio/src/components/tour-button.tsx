import { CompassIcon } from "@phosphor-icons/react";
import { startTour, type TourKind } from "@/lib/tour";
import { cn } from "@/lib/utils";

/** Replays the guided tour for the page it sits on. */
export function TourButton({ kind, className }: { kind: TourKind; className?: string }) {
  return (
    <button
      type="button"
      data-tour="tour-button"
      onClick={() => startTour(kind)}
      title="Take a tour"
      aria-label="Take a tour of Studio"
      className={cn(
        "flex h-7 items-center gap-1.5 rounded px-1.5 text-sm text-muted-foreground transition-colors hover:bg-accent hover:text-foreground",
        className,
      )}
    >
      <CompassIcon className="size-4" />
      <span className="hidden sm:inline">Tour</span>
    </button>
  );
}

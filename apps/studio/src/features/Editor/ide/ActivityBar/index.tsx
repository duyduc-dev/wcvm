import { FilesIcon, MoonIcon, SunIcon } from "@phosphor-icons/react";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";
import { useIde } from "../controller/useIde";

export function ActivityBar() {
  const { c, snap } = useIde();

  return (
    <div className="flex w-12 shrink-0 flex-col items-center border-r bg-sidebar py-1">
      <Tooltip>
        <TooltipTrigger
          onClick={() => c.toggleSidebar()}
          aria-label="Explorer"
          aria-pressed={!snap.sidebarCollapsed}
          className={cn(
            "flex h-12 w-12 items-center justify-center border-l-2 border-transparent text-muted-foreground transition-colors hover:text-foreground",
            !snap.sidebarCollapsed && "border-l-primary text-foreground",
          )}
        >
          <FilesIcon className="size-5" />
        </TooltipTrigger>
        <TooltipContent side="right">Explorer</TooltipContent>
      </Tooltip>

      <Tooltip>
        <TooltipTrigger
          onClick={() => c.toggleTheme()}
          aria-label="Toggle theme"
          className="mt-auto flex h-12 w-12 items-center justify-center border-l-2 border-transparent text-muted-foreground transition-colors hover:text-foreground"
        >
          {snap.isDark ? <MoonIcon className="size-5" /> : <SunIcon className="size-5" />}
        </TooltipTrigger>
        <TooltipContent side="right">Toggle theme</TooltipContent>
      </Tooltip>
    </div>
  );
}

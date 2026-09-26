import { HouseIcon, SidebarSimpleIcon, TerminalWindowIcon } from "@phosphor-icons/react";
import { useNavigate } from "@tanstack/react-router";
import { Button } from "@/components/ui/button";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";
import { useIde } from "../controller/useIde";

function LayoutToggle({
  label,
  keys,
  shown,
  onClick,
  children,
}: {
  label: string;
  keys: string;
  shown: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <Tooltip>
      <TooltipTrigger
        onClick={onClick}
        aria-pressed={shown}
        aria-label={label}
        className={cn(
          "flex size-7 items-center justify-center rounded transition-colors hover:bg-accent",
          shown ? "text-foreground" : "text-muted-foreground hover:text-foreground",
        )}
      >
        {children}
      </TooltipTrigger>
      <TooltipContent side="bottom">
        {label} <span className="text-background/60">{keys}</span>
      </TooltipContent>
    </Tooltip>
  );
}

export function TitleBar() {
  const { c, snap } = useIde();
  const navigate = useNavigate();

  return (
    <div className="flex h-10 shrink-0 items-center gap-3 border-b bg-sidebar pr-2 pl-3 text-sm">
      <button
        className="flex shrink-0 items-center gap-2 font-semibold"
        onClick={() => navigate({ to: "/" })}
        title="Home"
      >
        <span className="inline-block size-2.5 rounded-full bg-primary" />
        WCVM Studio
      </button>

      <div className="flex-1 truncate text-center text-xs text-muted-foreground">
        {snap.projectTitle}
      </div>

      <div className="flex shrink-0 items-center gap-1">
        <Button variant="ghost" size="sm" onClick={() => navigate({ to: "/" })}>
          <HouseIcon /> Home
        </Button>
        <div aria-hidden className="mx-1 h-5 w-px bg-border" />
        <LayoutToggle
          label="Toggle Explorer"
          keys="⌘B"
          shown={!snap.sidebarCollapsed}
          onClick={() => c.toggleSidebar()}
        >
          <SidebarSimpleIcon className="size-4" />
        </LayoutToggle>
        <LayoutToggle
          label="Toggle Terminal"
          keys="⌘J"
          shown={!snap.panelCollapsed}
          onClick={() => c.togglePanel()}
        >
          <TerminalWindowIcon className="size-4" />
        </LayoutToggle>
        <LayoutToggle
          label="Toggle Preview"
          keys="⌥⌘B"
          shown={!snap.previewCollapsed}
          onClick={() => c.togglePreview()}
        >
          <SidebarSimpleIcon mirrored className="size-4" />
        </LayoutToggle>
      </div>
    </div>
  );
}

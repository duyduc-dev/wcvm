import { ArrowLeftIcon, ArrowRightIcon, ArrowSquareOutIcon, ArrowsClockwiseIcon, LockIcon } from "@phosphor-icons/react";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import type { PreviewTab } from "../controller/types";
import { useIde } from "../controller/useIde";

function ToolButton({
  label,
  onClick,
  disabled,
  children,
}: {
  label: string;
  onClick: () => void;
  disabled?: boolean;
  children: React.ReactNode;
}) {
  return (
    <Tooltip>
      <TooltipTrigger
        onClick={onClick}
        disabled={disabled}
        aria-label={label}
        className="flex size-7 items-center justify-center rounded text-muted-foreground hover:bg-accent hover:text-foreground disabled:pointer-events-none disabled:opacity-40"
      >
        {children}
      </TooltipTrigger>
      <TooltipContent>{label}</TooltipContent>
    </Tooltip>
  );
}

export function PreviewToolbar({ tab }: { tab: PreviewTab }) {
  const { c } = useIde();

  return (
    <div className="flex h-9 shrink-0 items-center gap-0.5 border-b px-1.5">
      <ToolButton label="Back" onClick={() => c.previewBack(tab.id)}>
        <ArrowLeftIcon className="size-4" />
      </ToolButton>
      <ToolButton label="Forward" onClick={() => c.previewForward(tab.id)}>
        <ArrowRightIcon className="size-4" />
      </ToolButton>
      <ToolButton label="Reload" onClick={() => c.reloadPreviewTab(tab.id)}>
        <ArrowsClockwiseIcon className="size-4" />
      </ToolButton>
      <div className="mx-1 flex flex-1 items-center gap-1.5 rounded bg-background px-2 py-1">
        <LockIcon className="size-3 shrink-0 text-muted-foreground" />
        <input
          value={tab.url}
          onChange={(e) => c.setPreviewUrl(tab.id, e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") c.navigatePreview(tab.id, (e.target as HTMLInputElement).value);
          }}
          placeholder="localhost:3000"
          spellCheck={false}
          className="w-full bg-transparent text-xs text-foreground outline-none placeholder:text-muted-foreground"
        />
      </div>
      <ToolButton label="Open in new tab" disabled={tab.port == null} onClick={() => c.openPreviewExternal(tab.id)}>
        <ArrowSquareOutIcon className="size-4" />
      </ToolButton>
    </div>
  );
}

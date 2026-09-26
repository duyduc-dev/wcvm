import { cn } from "cn"
import * as ResizablePrimitive from "react-resizable-panels"

function ResizablePanelGroup({
  className,
  ...props
}: ResizablePrimitive.GroupProps) {
  return (
    <ResizablePrimitive.Group
      data-slot="resizable-panel-group"
      className={cn(
        "flex h-full w-full aria-[orientation=vertical]:flex-col",
        className
      )}
      {...props}
    />
  )
}

function ResizablePanel({ ...props }: ResizablePrimitive.PanelProps) {
  return <ResizablePrimitive.Panel data-slot="resizable-panel" {...props} />
}

function ResizableHandle({
  withHandle,
  className,
  ...props
}: ResizablePrimitive.SeparatorProps & {
  withHandle?: boolean
}) {
  return (
    <ResizablePrimitive.Separator
      data-slot="resizable-handle"
      className={cn(
        // z-10 is what makes the after: grab strip actually grabbable — the separator
        // is a 1px sibling of the panels, and at the default stacking order the next
        // panel's own content (Monaco's overlays, the preview iframe) would otherwise
        // paint over most of the hit area.
        "relative z-10 flex w-px cursor-col-resize items-center justify-center bg-border ring-offset-background transition-colors after:absolute after:inset-y-0 after:left-1/2 after:w-1 after:-translate-x-1/2 focus-visible:ring-1 focus-visible:ring-ring focus-visible:outline-hidden data-[separator=active]:bg-[#007fd4] data-[separator=hover]:bg-[#007fd4] aria-[orientation=horizontal]:h-px aria-[orientation=horizontal]:w-full aria-[orientation=horizontal]:cursor-row-resize aria-[orientation=horizontal]:after:left-0 aria-[orientation=horizontal]:after:h-1 aria-[orientation=horizontal]:after:w-full aria-[orientation=horizontal]:after:translate-x-0 aria-[orientation=horizontal]:after:-translate-y-1/2 [&[aria-orientation=horizontal]>div]:rotate-90",
        className
      )}
      {...props}
    >
      {withHandle && (
        <div className="z-10 flex h-6 w-1 shrink-0 rounded-none bg-border" />
      )}
    </ResizablePrimitive.Separator>
  )
}

export { ResizableHandle, ResizablePanel, ResizablePanelGroup }

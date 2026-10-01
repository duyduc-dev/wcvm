import { CaretRightIcon, MagicWandIcon } from "@phosphor-icons/react";
import { basename, relativeTo } from "../controller/fs.service";
import { useIde } from "../controller/useIde";
import { FileIcon } from "../fileIcon";

interface BreadcrumbProps {
  path: string;
  rootPath: string;
  projectTitle: string;
}

export function Breadcrumb({ path, rootPath, projectTitle }: BreadcrumbProps) {
  const { c, snap } = useIde();
  const rel = relativeTo(rootPath, path);
  const segments = [projectTitle, ...rel.split("/").filter(Boolean)];

  return (
    <div className="flex h-6 shrink-0 items-center border-b bg-white dark:bg-[#1e1e1e]">
    <div className="ide-tabs-scroll flex h-full min-w-0 flex-1 items-center gap-0.5 overflow-x-auto px-3 text-xs whitespace-nowrap text-muted-foreground">
      {segments.map((segment, i) => {
        const isLast = i === segments.length - 1;
        return (
          <span key={i} className="flex shrink-0 items-center gap-0.5">
            {i > 0 && <CaretRightIcon className="size-3 opacity-60" />}
            {isLast && segments.length > 1 ? (
              <span className="flex items-center gap-1 text-foreground">
                <FileIcon name={basename(path)} className="size-3.5 shrink-0" />
                {segment}
              </span>
            ) : (
              <span>{segment}</span>
            )}
          </span>
        );
      })}
    </div>
      {snap.tabKinds[path] === "text" && (
        <button
          type="button"
          title="Format Document with Prettier (⇧⌥F)"
          aria-label="Format Document"
          onClick={() => void c.formatActiveDocument()}
          className="mr-1.5 flex h-5 shrink-0 items-center gap-1 rounded px-1.5 text-[11px] text-muted-foreground hover:bg-accent hover:text-foreground"
        >
          <MagicWandIcon className="size-3.5" />
          Format
        </button>
      )}
    </div>
  );
}

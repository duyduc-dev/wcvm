import { CaretRightIcon } from "@phosphor-icons/react";
import { basename, relativeTo } from "../controller/fs.service";
import { FileIcon } from "../fileIcon";

interface BreadcrumbProps {
  path: string;
  rootPath: string;
  projectTitle: string;
}

export function Breadcrumb({ path, rootPath, projectTitle }: BreadcrumbProps) {
  const rel = relativeTo(rootPath, path);
  const segments = [projectTitle, ...rel.split("/").filter(Boolean)];

  return (
    <div className="ide-tabs-scroll flex h-6 shrink-0 items-center gap-0.5 overflow-x-auto border-b bg-white px-3 text-xs whitespace-nowrap text-muted-foreground dark:bg-[#1e1e1e]">
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
  );
}

import { FRAMEWORK_OPTIONS } from "../CardTemplate/CreateTemplateDialog/constants";
import { formatRelativeTime } from "@/lib/utils";
import type { IWcvmProjectType } from "@/services/wcvm/model";
import { useWcvmProjectStore } from "@/stores/useWcvmProjectStore";
import {
  BroomIcon,
  ClockCounterClockwiseIcon,
  FileDashedIcon,
  FolderDashedIcon,
  SpinnerIcon,
  TrashIcon,
} from "@phosphor-icons/react";
import { useNavigate } from "@tanstack/react-router";
import { useState } from "react";
import { useShallow } from "zustand/shallow";

/** "blank" has no entry in FRAMEWORK_OPTIONS (it isn't a create-vite template) - everything else
 *  reuses the exact same label/icon the "Start from template" dialog already shows for it. */
const projectTypeMeta = (type: IWcvmProjectType) => {
  const option = FRAMEWORK_OPTIONS.find((f) => f.id === type);
  return option ? { label: option.label, icon: option.icon } : { label: "Blank", icon: FileDashedIcon };
};

const RecentProjects = () => {
  const navigate = useNavigate({ from: "/" });
  const { projects, clearAllProject, removeProjectByPath } =
    useWcvmProjectStore(
      useShallow((s) => ({
        projects: s.projects,
        clearAllProject: s.clearAllProject,
        removeProjectByPath: s.removeProjectByPath,
      })),
    );
  const [isClearing, setIsClearing] = useState(false);

  const handleClearAll = async () => {
    setIsClearing(true);
    try {
      await clearAllProject();
    } finally {
      setIsClearing(false);
    }
  };

  return (
    <div className="mt-8">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex items-center gap-2">
          <ClockCounterClockwiseIcon size={20} />
          <p className="text-sm">Recent Projects</p>
        </div>
        {projects.length > 0 && (
          <button
            onClick={handleClearAll}
            disabled={isClearing}
            className="flex items-center gap-2 text-muted-foreground cursor-pointer hover:text-foreground transition-all hover:underline disabled:cursor-not-allowed disabled:opacity-60 disabled:hover:no-underline"
          >
            {isClearing ? (
              <SpinnerIcon size={20} className="animate-spin" />
            ) : (
              <BroomIcon size={20} />
            )}
            <p className="text-sm">{isClearing ? "Clearing…" : "Clear All"}</p>
          </button>
        )}
      </div>

      {projects.length === 0 ? (
        <div className="flex flex-col items-center justify-center gap-2 border border-dashed py-10 mt-5 text-center">
          <FolderDashedIcon size={28} className="text-muted-foreground" />
          <p className="text-sm text-muted-foreground">No recent projects yet</p>
          <p className="text-[12px] text-muted-foreground">
            Projects you create will show up here.
          </p>
        </div>
      ) : (
        <div className="flex flex-col gap-2 mt-5">
          {projects.map((proj) => {
            const { label, icon: TypeIcon } = projectTypeMeta(proj.type);
            return (
              <div
                onClick={() =>
                  navigate({ to: "/editor/$id", params: { id: proj.id } })
                }
                key={proj.id}
                className="border py-2 px-4 cursor-pointer hover:bg-accent transition-all flex items-center justify-between gap-3"
              >
                <div className="flex flex-col gap-1 min-w-0">
                  <p className="text-sm">{proj.path.split("/").at(-1)}</p>
                  <p className="text-[12px] text-muted-foreground truncate">{proj.path}</p>
                </div>
                <div className="flex shrink-0 items-center gap-4">
                  <div className="flex items-center gap-1.5 text-[12px] text-muted-foreground">
                    <TypeIcon size={14} />
                    <span>{label}</span>
                  </div>
                  <span className="text-[12px] text-muted-foreground">
                    {formatRelativeTime(proj.updatedAt ?? proj.createdAt)}
                  </span>
                  <button
                    onClick={(e) => {
                      e.stopPropagation();
                      removeProjectByPath(proj.path);
                    }}
                    className="cursor-pointer hover:text-red-500 transition-all"
                  >
                    <TrashIcon size={20} />
                  </button>
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
};

export default RecentProjects;

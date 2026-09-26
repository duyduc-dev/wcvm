import { useWcvmProjectStore } from "@/stores/useWcvmProjectStore";
import {
  BroomIcon,
  ClockCounterClockwiseIcon,
  FolderDashedIcon,
  TrashIcon,
} from "@phosphor-icons/react";
import { useNavigate } from "@tanstack/react-router";
import { useShallow } from "zustand/shallow";

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

  return (
    <div className="mt-8">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex items-center gap-2">
          <ClockCounterClockwiseIcon size={20} />
          <p className="text-sm">Recent Projects</p>
        </div>
        {projects.length > 0 && (
          <button
            onClick={clearAllProject}
            className="flex items-center gap-2 text-neutral-400 cursor-pointer hover:text-neutral-500 transition-all hover:underline"
          >
            <BroomIcon size={20} />
            <p className="text-sm">Clear All</p>
          </button>
        )}
      </div>

      {projects.length === 0 ? (
        <div className="flex flex-col items-center justify-center gap-2 border border-dashed py-10 mt-5 text-center">
          <FolderDashedIcon size={28} className="text-neutral-300" />
          <p className="text-sm text-neutral-500">No recent projects yet</p>
          <p className="text-[12px] text-neutral-400">
            Projects you create will show up here.
          </p>
        </div>
      ) : (
        <div className="flex flex-col gap-2 mt-5">
          {projects.map((proj) => (
            <div
              onClick={() =>
                navigate({ to: "/editor/$id", params: { id: proj.id } })
              }
              key={proj.id}
              className="border py-2 px-4 cursor-pointer hover:bg-neutral-100 transition-all flex items-center justify-between"
            >
              <div className="flex flex-col gap-1">
                <p className="text-sm">{proj.path.split("/").at(-1)}</p>
                <p className="text-[12px] text-neutral-400">{proj.path}</p>
              </div>
              <div>
                <button
                  onClick={() => removeProjectByPath(proj.path)}
                  className="cursor-pointer hover:text-red-500 transition-all"
                >
                  <TrashIcon size={20} />
                </button>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
};

export default RecentProjects;

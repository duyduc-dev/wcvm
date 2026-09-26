import { WCVM_PROJECTS_STORAGE_KEY } from "@/services/wcvm/constants";
import type { IWcvmProject } from "@/services/wcvm/model";
import { create } from "zustand";
import { persist, createJSONStorage } from "zustand/middleware";
import { v6 as uuidv6 } from "uuid";
import {
  createBlankTemplateProject,
  type BlankTemplateCreationResult,
} from "@/services/wcvm/blankTemplateProject";
import {
  clearAllFileSystem,
  removeFolderByPath,
} from "@/services/wcvm/utilities";

interface IWcvmProjectStore {
  projects: IWcvmProject[];
  getProject: (id: string) => IWcvmProject | undefined;
  addProject: (
    projectPath: string,
  ) => Promise<BlankTemplateCreationResult & { project?: IWcvmProject }>;
  clearAllProject: () => Promise<void>;
  removeProjectByPath: (path: string) => void;
}

export const useWcvmProjectStore = create<IWcvmProjectStore>()(
  persist(
    (set, get) => ({
      projects: [],

      getProject(id) {
        return get().projects.find((p) => p.id === id);
      },

      async addProject(input) {
        const id = uuidv6();
        const newProj = await createBlankTemplateProject(input);

        if (!newProj.isFailure) {
          const project: IWcvmProject = {
            path: input,
            id,
            createdAt: Date.now(),
            type: "blank",
          };
          set((state) => ({ projects: [project, ...state.projects] }));
          return {
            ...newProj,
            project,
          };
        }
        return newProj;
      },

      async clearAllProject() {
        return clearAllFileSystem().then(() => {
          set({ projects: [] });
        });
      },

      removeProjectByPath(path: string) {
        removeFolderByPath(path);
        set((prev) => ({
          projects: prev.projects.filter((p) => p.path !== path),
        }));
      },
    }),
    {
      name: WCVM_PROJECTS_STORAGE_KEY,
      storage: createJSONStorage(() => localStorage),
      version: 1,
      partialize: (state) => ({ projects: state.projects }),
    },
  ),
);

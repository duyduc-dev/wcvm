import { WCVM_PROJECTS_STORAGE_KEY } from "@/services/wcvm/constants";
import type { IWcvmProject, IWcvmProjectType } from "@/services/wcvm/model";
import { create } from "zustand";
import { persist, createJSONStorage } from "zustand/middleware";
import { v6 as uuidv6 } from "uuid";
import {
  createBlankTemplateProject,
  type BlankTemplateCreationResult,
} from "@/services/wcvm/templateProjects/blankTemplateProject";
import { createViteTemplateProject } from "@/services/wcvm/templateProjects/viteTemplateProject";
import { createRectifyTemplateProject } from "@/services/wcvm/templateProjects/rectifyTemplateProject";
import { createStaticTemplateProject } from "@/services/wcvm/templateProjects/staticTemplateProject";
import { createBootstrapTemplateProject } from "@/services/wcvm/templateProjects/bootstrapTemplateProject";
import { createAngularTemplateProject } from "@/services/wcvm/templateProjects/angularTemplateProject";
import { createFullstackTemplateProject } from "@/services/wcvm/templateProjects/fullstackTemplateProject";
import { createBackendTemplateProject } from "@/services/wcvm/templateProjects/backendTemplateProject";
import { createEmberTemplateProject } from "@/services/wcvm/templateProjects/emberTemplateProject";
import { createTanstackRouterTemplateProject } from "@/services/wcvm/templateProjects/tanstackRouterTemplateProject";
import { createTailwindTemplateProject } from "@/services/wcvm/templateProjects/tailwindTemplateProject";
import {
  clearAllFileSystem,
  removeFolderByPath,
} from "@/services/wcvm/utilities";

interface IWcvmProjectStore {
  projects: IWcvmProject[];
  getProject: (id: string) => IWcvmProject | undefined;
  addProject: (
    projectPath: string,
    type?: IWcvmProjectType,
    onProgress?: (message: string) => void,
  ) => Promise<BlankTemplateCreationResult & { project?: IWcvmProject }>;
  clearAllProject: () => Promise<void>;
  removeProjectByPath: (path: string) => void;
  /** Bumps `updatedAt` to now - called when a project is opened AND whenever a file in it is
   *  saved (see IdeController), so "last edit time" reflects whichever happened more recently. */
  touchProject: (id: string) => void;
}

export const useWcvmProjectStore = create<IWcvmProjectStore>()(
  persist(
    (set, get) => ({
      projects: [],

      getProject(id) {
        return get().projects.find((p) => p.id === id);
      },

      async addProject(input, type = "blank", onProgress) {
        const id = uuidv6();
        // "rectify"/"static"/"bootstrap"/"tanstack-router"/"tailwind"/"ember"/"ember-ts"/"angular" each have their own manual
        // wiring (none has an official create-vite template); any other non-"blank" type IS a real
        // create-vite `--template` name (see src/services/wcvm/templateProjects/viteTemplateProject.ts).
        const newProj =
          type === "blank"
            ? await createBlankTemplateProject(input)
            : type === "rectify"
              ? await createRectifyTemplateProject(input, onProgress)
              : type === "static"
                ? await createStaticTemplateProject(input)
                : type === "bootstrap"
                  ? await createBootstrapTemplateProject(input, onProgress)
                  : type === "tanstack-router"
                    ? await createTanstackRouterTemplateProject(input, onProgress)
                    : type === "tailwind"
                      ? await createTailwindTemplateProject(input, onProgress)
                      : type === "ember" || type === "ember-ts"
                        ? await createEmberTemplateProject(input, type === "ember-ts", onProgress)
                        : type === "angular"
                          ? await createAngularTemplateProject(input, onProgress)
                          : type === "express" || type === "express-ts" || type === "nestjs"
                            ? await createBackendTemplateProject(input, type, onProgress)
                            : type === "nextjs" || type === "nextjs-ts" || type === "sveltekit" || type === "react-router" || type === "astro"
                              ? await createFullstackTemplateProject(input, type, onProgress)
                              : await createViteTemplateProject(input, type, onProgress);

        if (!newProj.isFailure) {
          const now = Date.now();
          const project: IWcvmProject = {
            path: input,
            id,
            createdAt: now,
            updatedAt: now,
            type,
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

      touchProject(id: string) {
        set((prev) => ({
          projects: prev.projects.map((p) => (p.id === id ? { ...p, updatedAt: Date.now() } : p)),
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

/** "blank" is a hand-written empty project; "rectify"/"static"/"bootstrap"/"tanstack-router" are
 * manually-wired projects (see the matching src/services/wcvm/templateProjects/*TemplateProject.ts
 * — none of them has an official create-vite template); anything else is a real create-vite
 * `--template` name (see src/services/wcvm/templateProjects/viteTemplateProject.ts) — the
 * project's own persisted "kind". */
export type IWcvmProjectType =
  | "blank"
  | "react-ts"
  | "react"
  | "vue-ts"
  | "vue"
  | "vanilla-ts"
  | "vanilla"
  | "preact-ts"
  | "lit-ts"
  | "solid-ts"
  | "qwik-ts"
  | "svelte-ts"
  | "rectify"
  | "static"
  | "bootstrap"
  | "tanstack-router";

export interface IWcvmProject {
  id: string;
  path: string;
  type: IWcvmProjectType;
  createdAt: number;
  /** Last time the project was opened OR a file in it was saved - whichever is more recent (see
   *  useWcvmProjectStore's `touchProject`). Missing on a project persisted before this field
   *  existed - callers should fall back to `createdAt` in that case. */
  updatedAt?: number;
}

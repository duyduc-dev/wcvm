/** "blank" is a hand-written empty project; "rectify" is a manually-wired Rectify project (see
 * src/services/wcvm/rectifyTemplateProject.ts — Rectify has no official create-vite template);
 * anything else is a real create-vite `--template` name (see
 * src/services/wcvm/viteTemplateProject.ts) — the project's own persisted "kind". */
export type IWcvmProjectType = "blank" | "react-ts" | "vue-ts" | "vanilla" | "rectify";

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

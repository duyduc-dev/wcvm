import { AtomIcon, SquareIcon, TriangleIcon, type Icon } from "@phosphor-icons/react";
import type { IWcvmProjectType } from "@/services/wcvm/model";

/** Mirrors vivari studio's own template picker, which groups its (much larger) template list
 * into category tabs — scaled down to the categories this app's own template set actually needs. */
export type ITemplateCategory = "Frontend" | "Experimental";

export const TEMPLATE_CATEGORIES: ITemplateCategory[] = ["Frontend", "Experimental"];

export interface IFrameworkOption {
  /** A real create-vite `--template` name (or, for "rectify", a manually-wired setup — see
   * src/services/wcvm/rectifyTemplateProject.ts) — and this project's own persisted `type`. */
  id: Exclude<IWcvmProjectType, "blank">;
  label: string;
  description: string;
  icon: Icon;
  category: ITemplateCategory;
}

/** Only frameworks this sandbox has actually confirmed working with a real scaffold — not every
 * template create-vite (or a framework's own CLI) offers, several of which haven't been checked
 * against this sandbox's Vite 8/Rolldown-avoidance pins:
 * - react-ts / vue-ts: real `npm create vite@latest --template <id>` scaffolds (react-ts: proven
 *   directly; vue-ts: same pins wcvm's own hand-written Vue playground example already verified).
 * - rectify: no official create-vite template exists for it, so it's manually wired on top of a
 *   real "vanilla-ts" scaffold, following Rectify's own documented manual setup — hence its own
 *   "Experimental" category rather than "Frontend". */
export const FRAMEWORK_OPTIONS: IFrameworkOption[] = [
  { id: "react-ts", label: "React", description: "TypeScript", icon: AtomIcon, category: "Frontend" },
  { id: "vue-ts", label: "Vue", description: "TypeScript", icon: TriangleIcon, category: "Frontend" },
  {
    id: "rectify",
    label: "Rectify",
    description: "TypeScript",
    icon: SquareIcon,
    category: "Experimental",
  },
];

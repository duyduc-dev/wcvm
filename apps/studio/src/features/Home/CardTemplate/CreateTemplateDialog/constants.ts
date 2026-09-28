import {
  AtomIcon,
  FileJsIcon,
  SquareIcon,
  TriangleIcon,
  type Icon,
} from "@phosphor-icons/react";
import type { IWcvmProjectType } from "@/services/wcvm/model";

export type ITemplateCategory = "Frontend" | "Experimental";

export const TEMPLATE_CATEGORIES: ITemplateCategory[] = [
  "Frontend",
  "Experimental",
];

export interface IFrameworkOption {
  id: Exclude<IWcvmProjectType, "blank">;
  label: string;
  description: string;
  icon: Icon;
  category: ITemplateCategory;
}

export const FRAMEWORK_OPTIONS: IFrameworkOption[] = [
  {
    id: "react-ts",
    label: "React",
    description: "TypeScript",
    icon: AtomIcon,
    category: "Frontend",
  },
  {
    id: "vue-ts",
    label: "Vue",
    description: "TypeScript",
    icon: TriangleIcon,
    category: "Frontend",
  },
  {
    id: "vanilla",
    label: "Vanilla",
    description: "JavaScript",
    icon: FileJsIcon,
    category: "Frontend",
  },
  {
    id: "rectify",
    label: "Rectify",
    description: "TypeScript",
    icon: SquareIcon,
    category: "Experimental",
  },
];

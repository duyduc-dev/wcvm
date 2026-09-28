import type { Icon } from "@phosphor-icons/react";
import type { ReactElement } from "react";
import type { IWcvmProjectType } from "@/services/wcvm/model";
import {
  JsLogoIcon,
  ReactLogoIcon,
  RectifyLogoIcon,
  VueLogoIcon,
  type ITemplateIconProps,
} from "./templateIcons";

export type ITemplateCategory = "Frontend" | "Experimental";

export const TEMPLATE_CATEGORIES: ITemplateCategory[] = [
  "Frontend",
  "Experimental",
];

export interface IFrameworkOption {
  id: Exclude<IWcvmProjectType, "blank">;
  label: string;
  description: string;
  icon: Icon | ((props: ITemplateIconProps) => ReactElement);
  category: ITemplateCategory;
}

export const FRAMEWORK_OPTIONS: IFrameworkOption[] = [
  {
    id: "react-ts",
    label: "React",
    description: "TypeScript",
    icon: ReactLogoIcon,
    category: "Frontend",
  },
  {
    id: "vue-ts",
    label: "Vue",
    description: "TypeScript",
    icon: VueLogoIcon,
    category: "Frontend",
  },
  {
    id: "vanilla",
    label: "Vanilla",
    description: "JavaScript",
    icon: JsLogoIcon,
    category: "Frontend",
  },
  {
    id: "rectify",
    label: "Rectify",
    description: "TypeScript",
    icon: RectifyLogoIcon,
    category: "Experimental",
  },
];

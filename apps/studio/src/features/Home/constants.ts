import { FilePlusIcon, LayoutIcon } from "@phosphor-icons/react";
import CreateBlankTemplateDialog from "./CreateBlankTemplateDialog";
import CreateTemplateDialog from "./CreateTemplateDialog";

export const TEMPLATES = [
  {
    icon: FilePlusIcon,
    title: "Start from blank",
    description: "An empty project with a package.json",
    dialog: CreateBlankTemplateDialog,
  },
  {
    icon: LayoutIcon,
    title: "Start from template",
    description: "React, Vue",
    dialog: CreateTemplateDialog,
  },
];

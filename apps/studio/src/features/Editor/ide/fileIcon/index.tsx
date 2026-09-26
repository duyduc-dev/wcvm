import {
  CodeIcon,
  FileIcon as PhosphorFileIcon,
  FolderOpenIcon,
  FolderSimpleIcon,
  ImageIcon,
} from "@phosphor-icons/react";
import { cn } from "@/lib/utils";
import { extensionOf, isImagePath } from "../controller/fs.service";
import { COLOR_BY_EXTENSION, DEFAULT_ICON_COLOR, IMAGE_ICON_COLOR } from "./constants";

interface FileIconProps {
  name: string;
  className?: string;
}

export function FileIcon({ name, className }: FileIconProps) {
  if (isImagePath(name)) {
    return <ImageIcon className={cn(IMAGE_ICON_COLOR, className)} />;
  }
  const color = COLOR_BY_EXTENSION[extensionOf(name)];
  if (color) return <CodeIcon className={cn(color, className)} />;
  return <PhosphorFileIcon className={cn(DEFAULT_ICON_COLOR, className)} />;
}

interface FolderIconProps {
  open?: boolean;
  className?: string;
}

export function FolderIcon({ open, className }: FolderIconProps) {
  const Icon = open ? FolderOpenIcon : FolderSimpleIcon;
  return <Icon className={cn("text-sky-400", className)} />;
}

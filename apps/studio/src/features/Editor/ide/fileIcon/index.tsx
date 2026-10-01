import {
  FileIcon as PhosphorFileIcon,
  FolderOpenIcon,
  FolderSimpleIcon,
  ImageIcon,
} from "@phosphor-icons/react";
import {
  AngularLogoIcon,
  AstroLogoIcon,
  EmberLogoIcon,
  ReactLogoIcon,
  SvelteLogoIcon,
  TailwindLogoIcon,
  VueLogoIcon,
} from "@/features/Home/CardTemplate/CreateTemplateDialog/templateIcons";
import { cn } from "@/lib/utils";
import { extensionOf, isImagePath } from "../controller/fs.service";
import {
  DECLARATION_ICON,
  DEFAULT_ICON_COLOR,
  ICON_BY_EXTENSION,
  ICON_BY_FILENAME,
  IMAGE_ICON_COLOR,
  type IBadge,
  type IBrand,
  type IFileIconSpec,
} from "./constants";

const BRAND_ICONS: Record<IBrand["brand"], React.ComponentType<{ size?: number }>> = {
  react: ReactLogoIcon,
  vue: VueLogoIcon,
  svelte: SvelteLogoIcon,
  astro: AstroLogoIcon,
  ember: EmberLogoIcon,
  angular: AngularLogoIcon,
  tailwind: TailwindLogoIcon,
};

/** The spec for a file name: an exact file name first (`package.json`), then `.d.ts`, then the
 * extension - `undefined` when nothing matches (the caller shows a generic file glyph). */
export function iconSpecFor(name: string): IFileIconSpec | undefined {
  const lower = name.toLowerCase();
  const byName = ICON_BY_FILENAME[lower];
  if (byName) return byName;
  if (lower.endsWith(".d.ts")) return DECLARATION_ICON;
  // `.env`, `.env.local`: no extension to speak of
  if (lower === ".env" || lower.startsWith(".env.")) return ICON_BY_EXTENSION.env;
  return ICON_BY_EXTENSION[extensionOf(name)];
}

/** Label sized to the badge: 1-2 characters fill it, longer ones shrink. */
const labelSize = (label: string) => (label.length <= 2 ? 11 : label.length === 3 ? 8.5 : 7);

function Badge({ spec, className }: { spec: IBadge; className?: string }) {
  return (
    <svg viewBox="0 0 24 24" className={className} aria-hidden>
      <rect x="1.5" y="1.5" width="21" height="21" rx="4" fill={spec.bg} />
      <text
        x="12"
        y="12.5"
        textAnchor="middle"
        dominantBaseline="central"
        fontSize={labelSize(spec.label)}
        fontFamily="ui-sans-serif, system-ui, sans-serif"
        fontWeight="700"
        fill={spec.fg ?? "#fff"}
      >
        {spec.label}
      </text>
    </svg>
  );
}

interface FileIconProps {
  name: string;
  className?: string;
}

export function FileIcon({ name, className }: FileIconProps) {
  if (isImagePath(name)) {
    return <ImageIcon className={cn(IMAGE_ICON_COLOR, className)} />;
  }
  const spec = iconSpecFor(name);
  if (!spec) return <PhosphorFileIcon className={cn(DEFAULT_ICON_COLOR, className)} />;
  if (spec.kind === "badge") return <Badge spec={spec} className={className} />;
  const Brand = BRAND_ICONS[spec.brand];
  // The brand marks size themselves with a `size` prop in px; let the caller's CSS size win.
  return (
    <span className={cn("inline-flex [&>svg]:size-full", className)}>
      <Brand size={24} />
    </span>
  );
}

interface FolderIconProps {
  open?: boolean;
  className?: string;
}

export function FolderIcon({ open, className }: FolderIconProps) {
  const Icon = open ? FolderOpenIcon : FolderSimpleIcon;
  return <Icon className={cn("text-sky-400", className)} />;
}

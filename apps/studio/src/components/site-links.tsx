import { BookOpenIcon, GithubLogoIcon, GlobeIcon } from "@phosphor-icons/react";
import type { ComponentType, SVGProps } from "react";
import { DOCS_URL, EXTERNAL_LINK_PROPS, GITHUB_URL, NPM_URL, WEBSITE_URL } from "@/lib/links";
import { cn } from "@/lib/utils";

/** The npm logo (Phosphor has none), drawn with currentColor so it follows the theme. */
export function NpmLogoIcon(props: SVGProps<SVGSVGElement>) {
  return (
    <svg viewBox="0 0 24 24" fill="currentColor" aria-hidden {...props}>
      <path d="M1.763 0C.786 0 0 .786 0 1.763v20.474C0 23.214.786 24 1.763 24h20.474c.977 0 1.763-.786 1.763-1.763V1.763C24 .786 23.214 0 22.237 0zM5.13 5.323l13.837.019-.009 13.836h-3.464l.01-10.382h-3.456L12.04 19.17H5.113z" />
    </svg>
  );
}

interface ISiteLink {
  label: string;
  href: string;
  Icon: ComponentType<{ className?: string }>;
}

export const SITE_LINKS: ISiteLink[] = [
  { label: "Website", href: WEBSITE_URL, Icon: GlobeIcon },
  { label: "Docs", href: DOCS_URL, Icon: BookOpenIcon },
  { label: "GitHub", href: GITHUB_URL, Icon: GithubLogoIcon },
  { label: "npm", href: NPM_URL, Icon: NpmLogoIcon },
];

/** Links to the other wcvm pages, each with its logo, opening in a new tab. `showLabels` adds the
 *  name beside the logo from the `sm` breakpoint up; below it (and with `showLabels` off) only the
 *  logo shows, so the row fits a phone. */
export function SiteLinks({ showLabels = false, className }: { showLabels?: boolean; className?: string }) {
  return (
    <nav aria-label="wcvm on the web" data-tour="site-links" className={cn("flex items-center gap-0.5", className)}>
      {SITE_LINKS.map(({ label, href, Icon }) => (
        <a
          key={href}
          href={href}
          {...EXTERNAL_LINK_PROPS}
          title={`${label} (opens in a new tab)`}
          aria-label={`${label} (opens in a new tab)`}
          className="flex h-7 items-center gap-1.5 rounded px-1.5 text-sm text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
        >
          <Icon className="size-4 shrink-0" />
          {showLabels ? <span className="hidden sm:inline">{label}</span> : null}
        </a>
      ))}
    </nav>
  );
}

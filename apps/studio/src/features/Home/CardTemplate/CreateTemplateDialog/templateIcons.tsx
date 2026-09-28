/** Real brand marks for the framework picker, ported from vivari's own
 *  hand-rolled `templateIcons.tsx` (~/workspace/vivari/packages/studio/src/components/ide) -
 *  inline SVGs so Studio doesn't need an icon-set dependency for them. */

export interface ITemplateIconProps {
  size?: number;
}

export function ReactLogoIcon({ size = 24 }: ITemplateIconProps) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" aria-hidden>
      <circle cx="12" cy="12" r="2" fill="#61DAFB" />
      <g stroke="#61DAFB" strokeWidth="1" fill="none">
        <ellipse cx="12" cy="12" rx="10" ry="4" />
        <ellipse cx="12" cy="12" rx="10" ry="4" transform="rotate(60 12 12)" />
        <ellipse cx="12" cy="12" rx="10" ry="4" transform="rotate(120 12 12)" />
      </g>
    </svg>
  );
}

export function VueLogoIcon({ size = 24 }: ITemplateIconProps) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" aria-hidden>
      <path d="M2 3h4l6 10 6-10h4L12 21z" fill="#41B883" />
      <path d="M6 3h3l3 5 3-5h3l-6 10z" fill="#35495E" />
    </svg>
  );
}

/** The real Rectify logo (https://rectify-teams.github.io/rectify/img/logo.svg) - a hexagon
 *  outline with an "R" mark. Same markup already vendored as RECTIFY_LOGO_SVG in
 *  rectifyTemplateProject.ts for the scaffolded project's own assets; duplicated here (viewBox
 *  0 0 100 100, sized via width/height instead of a template literal) for the picker's icon slot. */
export function RectifyLogoIcon({ size = 24 }: ITemplateIconProps) {
  return (
    <svg width={size} height={size} viewBox="0 0 100 100" fill="none" aria-hidden>
      <polygon
        points="50,5 93,27.5 93,72.5 50,95 7,72.5 7,27.5"
        stroke="#7c6af7"
        strokeWidth="6"
        fill="none"
      />
      <text
        x="50"
        y="62"
        textAnchor="middle"
        fontSize="42"
        fontWeight="bold"
        fontFamily="system-ui"
        fill="#a78bfa"
      >
        R
      </text>
    </svg>
  );
}

/** The actual JavaScript brand mark: a yellow square with the "JS" wordmark. */
export function JsLogoIcon({ size = 24 }: ITemplateIconProps) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" aria-hidden>
      <rect x="1.5" y="1.5" width="21" height="21" rx="4" fill="#F7DF1E" />
      <text
        x="12"
        y="13"
        textAnchor="middle"
        dominantBaseline="central"
        fontSize={9}
        fontFamily="ui-sans-serif, system-ui, sans-serif"
        fontWeight="700"
        fill="#000"
      >
        JS
      </text>
    </svg>
  );
}

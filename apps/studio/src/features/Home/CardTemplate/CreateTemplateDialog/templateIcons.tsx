/** Real brand marks for the framework picker, ported from vivari's own
 *  hand-rolled `templateIcons.tsx` (~/workspace/vivari/packages/studio/src/components/ide) -
 *  inline SVGs so Studio doesn't need an icon-set dependency for them. Preact/Lit/Solid/Qwik are
 *  the exact SVGs each framework's own official `npm create vite@latest --template <x>` scaffold
 *  ships at `src/assets/<x>.svg` - extracted directly from a real scaffold rather than
 *  approximated. TanStack's is vivari's own vendored raster asset, copied as-is. */
import tanstackLogoSrc from "@/assets/tanstack-logo.png";

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

/** TypeScript's actual brand mark: a blue square with the "TS" wordmark. */
export function TsLogoIcon({ size = 24 }: ITemplateIconProps) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" aria-hidden>
      <rect x="1.5" y="1.5" width="21" height="21" rx="4" fill="#3178C6" />
      <text
        x="12"
        y="13"
        textAnchor="middle"
        dominantBaseline="central"
        fontSize={9}
        fontFamily="ui-sans-serif, system-ui, sans-serif"
        fontWeight="700"
        fill="#fff"
      >
        TS
      </text>
    </svg>
  );
}

/** A generic "code" mark for the zero-dependency static HTML/CSS/JS template - same
 *  orange-red + "</>" glyph vivari's own picker uses for its "static"/"html" icon key. */
export function StaticLogoIcon({ size = 24 }: ITemplateIconProps) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" aria-hidden>
      <rect x="1.5" y="1.5" width="21" height="21" rx="5" fill="#E34F26" />
      <text
        x="12"
        y="13"
        textAnchor="middle"
        dominantBaseline="central"
        fontSize={9}
        fontFamily="ui-monospace, monospace"
        fontWeight="700"
        fill="#fff"
      >
        {"</>"}
      </text>
    </svg>
  );
}

/** Bootstrap's real brand mark, ported from vivari's own hand-rolled BootstrapIcon
 *  (its own comment: "official logo (logos:bootstrap)"). */
export function BootstrapLogoIcon({ size = 24 }: ITemplateIconProps) {
  return (
    <svg width={size} height={size} viewBox="0 0 256 204" aria-hidden>
      <path
        fill="#7e13f8"
        d="M53.172 0C38.565 0 27.756 12.785 28.24 26.65c.465 13.32-.139 30.573-4.482 44.642C19.402 85.402 12.034 94.34 0 95.488v12.956c12.034 1.148 19.402 10.086 23.758 24.197c4.343 14.069 4.947 31.32 4.482 44.641c-.484 13.863 10.325 26.65 24.934 26.65h149.673c14.608 0 25.414-12.785 24.93-26.65c-.464-13.32.139-30.572 4.482-44.641c4.359-14.11 11.707-23.05 23.741-24.197V95.488c-12.034-1.148-19.382-10.086-23.74-24.196c-4.344-14.067-4.947-31.321-4.483-44.642C228.261 12.787 217.455 0 202.847 0H53.17zM173.56 125.533c0 19.092-14.24 30.67-37.872 30.67h-40.23a4.34 4.34 0 0 1-4.338-4.339V52.068a4.34 4.34 0 0 1 4.339-4.34h39.999c19.705 0 32.637 10.675 32.637 27.063c0 11.503-8.7 21.801-19.783 23.604v.601c15.089 1.655 25.248 12.104 25.248 26.537m-42.26-64.05h-22.937v32.4h19.32c14.934 0 23.17-6.014 23.17-16.764c0-10.073-7.082-15.636-19.552-15.636m-22.937 45.256v35.705h23.782c15.548 0 23.786-6.239 23.786-17.965c0-11.728-8.467-17.742-24.786-17.742h-22.782z"
      />
    </svg>
  );
}

/** Preact's real official logo, extracted verbatim from a real
 *  `npm create vite@latest --template preact-ts` scaffold's `src/assets/preact.svg`. */
export function PreactLogoIcon({ size = 24 }: ITemplateIconProps) {
  return (
    <svg width={size} height={size} viewBox="0 0 256 296" aria-hidden>
      <path fill="#673AB8" d="m128 0l128 73.9v147.8l-128 73.9L0 221.7V73.9z" />
      <path
        fill="#FFF"
        d="M34.865 220.478c17.016 21.78 71.095 5.185 122.15-34.704c51.055-39.888 80.24-88.345 63.224-110.126c-17.017-21.78-71.095-5.184-122.15 34.704c-51.055 39.89-80.24 88.346-63.224 110.126Zm7.27-5.68c-5.644-7.222-3.178-21.402 7.573-39.253c11.322-18.797 30.541-39.548 54.06-57.923c23.52-18.375 48.303-32.004 69.281-38.442c19.922-6.113 34.277-5.075 39.92 2.148c5.644 7.223 3.178 21.403-7.573 39.254c-11.322 18.797-30.541 39.547-54.06 57.923c-23.52 18.375-48.304 32.004-69.281 38.441c-19.922 6.114-34.277 5.076-39.92-2.147Z"
      />
      <path
        fill="#FFF"
        d="M220.239 220.478c17.017-21.78-12.169-70.237-63.224-110.126C105.96 70.464 51.88 53.868 34.865 75.648c-17.017 21.78 12.169 70.238 63.224 110.126c51.055 39.889 105.133 56.485 122.15 34.704Zm-7.27-5.68c-5.643 7.224-19.998 8.262-39.92 2.148c-20.978-6.437-45.761-20.066-69.28-38.441c-23.52-18.376-42.74-39.126-54.06-57.923c-10.752-17.851-13.218-32.03-7.575-39.254c5.644-7.223 19.999-8.261 39.92-2.148c20.978 6.438 45.762 20.067 69.281 38.442c23.52 18.375 42.739 39.126 54.06 57.923c10.752 17.85 13.218 32.03 7.574 39.254Z"
      />
      <path
        fill="#FFF"
        d="M127.552 167.667c10.827 0 19.603-8.777 19.603-19.604c0-10.826-8.776-19.603-19.603-19.603c-10.827 0-19.604 8.777-19.604 19.603c0 10.827 8.777 19.604 19.604 19.604Z"
      />
    </svg>
  );
}

/** Lit's real official logo, extracted verbatim from a real
 *  `npm create vite@latest --template lit-ts` scaffold's `src/assets/lit.svg`. */
export function LitLogoIcon({ size = 24 }: ITemplateIconProps) {
  return (
    <svg width={size} height={size} viewBox="0 0 256 320" aria-hidden>
      <path
        fill="#00E8FF"
        d="m64 192l25.926-44.727l38.233-19.114l63.974 63.974l10.833 61.754L192 320l-64-64l-38.074-25.615z"
      />
      <path
        fill="#283198"
        d="M128 256V128l64-64v128l-64 64ZM0 256l64 64l9.202-60.602L64 192l-37.542 23.71L0 256Z"
      />
      <path
        fill="#324FFF"
        d="M64 192V64l64-64v128l-64 64Zm128 128V192l64-64v128l-64 64ZM0 256V128l64 64l-64 64Z"
      />
      <path fill="#0FF" d="M64 320V192l64 64z" />
    </svg>
  );
}

/** Solid's real official logo, extracted verbatim from a real
 *  `npm create vite@latest --template solid-ts` scaffold's `src/assets/solid.svg`. */
export function SolidLogoIcon({ size = 24 }: ITemplateIconProps) {
  return (
    <svg width={size} height={size} viewBox="0 0 166 155.3" aria-hidden>
      <defs>
        <linearGradient id="solidTplA" gradientUnits="userSpaceOnUse" x1="27.5" y1="3" x2="152" y2="63.5">
          <stop offset=".1" stopColor="#76b3e1" />
          <stop offset=".3" stopColor="#dcf2fd" />
          <stop offset="1" stopColor="#76b3e1" />
        </linearGradient>
        <linearGradient id="solidTplB" gradientUnits="userSpaceOnUse" x1="95.8" y1="32.6" x2="74" y2="105.2">
          <stop offset="0" stopColor="#76b3e1" />
          <stop offset=".5" stopColor="#4377bb" />
          <stop offset="1" stopColor="#1f3b77" />
        </linearGradient>
        <linearGradient id="solidTplC" gradientUnits="userSpaceOnUse" x1="18.4" y1="64.2" x2="144.3" y2="149.8">
          <stop offset="0" stopColor="#315aa9" />
          <stop offset=".5" stopColor="#518ac8" />
          <stop offset="1" stopColor="#315aa9" />
        </linearGradient>
        <linearGradient id="solidTplD" gradientUnits="userSpaceOnUse" x1="75.2" y1="74.5" x2="24.4" y2="260.8">
          <stop offset="0" stopColor="#4377bb" />
          <stop offset=".5" stopColor="#1a336b" />
          <stop offset="1" stopColor="#1a336b" />
        </linearGradient>
      </defs>
      <path d="M163 35S110-4 69 5l-3 1c-6 2-11 5-14 9l-2 3-15 26 26 5c11 7 25 10 38 7l46 9 18-30z" fill="#76b3e1" />
      <path
        d="M163 35S110-4 69 5l-3 1c-6 2-11 5-14 9l-2 3-15 26 26 5c11 7 25 10 38 7l46 9 18-30z"
        opacity=".3"
        fill="url(#solidTplA)"
      />
      <path d="M52 35l-4 1c-17 5-22 21-13 35 10 13 31 20 48 15l62-21S92 26 52 35z" fill="#518ac8" />
      <path
        d="M52 35l-4 1c-17 5-22 21-13 35 10 13 31 20 48 15l62-21S92 26 52 35z"
        opacity=".3"
        fill="url(#solidTplB)"
      />
      <path
        d="M134 80a45 45 0 00-48-15L24 85 4 120l112 19 20-36c4-7 3-15-2-23z"
        fill="url(#solidTplC)"
      />
      <path
        d="M114 115a45 45 0 00-48-15L4 120s53 40 94 30l3-1c17-5 23-21 13-34z"
        fill="url(#solidTplD)"
      />
    </svg>
  );
}

/** Qwik's real official logo, extracted verbatim from a real
 *  `npm create vite@latest --template qwik-ts` scaffold's `src/assets/qwik.svg`. */
export function QwikLogoIcon({ size = 24 }: ITemplateIconProps) {
  return (
    <svg width={size} height={size} viewBox="0 0 110 118" fill="none" aria-hidden>
      <path
        fill="#18B6F6"
        d="M96.8285 117.176L75.9674 96.4188L75.67 96.4705V96.2507L31.3094 52.3816L42.2638 41.8282L35.8231 4.91711L5.33977 42.7335C0.166531 47.9585 -0.829317 56.5072 2.92128 62.7798L21.9717 94.4012C24.8817 99.2511 29.46 102.368 35.849 102.135C49.377 101.657 55.3262 101.657 55.3262 101.657L96.8156 117.163L96.8285 117.176Z"
      />
      <path
        fill="#AC7EF4"
        d="M107.134 59.0164C110.134 52.8214 111.208 47.4024 108.246 41.9576L104.03 34.1977L101.844 30.2143L100.991 28.6624L100.913 28.7529L89.4413 8.84886C86.5443 3.81789 81.19 0.752745 75.3571 0.804478L65.2952 1.08901L35.2645 1.1666C29.5869 1.21834 24.3749 4.20588 21.4908 9.10753L3.24219 45.3461L35.8983 4.72321L78.7327 51.8256L71.0634 59.5983L75.6417 96.4447L75.7063 96.3671V96.4706H75.6417L75.7322 96.5611L79.3017 100.04L96.5804 116.918C97.3046 117.616 98.4815 116.776 98.003 115.909L87.3203 94.8928"
      />
      <path
        fill="#fff"
        d="M78.8354 51.7092L35.8846 4.8396L41.989 41.5437L31.0605 52.1489L75.5633 96.3801L71.5541 59.663L78.8354 51.7221V51.7092Z"
      />
    </svg>
  );
}

/** Svelte's real official logo, extracted verbatim from a real
 *  `npm create vite@latest --template svelte-ts` scaffold's `src/assets/svelte.svg`. */
export function SvelteLogoIcon({ size = 24 }: ITemplateIconProps) {
  return (
    <svg width={size} height={size} viewBox="0 0 256 308" aria-hidden>
      <path
        fill="#FF3E00"
        d="M239.682 40.707C211.113-.182 154.69-12.301 113.895 13.69L42.247 59.356a82.198 82.198 0 0 0-37.135 55.056a86.566 86.566 0 0 0 8.536 55.576a82.425 82.425 0 0 0-12.296 30.719a87.596 87.596 0 0 0 14.964 66.244c28.574 40.893 84.997 53.007 125.787 27.016l71.648-45.664a82.182 82.182 0 0 0 37.135-55.057a86.601 86.601 0 0 0-8.53-55.577a82.409 82.409 0 0 0 12.29-30.718a87.573 87.573 0 0 0-14.963-66.244"
      />
      <path
        fill="#FFF"
        d="M106.889 270.841c-23.102 6.007-47.497-3.036-61.103-22.648a52.685 52.685 0 0 1-9.003-39.85a49.978 49.978 0 0 1 1.713-6.693l1.35-4.115l3.671 2.697a92.447 92.447 0 0 0 28.036 14.007l2.663.808l-.245 2.659a16.067 16.067 0 0 0 2.89 10.656a17.143 17.143 0 0 0 18.397 6.828a15.786 15.786 0 0 0 4.403-1.935l71.67-45.672a14.922 14.922 0 0 0 6.734-9.977a15.923 15.923 0 0 0-2.713-12.011a17.156 17.156 0 0 0-18.404-6.832a15.78 15.78 0 0 0-4.396 1.933l-27.35 17.434a52.298 52.298 0 0 1-14.553 6.391c-23.101 6.007-47.497-3.036-61.101-22.649a52.681 52.681 0 0 1-9.004-39.849a49.428 49.428 0 0 1 22.34-33.114l71.664-45.677a52.218 52.218 0 0 1 14.563-6.398c23.101-6.007 47.497 3.036 61.101 22.648a52.685 52.685 0 0 1 9.004 39.85a50.559 50.559 0 0 1-1.713 6.692l-1.35 4.116l-3.67-2.693a92.373 92.373 0 0 0-28.037-14.013l-2.664-.809l.246-2.658a16.099 16.099 0 0 0-2.89-10.656a17.143 17.143 0 0 0-18.398-6.828a15.786 15.786 0 0 0-4.402 1.935l-71.67 45.674a14.898 14.898 0 0 0-6.73 9.975a15.9 15.9 0 0 0 2.709 12.012a17.156 17.156 0 0 0 18.404 6.832a15.841 15.841 0 0 0 4.402-1.935l27.345-17.427a52.147 52.147 0 0 1 14.552-6.397c23.101-6.006 47.497 3.037 61.102 22.65a52.681 52.681 0 0 1 9.003 39.848a49.453 49.453 0 0 1-22.34 33.12l-71.664 45.673a52.218 52.218 0 0 1-14.563 6.398"
      />
    </svg>
  );
}

/** vivari's own vendored TanStack raster mark (tanstack-logo.png), reused as-is. */
export function TanstackLogoIcon({ size = 24 }: ITemplateIconProps) {
  return (
    <img
      src={tanstackLogoSrc}
      alt="TanStack"
      aria-hidden
      width={size}
      height={size}
      style={{ objectFit: "contain", borderRadius: "9999px" }}
    />
  );
}

/** Angular's real brand mark (simple-icons' "angular" glyph, angular.dev's own red). */
export function AngularLogoIcon({ size = 24 }: ITemplateIconProps) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="#DD0031" aria-hidden>
      <path d="M16.712 17.711H7.288l-1.204 2.916L12 24l5.916-3.373-1.204-2.916ZM14.692 0l7.832 16.855.814-12.856L14.692 0ZM9.308 0 .662 3.999l.814 12.856L9.308 0Zm-.405 13.93h6.198L12 6.396 8.903 13.93Z" />
    </svg>
  );
}

/** Ember.js's real current brand mark (simple-icons' "emberdotjs" glyph, its own orange-red). */
export function EmberLogoIcon({ size = 24 }: ITemplateIconProps) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="#E04E39" aria-hidden>
      <path d="M0 0v24h24V0H0zm12.29 4.38c1.66-.03 2.83.42 3.84 1.85 2.25 5.58-6 8.4-6 8.4s-.23 1.48 2.02 1.42c2.78 0 5.7-2.15 6.81-3.06a.66.66 0 01.9.05l.84.87a.66.66 0 01.01.9c-.72.8-2.42 2.46-4.97 3.53 0 0-4.26 1.97-7.13.1a4.95 4.95 0 01-2.38-3.83s-2.08-.11-3.42-.63c-1.33-.52.01-2.1.01-2.1s.42-.65 1.2 0 2.24.36 2.24.36c.13-1.03.35-2.38.98-3.81 1.34-3 3.38-4.01 5.05-4.05zm.33 2.8c-1.1.07-2.8 1.78-2.88 4.93 0 0 .75.23 2.41-.91 1.67-1.14 2-2.97 1.11-3.81a.82.82 0 00-.64-.21Z" />
    </svg>
  );
}

/** Tailwind CSS's real brand mark, ported from vivari's own hand-rolled TailwindIcon. */
export function TailwindLogoIcon({ size = 24 }: ITemplateIconProps) {
  return (
    <svg width={size} height={size} viewBox="0 0 256 154" aria-hidden>
      <path
        fill="#38bdf8"
        d="M128 0C93.867 0 72.533 17.067 64 51.2C76.8 34.133 91.733 27.733 108.8 32c9.737 2.434 16.697 9.499 24.401 17.318C145.751 62.057 160.275 76.8 192 76.8c34.133 0 55.467-17.067 64-51.2c-12.8 17.067-27.733 23.467-44.8 19.2c-9.737-2.434-16.697-9.499-24.401-17.318C173.999 14.743 159.475 0 128 0M64 76.8C29.867 76.8 8.533 93.867 0 128c12.8-17.067 27.733-23.467 44.8-19.2c9.737 2.434 16.697 9.499 24.401 17.318C81.751 138.857 96.275 153.6 128 153.6c34.133 0 55.467-17.067 64-51.2c-12.8 17.067-27.733 23.467-44.8 19.2c-9.737-2.434-16.697-9.499-24.401-17.318C109.999 91.543 95.475 76.8 64 76.8"
      />
    </svg>
  );
}

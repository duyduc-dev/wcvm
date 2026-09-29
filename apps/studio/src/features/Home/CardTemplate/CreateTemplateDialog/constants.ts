import type { Icon } from "@phosphor-icons/react";
import type { ReactElement } from "react";
import type { IWcvmProjectType } from "@/services/wcvm/model";
import {
  BootstrapLogoIcon,
  JsLogoIcon,
  LitLogoIcon,
  PreactLogoIcon,
  QwikLogoIcon,
  ReactLogoIcon,
  RectifyLogoIcon,
  SolidLogoIcon,
  StaticLogoIcon,
  TanstackLogoIcon,
  TsLogoIcon,
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

// Mirrors vivari's own "Frontend" template picker (~/workspace/vivari/packages/studio/src/vv/templates.ts).
// Svelte is deliberately NOT here: PLAN.md/HISTORY.md already document it as PARKED in wcvm
// specifically - a real circular-ESM limitation in Svelte's own compiler, not a version-pinning
// issue, hit independently of vivari.
export const FRAMEWORK_OPTIONS: IFrameworkOption[] = [
  {
    id: "react-ts",
    label: "React",
    description: "TypeScript",
    icon: ReactLogoIcon,
    category: "Frontend",
  },
  {
    id: "react",
    label: "React",
    description: "JavaScript",
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
    id: "vue",
    label: "Vue",
    description: "JavaScript",
    icon: VueLogoIcon,
    category: "Frontend",
  },
  {
    id: "vanilla-ts",
    label: "Vanilla",
    description: "TypeScript",
    icon: TsLogoIcon,
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
    id: "static",
    label: "Static",
    description: "JavaScript",
    icon: StaticLogoIcon,
    category: "Frontend",
  },
  {
    id: "bootstrap",
    label: "Bootstrap 5",
    description: "TypeScript",
    icon: BootstrapLogoIcon,
    category: "Frontend",
  },
  {
    id: "preact-ts",
    label: "Preact",
    description: "TypeScript",
    icon: PreactLogoIcon,
    category: "Frontend",
  },
  {
    id: "lit-ts",
    label: "Lit",
    description: "TypeScript",
    icon: LitLogoIcon,
    category: "Frontend",
  },
  {
    id: "solid-ts",
    label: "Solid",
    description: "TypeScript",
    icon: SolidLogoIcon,
    category: "Frontend",
  },
  {
    id: "qwik-ts",
    label: "Qwik",
    description: "TypeScript",
    icon: QwikLogoIcon,
    category: "Frontend",
  },
  {
    // Smoke-tested with a real dev server (2026-09-29): it scaffolds and `npm install`s fine, but
    // the dev server itself never starts. Root cause confirmed by reading the real published
    // source, not guessed: @tanstack/router-plugin hard-depends on zod@^4.5.4, and zod v4's own
    // `v4/core/core.js`/`v4/core/util.js` have a genuine, unconditional circular static ESM import
    // (core.js imports util.js's `installMembers`; util.js imports core.js's `globalConfig` right
    // back) - the exact same wcvm ESM-loader limitation Svelte is already PARKED for (see
    // HISTORY.md), just tripped by a different dependency. Left in the picker (unlike Qwik, which
    // was left out entirely) since it's a real Studio feature people may want, but labeled broken
    // rather than "experimental" so nobody mistakes this for merely untested.
    id: "tanstack-router",
    label: "TanStack Router",
    description: "TypeScript (broken)",
    icon: TanstackLogoIcon,
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

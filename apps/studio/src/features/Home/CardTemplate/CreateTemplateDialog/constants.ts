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
// Svelte is deliberately NOT here: PLAN.md/HISTORY.md documented it as PARKED in wcvm specifically
// for a real circular-ESM limitation in Svelte's own compiler. That underlying wcvm ESM-loader
// limitation is now FIXED (2026-09-29 - see runtime/esm/loader.ts's and runtime/esm/cyclic.ts's
// own doc comments; proven against TanStack Router's own real circular dependency below), but
// Svelte itself hasn't been RE-VERIFIED against the fix yet - still not offered until someone
// actually checks, not because the original blocker is assumed to still apply.
// Angular and Ember aren't here either - vivari's own recipes for both need a Rolldown-WASM binding
// wcvm doesn't have (vitePins.ts documents why Vite 7 is pinned instead); neither was attempted.
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
    // FIXED (2026-09-29): was smoke-tested with a real dev server first and found broken - it
    // scaffolded and `npm install`ed fine, but the dev server itself never started, because
    // @tanstack/router-plugin hard-depends on zod@^4.5.4, and zod v4's own `v4/core/core.js`/
    // `v4/core/util.js` have a genuine, unconditional circular static ESM import (core.js imports
    // util.js's `installMembers`; util.js imports core.js's `globalConfig` right back) - the exact
    // same wcvm ESM-loader limitation Svelte is PARKED for. Root-caused and fixed at the loader
    // level (runtime/esm/loader.ts, runtime/esm/cyclic.ts) rather than worked around here - along
    // the way, also found and fixed a missing `node:vm` builtin (needed by `jiti`, Vite's own
    // config-loading dependency) and a real gap in the cyclic rewrite itself (a LOCAL re-export of
    // a cyclic import, hit by a genuine 3-module cycle inside @tanstack/router-core), plus a
    // preview-relay basepath issue specific to this being the first CLIENT-SIDE-ROUTED template
    // (TanStack Router matches routes against the real `window.location.pathname`, which includes
    // wcvm's own `/__wcvm_preview__/<port>/` prefix - see this template's own MAIN_TSX). Verified
    // end to end in real Chromium against the real npm registry: install, dev server start,
    // real route rendering, and real client-side navigation between routes.
    id: "tanstack-router",
    label: "TanStack Router",
    description: "TypeScript",
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

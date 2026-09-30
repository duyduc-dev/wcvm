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
  SvelteLogoIcon,
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
// Svelte was RE-VERIFIED (2026-09-29) against the circular-ESM fix below and works: create-vite's
// own official "svelte-ts" template, going through the generic viteTemplateProject.ts path exactly
// like vue-ts/preact-ts/etc - no hand-written recipe needed, just a plugin pin (vitePins.ts's
// KNOWN_PLUGIN_PINS: "@sveltejs/vite-plugin-svelte" -> "^6.2.4", the last major still compatible
// with this sandbox's pinned vite@7 - vite-plugin-svelte@^7 needs vite@8+, which needs the
// Rolldown-WASM binding this sandbox doesn't have). See tanstack-router's own entry below for what
// the circular-ESM fix actually was.
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
    id: "svelte-ts",
    label: "Svelte",
    description: "TypeScript",
    icon: SvelteLogoIcon,
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

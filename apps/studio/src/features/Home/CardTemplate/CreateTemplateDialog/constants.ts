import type { Icon } from "@phosphor-icons/react";
import type { ReactElement } from "react";
import type { IWcvmProjectType } from "@/services/wcvm/model";
import {
  AngularLogoIcon,
  AstroLogoIcon,
  BootstrapLogoIcon,
  EmberLogoIcon,
  ExpressLogoIcon,
  JsLogoIcon,
  LitLogoIcon,
  NestLogoIcon,
  NextjsLogoIcon,
  NuxtLogoIcon,
  PreactLogoIcon,
  QwikLogoIcon,
  ReactLogoIcon,
  ReactRouterLogoIcon,
  RectifyLogoIcon,
  SolidLogoIcon,
  StaticLogoIcon,
  SvelteLogoIcon,
  TailwindLogoIcon,
  TanstackLogoIcon,
  TsLogoIcon,
  VueLogoIcon,
  type ITemplateIconProps,
} from "./templateIcons";

export type ITemplateCategory = "Frontend" | "Backend" | "Fullstack" | "Experimental";

export const TEMPLATE_CATEGORIES: ITemplateCategory[] = [
  "Frontend",
  "Backend",
  "Fullstack",
  "Experimental",
];

export interface IFrameworkOption {
  id: Exclude<IWcvmProjectType, "blank">;
  label: string;
  description: string;
  icon: Icon | ((props: ITemplateIconProps) => ReactElement);
  category: ITemplateCategory;
}

/** Shown (greyed out, "Soon") but not selectable: the next planned templates. They have no project
 * type yet, so they are deliberately not part of `FRAMEWORK_OPTIONS` or the form's schema. */
export interface IUpcomingOption {
  label: string;
  description: string;
  icon: IFrameworkOption["icon"];
  category: ITemplateCategory;
  /** Marked "exp" in the picker, like the experimental templates elsewhere. */
  experimental?: boolean;
}

// Svelte was RE-VERIFIED (2026-09-29) against the circular-ESM fix below and works: create-vite's
// own official "svelte-ts" template, going through the generic viteTemplateProject.ts path exactly
// like vue-ts/preact-ts/etc - no hand-written recipe needed, just a plugin pin (vitePins.ts's
// KNOWN_PLUGIN_PINS: "@sveltejs/vite-plugin-svelte" -> "^6.2.4", the last major still compatible
// with this sandbox's pinned vite@7 - vite-plugin-svelte@^7 needs vite@8+, which needs the
// Rolldown-WASM binding this sandbox doesn't have). See tanstack-router's own entry below for what
// the circular-ESM fix actually was.
// Ember and Angular are here (2026-10-01, see their entries below).
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
    // FIXED (2026-09-30): Tailwind CSS v4's own @tailwindcss/vite plugin statically imports two
    // native-Rust packages with no plain-JS fallback (@tailwindcss/oxide, and lightningcss via
    // @tailwindcss/node). lightningcss is swapped for lightningcss-wasm via the same `overrides`
    // trick esbuild/rollup already use; @tailwindcss/oxide's own already-installed (wcvm's npm
    // fakes cpu="wasm32", matching that package's own optionalDependency gating) `-wasm32-wasi`
    // sibling ships a browser build using the same @napi-rs/wasm-runtime shape already proven
    // inside wcvm for @rolldown/browser - reached via a post-install patch (see
    // tailwindTemplateProject.ts's own top comment for the full writeup). A SEPARATE, deeper
    // problem: the plugin's own native Scanner.scan() (real FS globbing) deadlocks - a spawned
    // WASI worker's own file reads relay back to the creator thread via postMessage + Atomics.wait,
    // but the creator thread is itself already frozen in its own Atomics.wait waiting on that same
    // worker. Content-based Scanner.scanFiles() avoids that specific deadlock, but deadlocks too
    // the instant it's given more than one line of input in a single call - fixed by patching the
    // plugin's own bundle to call it once per non-blank line instead (proven fast and correct,
    // real Tailwind CSS generating and applying, checked via a real computed style not just markup
    // presence). Verified end to end in real Chromium against the real npm registry.
    id: "tailwind",
    label: "Tailwind CSS",
    description: "TypeScript",
    icon: TailwindLogoIcon,
    category: "Frontend",
  },
  {
    // ADDED (2026-10-01): Ember 7.3 via its own Vite blueprint (@ember/app-blueprint) - see
    // emberTemplateProject.ts for the recipe and what had to be fixed in wcvm to run it
    // (`require(esm)`, `npx`, legacy package resolution, call-site file names, a global
    // MessageChannel fix, a longest-pattern exports match). Verified end to end in real Chromium
    // against the real npm registry: install, dev server start, the app rendering in the preview.
    id: "ember-ts",
    label: "Ember",
    description: "TypeScript",
    icon: EmberLogoIcon,
    category: "Frontend",
  },
  {
    id: "ember",
    label: "Ember",
    description: "JavaScript",
    icon: EmberLogoIcon,
    category: "Frontend",
  },
  {
    // ADDED (2026-10-01): Angular 22 - @angular/build on vite 7 (overrides), with the native
    // esbuild/rollup/@parcel/watcher swapped for WebAssembly builds, a stubbed oxc-parser and
    // Babel linking. Verified end to end in real Chromium against the real npm registry. See
    // angularRecipe.ts and HISTORY.md "Angular" for what it took (Piscina's worker pool hangs
    // without `process.versions.webcontainer`, which wcvm now sets, among others).
    id: "angular",
    label: "Angular",
    description: "TypeScript",
    icon: AngularLogoIcon,
    category: "Frontend",
  },
  // Backend (2026-10-01): verified in real Chromium
  // against the real npm registry - see services/wcvm/templateProjects/backendRecipes.ts (TypeScript
  // is built with `tsc` and run with `node`; the NestJS CLI can't run here yet).
  {
    id: "express",
    label: "Express",
    description: "JavaScript",
    icon: ExpressLogoIcon,
    category: "Backend",
  },
  {
    id: "express-ts",
    label: "Express",
    description: "TypeScript",
    icon: ExpressLogoIcon,
    category: "Backend",
  },
  {
    id: "nestjs",
    label: "NestJS",
    description: "TypeScript",
    icon: NestLogoIcon,
    category: "Backend",
  },
  // Fullstack (2026-10-01): Next.js, SvelteKit, React Router 7 and Astro were each run for real - install,
  // `npm run dev`, then the preview iframe: server-rendered HTML, a client interaction, a server endpoint
  // and client-side navigation. See services/wcvm/templateProjects/fullstackRecipes.ts for what each needs
  // and HISTORY.md for the runtime gaps they exposed.
  {
    id: "nextjs-ts",
    label: "Next.js",
    description: "TypeScript",
    icon: NextjsLogoIcon,
    category: "Fullstack",
  },
  {
    id: "nextjs",
    label: "Next.js",
    description: "JavaScript",
    icon: NextjsLogoIcon,
    category: "Fullstack",
  },
  {
    id: "sveltekit",
    label: "SvelteKit",
    description: "TypeScript",
    icon: SvelteLogoIcon,
    category: "Fullstack",
  },
  {
    id: "react-router",
    label: "React Router 7",
    description: "TypeScript",
    icon: ReactRouterLogoIcon,
    category: "Fullstack",
  },
  {
    id: "astro",
    label: "Astro",
    description: "TypeScript",
    icon: AstroLogoIcon,
    category: "Fullstack",
  },
  {
    id: "rectify",
    label: "Rectify",
    description: "TypeScript",
    icon: RectifyLogoIcon,
    category: "Experimental",
  },
];

/** Still to come. Nuxt needs `oxc-parser`, whose WebAssembly binding deadlocks on multi-line input (the same
 * napi-rs worker problem as Angular's - see PLAN.md), and Nuxt 4 needs Vite 8 (no WebAssembly Rolldown here). */
export const UPCOMING_OPTIONS: IUpcomingOption[] = [
  { label: "Nuxt", description: "TypeScript", icon: NuxtLogoIcon, category: "Fullstack", experimental: true },
];

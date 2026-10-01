// Next.js, SvelteKit, React Router 7 and Astro starters. Each was run for real - installed from the
// real npm registry, `npm run dev`, then opened in Studio's preview iframe: server-rendered HTML, a
// client-side interaction, a server endpoint called with `fetch()`, and a client-side navigation. What
// each needed from wcvm itself is in HISTORY.md ("Fullstack templates: what they needed from the
// runtime"); what each needs from its RECIPE is here:
//
//  - Vite-based ones (SvelteKit, React Router, Astro) take the shared pins (`pinVitePackage`): Vite 7 -
//    there is no WebAssembly Rolldown here, so Vite 8 (and so Astro 7, Nuxt 4) can't run - plus esbuild
//    and rollup swapped for their WASM builds. Astro is ^6 for that reason.
//  - Under the preview, the app lives at `/__wcvm_preview__/<port>/` while its dev server only ever
//    sees the path with that prefix stripped. A client-side router matches against the real
//    `location.pathname`, so it needs the prefix at runtime (the port isn't known ahead of time):
//    React Router below (`app/entry.client.tsx`), as TanStack Router does. SvelteKit derives its base
//    from `location` itself; Next.js and Astro need nothing.
//  - Next.js: webpack + the WASM SWC (`process.versions.webcontainer` selects it). Next looks for it at
//    `node_modules/next/wasm/@next/swc-wasm-nodejs` and otherwise tries to download it; wcvm's npm never
//    runs `postinstall`, so `postInstall` links the installed package there.
//  - Not here: Nuxt. `nuxt dev` needs `oxc-parser`, whose WebAssembly binding hits the same napi-rs
//    worker deadlock as Angular's (see PLAN.md); Nuxt 4 also needs Vite 8.

import { pinVitePackage } from "./vitePins";

export type FullstackKind = "nextjs" | "nextjs-ts" | "sveltekit" | "react-router" | "astro";

export interface IFullstackRecipe {
  /** Shown in the progress message. */
  label: string;
  files: [path: string, contents: string][];
  /** `name` is filled in with the project's own name. */
  packageJson: Record<string, unknown>;
  /** Applies the shared Vite 7 / WASM pins to the package.json. */
  vitePins: boolean;
  /** Relative to the project: a symlink to create after `npm install` (what `postinstall` would do). */
  links?: { path: string; target: string }[];
  /** Roughly how long the first install takes, for the progress message. */
  installHint: string;
}

const GITIGNORE = "node_modules\n.next\n.svelte-kit\n.react-router\n.astro\ndist\nbuild\n";
const readme = (title: string, notes: string): string => `# ${title}

A full-stack app running entirely in your browser (wcvm).

\`\`\`bash
npm run dev
\`\`\`

${notes}
`;

// ── Next.js ───────────────────────────────────────────────────────────────

const nextRecipe = (ts: boolean): IFullstackRecipe => {
  const ext = ts ? "tsx" : "js";
  const tsFiles: [string, string][] = ts
    ? [
        [
          "tsconfig.json",
          `{
  "compilerOptions": {
    "target": "ES2017",
    "lib": ["dom", "dom.iterable", "esnext"],
    "allowJs": true,
    "skipLibCheck": true,
    "strict": true,
    "noEmit": true,
    "esModuleInterop": true,
    "module": "esnext",
    "moduleResolution": "bundler",
    "resolveJsonModule": true,
    "isolatedModules": true,
    "jsx": "react-jsx",
    "incremental": true,
    "plugins": [{ "name": "next" }]
  },
  "include": ["next-env.d.ts", "**/*.ts", "**/*.tsx", ".next/types/**/*.ts", ".next/dev/types/**/*.ts"],
  "exclude": ["node_modules"]
}
`,
        ],
        [
          "next-env.d.ts",
          `/// <reference types="next" />
/// <reference types="next/image-types/global" />

// NOTE: This file should not be edited
// see https://nextjs.org/docs/app/api-reference/config/typescript for more information.
`,
        ],
      ]
    : [];

  const layout = ts
    ? `import type { ReactNode } from "react";

export const metadata = { title: "Next.js app" };

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <body style={{ fontFamily: "system-ui, sans-serif", margin: 0, padding: "2rem" }}>{children}</body>
    </html>
  );
}
`
    : `export const metadata = { title: "Next.js app" };

export default function RootLayout({ children }) {
  return (
    <html lang="en">
      <body style={{ fontFamily: "system-ui, sans-serif", margin: 0, padding: "2rem" }}>{children}</body>
    </html>
  );
}
`;

  return {
    label: `Next.js (${ts ? "TypeScript" : "JavaScript"})`,
    vitePins: false,
    installHint: "about a minute",
    links: [{ path: "node_modules/next/wasm/@next/swc-wasm-nodejs", target: "../../../@next/swc-wasm-nodejs" }],
    packageJson: {
      version: "0.1.0",
      private: true,
      scripts: { dev: "next dev --webpack -p 3000", build: "next build --webpack", start: "next start -p 3000" },
      dependencies: { next: "~16.3.0", react: "^19.0.0", "react-dom": "^19.0.0", "@next/swc-wasm-nodejs": "~16.3.0" },
      ...(ts ? { devDependencies: { "@types/node": "^22.10.0", "@types/react": "^19.0.0", "@types/react-dom": "^19.0.0", typescript: "^5.7.0" } } : {}),
    },
    files: [
      ["next.config.mjs", `/** @type {import('next').NextConfig} */\nconst nextConfig = {};\n\nexport default nextConfig;\n`],
      ...tsFiles,
      [`app/layout.${ext}`, layout],
      [
        `app/page.${ext}`,
        `import Link from "next/link";
import Counter from "./Counter";

// A server component: this runs on the server and only its HTML reaches the browser.
export default function Home() {
  const renderedOn = "the server";
  return (
    <main>
      <h1>Next.js</h1>
      <p>Rendered on {renderedOn}. Edit <code>app/page.${ext}</code> and save.</p>
      <Counter />
      <p><Link href="/about">About</Link></p>
    </main>
  );
}
`,
      ],
      [
        `app/Counter.${ext}`,
        `"use client";

import { useState } from "react";

// A client component: hydrated in the browser, calls the route handler in app/api/hello.
export default function Counter() {
  const [count, setCount] = useState(0);
  const [message, setMessage] = useState("");

  async function callApi() {
    const response = await fetch("api/hello");
    setMessage(JSON.stringify(await response.json()));
  }

  return (
    <div>
      <button onClick={() => setCount(count + 1)}>count is {count}</button>{" "}
      <button onClick={callApi}>call /api/hello</button>
      <pre>{message}</pre>
    </div>
  );
}
`,
      ],
      [
        `app/about/page.${ext}`,
        `import Link from "next/link";

export default function About() {
  return (
    <main>
      <h1>About</h1>
      <p><Link href="/">Home</Link></p>
    </main>
  );
}
`,
      ],
      [`app/api/hello/route.${ts ? "ts" : "js"}`, `export function GET() {\n  return Response.json({ message: "Hello from Next.js" });\n}\n`],
      [".gitignore", GITIGNORE],
      ["README.md", readme(`Next.js (${ts ? "TypeScript" : "JavaScript"})`, "App Router, webpack and the WebAssembly SWC compiler. The first page request compiles on demand and takes 15-30 seconds; after that it is fast.")],
    ],
  };
};

// ── SvelteKit ─────────────────────────────────────────────────────────────

const sveltekit: IFullstackRecipe = {
  label: "SvelteKit",
  vitePins: true,
  installHint: "under a minute",
  packageJson: {
    version: "0.0.1",
    private: true,
    type: "module",
    scripts: { dev: "vite dev", build: "vite build", preview: "vite preview", prepare: "svelte-kit sync || echo ''" },
    devDependencies: {
      "@sveltejs/adapter-auto": "^6.0.0",
      "@sveltejs/kit": "^2.40.0",
      "@sveltejs/vite-plugin-svelte": "^6.2.4",
      svelte: "^5.39.0",
      typescript: "^5.9.0",
    },
  },
  files: [
    [
      "svelte.config.js",
      `import adapter from "@sveltejs/adapter-auto";
import { vitePreprocess } from "@sveltejs/vite-plugin-svelte";

export default {
  preprocess: vitePreprocess(),
  kit: { adapter: adapter() },
};
`,
    ],
    [
      "vite.config.ts",
      `import { sveltekit } from "@sveltejs/kit/vite";
import { defineConfig } from "vite";

export default defineConfig({ plugins: [sveltekit()] });
`,
    ],
    ["tsconfig.json", `{\n  "extends": "./.svelte-kit/tsconfig.json",\n  "compilerOptions": { "allowJs": true, "checkJs": true, "esModuleInterop": true, "skipLibCheck": true, "strict": true }\n}\n`],
    [
      "src/app.html",
      `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    %sveltekit.head%
  </head>
  <body data-sveltekit-preload-data="hover">
    <div style="display: contents">%sveltekit.body%</div>
  </body>
</html>
`,
    ],
    ["src/app.d.ts", `declare global {\n  namespace App {}\n}\n\nexport {};\n`],
    [
      "src/routes/+layout.svelte",
      `<script lang="ts">
  let { children } = $props();
</script>

<main style="font-family: system-ui, sans-serif; padding: 2rem">
  {@render children()}
</main>
`,
    ],
    [
      "src/routes/+page.server.ts",
      `// Runs on the server only - the browser receives the data it returns.
export function load() {
  return { renderedOn: "the server" };
}
`,
    ],
    [
      "src/routes/+page.svelte",
      `<script lang="ts">
  let { data } = $props();
  let count = $state(0);
  let message = $state("");

  async function callApi() {
    const response = await fetch("api/hello");
    message = JSON.stringify(await response.json());
  }
</script>

<h1>SvelteKit</h1>
<p>Rendered on {data.renderedOn}. Edit <code>src/routes/+page.svelte</code> and save.</p>
<button onclick={() => count++}>count is {count}</button>
<button onclick={callApi}>call /api/hello</button>
<pre>{message}</pre>
<p><a href="/about">About</a></p>
`,
    ],
    ["src/routes/about/+page.svelte", `<h1>About</h1>\n<p><a href="/">Home</a></p>\n`],
    [
      "src/routes/api/hello/+server.ts",
      `import { json } from "@sveltejs/kit";

export function GET() {
  return json({ message: "Hello from SvelteKit" });
}
`,
    ],
    [".gitignore", GITIGNORE],
    ["README.md", readme("SvelteKit", "Server-rendered routes, a `+server.ts` endpoint and client-side navigation, on Vite.")],
  ],
};

// ── React Router 7 (framework mode) ───────────────────────────────────────

const reactRouter: IFullstackRecipe = {
  label: "React Router 7",
  vitePins: true,
  installHint: "under a minute",
  packageJson: {
    private: true,
    type: "module",
    scripts: { dev: "react-router dev", build: "react-router build", start: "react-router-serve ./build/server/index.js", typecheck: "react-router typegen && tsc" },
    dependencies: {
      "@react-router/node": "^7.9.0",
      "@react-router/serve": "^7.9.0",
      isbot: "^5.1.0",
      react: "^19.0.0",
      "react-dom": "^19.0.0",
      "react-router": "^7.9.0",
    },
    devDependencies: { "@react-router/dev": "^7.9.0", "@types/react": "^19.0.0", "@types/react-dom": "^19.0.0", typescript: "^5.9.0" },
  },
  files: [
    ["react-router.config.ts", `import type { Config } from "@react-router/dev/config";\n\nexport default { ssr: true } satisfies Config;\n`],
    ["vite.config.ts", `import { reactRouter } from "@react-router/dev/vite";\nimport { defineConfig } from "vite";\n\nexport default defineConfig({ plugins: [reactRouter()] });\n`],
    [
      "tsconfig.json",
      `{
  "include": ["**/*", ".react-router/types/**/*"],
  "compilerOptions": {
    "lib": ["DOM", "DOM.Iterable", "ES2022"],
    "types": ["node", "vite/client"],
    "target": "ES2022",
    "module": "ES2022",
    "moduleResolution": "bundler",
    "jsx": "react-jsx",
    "rootDirs": [".", "./.react-router/types"],
    "strict": true,
    "skipLibCheck": true,
    "esModuleInterop": true,
    "noEmit": true
  }
}
`,
    ],
    [
      "app/entry.client.tsx",
      `import { startTransition, StrictMode } from "react";
import { hydrateRoot } from "react-dom/client";
import { HydratedRouter } from "react-router/dom";

// Studio serves the preview under /__wcvm_preview__/<port>/, but the dev server only ever sees the
// path with that prefix stripped - so the client router has to be told about it. The port isn't known
// ahead of time (it's whatever the dev server picks), so this is read at runtime. Outside the preview
// this is "/" and does nothing.
const segments = window.location.pathname.split("/").filter(Boolean);
if (segments[0] === "__wcvm_preview__" && segments[1]) {
  (window as any).__reactRouterContext.basename = "/" + segments[0] + "/" + segments[1];
}

startTransition(() => {
  hydrateRoot(
    document,
    <StrictMode>
      <HydratedRouter />
    </StrictMode>,
  );
});
`,
    ],
    [
      "app/root.tsx",
      `import { Links, Meta, Outlet, Scripts, ScrollRestoration } from "react-router";

export default function Root() {
  return (
    <html lang="en">
      <head>
        <meta charSet="utf-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1" />
        <Meta />
        <Links />
      </head>
      <body style={{ fontFamily: "system-ui, sans-serif", padding: "2rem" }}>
        <Outlet />
        <ScrollRestoration />
        <Scripts />
      </body>
    </html>
  );
}
`,
    ],
    [
      "app/routes.ts",
      `import { type RouteConfig, index, route } from "@react-router/dev/routes";

export default [
  index("routes/home.tsx"),
  route("about", "routes/about.tsx"),
  route("api/hello", "routes/api.hello.ts"),
] satisfies RouteConfig;
`,
    ],
    [
      "app/routes/home.tsx",
      `import { useState } from "react";
import { Link } from "react-router";

// Runs on the server; the component receives what it returns.
export function loader() {
  return { renderedOn: "the server" };
}

export default function Home({ loaderData }: { loaderData: { renderedOn: string } }) {
  const [count, setCount] = useState(0);
  const [message, setMessage] = useState("");

  async function callApi() {
    const response = await fetch("api/hello");
    setMessage(JSON.stringify(await response.json()));
  }

  return (
    <main>
      <h1>React Router 7</h1>
      <p>Rendered on {loaderData.renderedOn}. Edit <code>app/routes/home.tsx</code> and save.</p>
      <button onClick={() => setCount(count + 1)}>count is {count}</button>{" "}
      <button onClick={callApi}>call /api/hello</button>
      <pre>{message}</pre>
      <p><Link to="/about">About</Link></p>
    </main>
  );
}
`,
    ],
    [
      "app/routes/about.tsx",
      `import { Link } from "react-router";

export default function About() {
  return (
    <main>
      <h1>About</h1>
      <p><Link to="/">Home</Link></p>
    </main>
  );
}
`,
    ],
    ["app/routes/api.hello.ts", `export function loader() {\n  return Response.json({ message: "Hello from React Router" });\n}\n`],
    [".gitignore", GITIGNORE],
    ["README.md", readme("React Router 7", "Framework mode: server-rendered routes with loaders, a resource route and client-side navigation, on Vite.")],
  ],
};

// ── Astro ─────────────────────────────────────────────────────────────────

const astro: IFullstackRecipe = {
  label: "Astro",
  vitePins: true,
  installHint: "under a minute",
  packageJson: {
    private: true,
    type: "module",
    scripts: { dev: "astro dev", build: "astro build", preview: "astro preview" },
    // Astro 6, not the current 7: 7 needs Vite 8 (Rolldown), which has no WebAssembly build here.
    dependencies: { astro: "^6.4.0" },
  },
  files: [
    ["astro.config.mjs", `import { defineConfig } from "astro/config";\n\nexport default defineConfig({});\n`],
    ["tsconfig.json", `{\n  "extends": "astro/tsconfigs/strict",\n  "include": [".astro/types.d.ts", "**/*"],\n  "exclude": ["dist"]\n}\n`],
    [
      "src/pages/index.astro",
      `---
// This frontmatter runs on the server; only the HTML below reaches the browser.
const renderedOn = "the server";
---

<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>Astro</title>
  </head>
  <body style="font-family: system-ui, sans-serif; padding: 2rem">
    <main>
      <h1>Astro</h1>
      <p>Rendered on {renderedOn}. Edit <code>src/pages/index.astro</code> and save.</p>
      <button id="count">count is 0</button>
      <button id="api">call /api/hello</button>
      <pre id="message"></pre>
      <p><a href="/about">About</a></p>
    </main>

    <script>
      let count = 0;
      const button = document.getElementById("count")!;
      button.addEventListener("click", () => {
        count++;
        button.textContent = "count is " + count;
      });

      document.getElementById("api")!.addEventListener("click", async () => {
        const response = await fetch("api/hello.json");
        document.getElementById("message")!.textContent = JSON.stringify(await response.json());
      });
    </script>
  </body>
</html>
`,
    ],
    [
      "src/pages/about.astro",
      `---
---

<html lang="en">
  <head>
    <meta charset="utf-8" />
    <title>About</title>
  </head>
  <body style="font-family: system-ui, sans-serif; padding: 2rem">
    <main>
      <h1>About</h1>
      <p><a href="/">Home</a></p>
    </main>
  </body>
</html>
`,
    ],
    [
      "src/pages/api/hello.json.ts",
      `import type { APIRoute } from "astro";

export const GET: APIRoute = () =>
  new Response(JSON.stringify({ message: "Hello from Astro" }), {
    headers: { "content-type": "application/json" },
  });
`,
    ],
    [".gitignore", GITIGNORE],
    ["README.md", readme("Astro", "Pages rendered on the server with a small client script, an API endpoint and plain links, on Vite.")],
  ],
};

export const FULLSTACK_RECIPES: Record<FullstackKind, IFullstackRecipe> = {
  nextjs: nextRecipe(false),
  "nextjs-ts": nextRecipe(true),
  sveltekit,
  "react-router": reactRouter,
  astro,
};

/** The package.json to write for a project: the recipe's, named, with the shared pins where it wants them. */
export function buildFullstackPackageJson(recipe: IFullstackRecipe, name: string): Record<string, unknown> {
  const pkg = { name, ...JSON.parse(JSON.stringify(recipe.packageJson)) } as Record<string, unknown> & {
    devDependencies?: Record<string, string>;
    overrides?: Record<string, string>;
  };
  if (recipe.vitePins) pinVitePackage(pkg);
  return pkg;
}

import { getWcvmInstance } from "@/lib/wcvm";
import { PREVIEW_SEGMENT } from "@/lib/wcvm/previewPrefix";
import { collectText } from "./processUtils";
import { tryCloneFromCache } from "./templateCache";
import { pinVitePackage } from "./vitePins";

export interface TanstackRouterTemplateCreationResult {
  isFailure: boolean;
  message: string;
  type?: string;
}

// TanStack Router (v1) has no official create-vite template, so - same approach as
// rectifyTemplateProject.ts/bootstrapTemplateProject.ts - this starts from Vite's own "react-ts"
// scaffold and replaces its entry files with a router setup.
//
// CORRECTED (2026-09-29, found for real - not just suspected - by actually loading the preview
// iframe's own URL directly): the ORIGINAL version of this comment claimed wcvm's preview needs
// no base/basepath handling. That's true for every OTHER
// template here, but wrong for a CLIENT-SIDE ROUTER specifically: wcvm's own preview relay DOES
// serve each project under a real URL prefix, `/__studio_preview__/<port>/` (see PLAN.md's
// "absolute-path routing") - the iframe's own `src` IS that prefixed URL, so
// `window.location.pathname` inside it genuinely starts with it. TanStack Router matches routes
// against that real pathname, so without a matching `basepath`, the app's own root route never
// matches at all - it 404s ("Not Found") the moment the preview iframe navigates there, even
// though the exact same app works fine at a plain, unprefixed "/". A build-time Vite `base`
// config can't fix this either: the PORT isn't known ahead of time (Studio just opens a terminal
// and the user types `npm run dev` themselves - see IdeController.ts - so Vite picks whatever
// port is free). `MAIN_TSX` below computes the prefix at RUNTIME instead, from the page's own
// real `window.location.pathname` - a plain "/" (Vite's own default) when NOT previewed through
// wcvm's relay at all (e.g. `vite preview`, or any other host).
const VITE_CONFIG_JS = `import { defineConfig } from "vite";
import { tanstackRouter } from "@tanstack/router-plugin/vite";
import viteReact from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [
    // The router plugin MUST come before React's so routeTree.gen.ts is generated
    // before the React transform runs.
    tanstackRouter({ target: "react", autoCodeSplitting: true }),
    viteReact(),
  ],
});
`;

const MAIN_TSX = `import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { RouterProvider, createRouter } from "@tanstack/react-router";
import { routeTree } from "./routeTree.gen";

// wcvm's preview relay serves this project under a /__studio_preview__/<port>/ prefix - the router
// needs to know about it, since it matches routes against the real window.location.pathname,
// which includes that prefix inside the preview iframe. The port isn't known ahead of time (you
// start the dev server yourself, on whatever port Vite picks), so this is computed at runtime,
// not a build-time Vite "base" config. Outside wcvm's preview (e.g. a plain "vite preview"), this
// is just "/", Vite's own default.
const segments = window.location.pathname.split("/").filter(Boolean);
const basepath = segments[0] === "${PREVIEW_SEGMENT}" && segments[1] ? "/" + segments[0] + "/" + segments[1] : "/";

// The @tanstack/router-plugin Vite plugin generates ./routeTree.gen.ts on dev start.
const router = createRouter({
  routeTree,
  basepath,
  defaultPreload: "intent",
  scrollRestoration: true,
});

declare module "@tanstack/react-router" {
  interface Register {
    router: typeof router;
  }
}

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <RouterProvider router={router} />
  </StrictMode>,
);
`;

const ROOT_ROUTE_TSX = `import { Link, Outlet, createRootRoute } from "@tanstack/react-router";

export const Route = createRootRoute({
  component: RootComponent,
});

function RootComponent() {
  return (
    <div style={{ fontFamily: "system-ui, sans-serif" }}>
      <nav style={{ display: "flex", gap: "1rem", padding: "1rem" }}>
        <Link to="/">Home</Link>
        <Link to="/about">About</Link>
      </nav>
      <hr />
      <Outlet />
    </div>
  );
}
`;

const INDEX_ROUTE_TSX = `import { createFileRoute } from "@tanstack/react-router";

export const Route = createFileRoute("/")({
  component: Home,
});

function Home() {
  return (
    <main style={{ padding: "2rem" }}>
      <h1>TanStack Router</h1>
      <p>Type-safe, file-based routing for React — a client-side SPA on Vite.</p>
      <p>
        Edit <code>src/routes/index.tsx</code> and save, or add a file under{" "}
        <code>src/routes/</code>.
      </p>
    </main>
  );
}
`;

const ABOUT_ROUTE_TSX = `import { createFileRoute } from "@tanstack/react-router";

export const Route = createFileRoute("/about")({
  component: About,
});

function About() {
  return (
    <main style={{ padding: "2rem" }}>
      <h1>About</h1>
      <p>
        This route lives in <code>src/routes/about.tsx</code>.
      </p>
    </main>
  );
}
`;

const createTanstackRouterTemplateProject = async (
  projectPath: string,
  onProgress?: (message: string) => void,
): Promise<TanstackRouterTemplateCreationResult> => {
  const wc = getWcvmInstance();

  const isExisting = await wc.fs.exists(projectPath);
  if (isExisting) {
    return {
      isFailure: true,
      message: `A project already exists at ${projectPath}`,
      type: "projectName",
    };
  }

  onProgress?.("Checking the local template cache…");
  if (await tryCloneFromCache("tanstack-router", projectPath)) {
    return { isFailure: false, message: "ok" };
  }

  onProgress?.("Scaffolding a Vite + React + TypeScript base…");
  const created = await wc.spawn(
    "npm",
    [
      "create",
      "vite@latest",
      projectPath.slice(1),
      "--",
      "--template",
      "react-ts",
      "--no-interactive",
    ],
    { cwd: "/" },
  );
  const createdLog = await collectText(created);
  const createdExit = await created.exit;
  if (createdExit.exitCode !== 0) {
    return { isFailure: true, message: `npm create vite failed:\n${createdLog.trim()}` };
  }

  onProgress?.("Wiring up TanStack Router (@tanstack/react-router, router-plugin)…");
  const pkgPath = `${projectPath}/package.json`;
  const pkg = JSON.parse(new TextDecoder().decode(await wc.fs.readFile(pkgPath)));
  pkg.dependencies = { ...pkg.dependencies, "@tanstack/react-router": "^1.130.0" };
  pkg.devDependencies = { ...pkg.devDependencies, "@tanstack/router-plugin": "^1.130.0" };
  pinVitePackage(pkg);
  await wc.fs.writeFile(pkgPath, JSON.stringify(pkg, null, 2));
  await wc.fs.writeFile(`${projectPath}/vite.config.ts`, VITE_CONFIG_JS);
  await wc.fs.writeFile(`${projectPath}/src/main.tsx`, MAIN_TSX);
  // react-ts's own App.tsx/App.css aren't part of the router setup - the root route replaces them.
  if (await wc.fs.exists(`${projectPath}/src/App.tsx`)) {
    await wc.fs.rm(`${projectPath}/src/App.tsx`);
  }
  if (await wc.fs.exists(`${projectPath}/src/App.css`)) {
    await wc.fs.rm(`${projectPath}/src/App.css`);
  }
  await wc.fs.mkdir(`${projectPath}/src/routes`, { recursive: true });
  await wc.fs.writeFile(`${projectPath}/src/routes/__root.tsx`, ROOT_ROUTE_TSX);
  await wc.fs.writeFile(`${projectPath}/src/routes/index.tsx`, INDEX_ROUTE_TSX);
  await wc.fs.writeFile(`${projectPath}/src/routes/about.tsx`, ABOUT_ROUTE_TSX);

  // `npm install` is the slow part: the editor runs it in a visible terminal as soon as the project
  // opens (see IdeController.installDependenciesIfNeeded). Sync what was
  // written so far so a reload right after still has it.
  await wc.fs.sync();

  return { isFailure: false, message: "ok" };
};

export { createTanstackRouterTemplateProject };

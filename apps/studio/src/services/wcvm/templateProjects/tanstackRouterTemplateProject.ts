import { getWcvmInstance } from "@/lib/wcvm";
import { collectText } from "./processUtils";
import { populateCache, tryCloneFromCache } from "./templateCache";
import { pinVitePackage } from "./vitePins";

export interface TanstackRouterTemplateCreationResult {
  isFailure: boolean;
  message: string;
  type?: string;
}

// TanStack Router (v1) has no official create-vite template, so - same approach as
// rectifyTemplateProject.ts/bootstrapTemplateProject.ts - this starts from Vite's own "react-ts"
// scaffold and replaces its entry files with a router setup (ported from vivari's own
// "tanstack-router" template, itself shipped marked experimental there too - "Not yet gated by a
// spike run"). Unlike vivari's preview (which proxies every project under a shared
// /preview/<port>/ prefix, so its vite.config sets `base` to match), wcvm's preview serves each
// project's dev server directly (see PLAN.md's "absolute-path routing"), so this needs no base/
// basepath rewriting - plain defaults.
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

// The @tanstack/router-plugin Vite plugin generates ./routeTree.gen.ts on dev start.
const router = createRouter({
  routeTree,
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

  onProgress?.("Installing dependencies from the npm registry (about 10s)…");
  const install = await wc.spawn("npm", ["install"], { cwd: projectPath });
  const installLog = await collectText(install);
  const installExit = await install.exit;
  if (installExit.exitCode !== 0) {
    return { isFailure: true, message: `npm install failed:\n${installLog.trim()}` };
  }

  // OPFS persistence (boot({persist})) is write-behind - without this, a reload right after
  // "created" reports success could still lose files npm install just wrote but hadn't finished
  // mirroring yet (see wc.fs.sync()'s own doc comment). A no-op when persistence isn't enabled.
  await wc.fs.sync();

  // Fire-and-forget, AFTER the real project is already synced and reported - see
  // populateCache's own comment for why folding this into the sync() above would be wrong.
  void populateCache("tanstack-router", projectPath);

  return { isFailure: false, message: "ok" };
};

export { createTanstackRouterTemplateProject };

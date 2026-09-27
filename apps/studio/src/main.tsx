import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import "./index.css";
import { TooltipProvider } from "./components/ui/tooltip.tsx";
import { routeTree } from "./routeTree.gen";
import { createRouter, RouterProvider } from "@tanstack/react-router";
import { Toaster } from "./components/ui/toast.tsx";
import { bootWcvm } from "./lib/wcvm/index.ts";

declare module "@tanstack/react-router" {
  interface Register {
    router: typeof router;
  }
}

bootWcvm();
const router = createRouter({ routeTree });

const rootElement = document.getElementById("root")!;
if (!rootElement.innerHTML) {
  const root = createRoot(rootElement);
  root.render(
    <StrictMode>
      <TooltipProvider>
        <RouterProvider router={router} />
      </TooltipProvider>
      <Toaster />
    </StrictMode>,
  );
}

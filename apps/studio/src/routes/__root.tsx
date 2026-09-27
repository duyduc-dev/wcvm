import { toast } from "@/components/ui/toast";
import { getWcvmInstance } from "@/lib/wcvm";
import { Outlet, createRootRoute } from "@tanstack/react-router";
import { TanStackRouterDevtools } from "@tanstack/react-router-devtools";
import { useEffect } from "react";

export const Route = createRootRoute({
  component: RootComponent,
});

function RootComponent() {
  const loadWCVM = () => {
    toast.promise(getWcvmInstance().ready, {
      loading: "Initializing WCVM ...",
      success: () => "Initialized WCVM successfully",
      error: "Could not initialize WCVM",
    });
  };

  useEffect(() => {
    loadWCVM();
  }, []);

  return (
    <>
      <Outlet />
      <TanStackRouterDevtools position="bottom-right" />
    </>
  );
}

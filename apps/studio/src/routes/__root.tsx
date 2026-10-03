import { toast } from "@/components/ui/toast";
import { getWcvmInstance } from "@/lib/wcvm";
import { Outlet, createRootRoute } from "@tanstack/react-router";
import { useEffect } from "react";

export const Route = createRootRoute({
  component: RootComponent,
});

function RootComponent() {
  const loadWCVM = () => {
    // The embedded editor shows its own placeholder; a toast would sit on top of the host's page.
    if (location.pathname.startsWith("/embed")) return;
    toast.promise(getWcvmInstance().ready, {
      loading: "Initializing WCVM ...",
      success: () => "Initialized WCVM successfully",
      error: "Could not initialize WCVM",
    });
  };

  useEffect(() => {
    loadWCVM();
  }, []);

  return <Outlet />;
}

import { createFileRoute, Outlet } from "@tanstack/react-router";

export const Route = createFileRoute("/_editor")({
  component: RouteComponent,
});

function RouteComponent() {
  return <Outlet />;
}

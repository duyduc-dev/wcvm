import Editor from "@/features/Editor";
import { useWcvmProjectStore } from "@/stores/useWcvmProjectStore";
import { createFileRoute, notFound } from "@tanstack/react-router";

export const Route = createFileRoute("/_editor/editor/$id")({
  beforeLoad: ({ params }) => {
    if (!useWcvmProjectStore.getState().getProject(params.id)) {
      throw notFound();
    }
  },
  notFoundComponent: () => <div>Project not found</div>,
  component: RouteComponent,
});

function RouteComponent() {
  const { id } = Route.useParams();
  const project = useWcvmProjectStore((s) =>
    s.projects.find((p) => p.id === id),
  );

  if (!project) return null;

  return <Editor project={project} />;
}

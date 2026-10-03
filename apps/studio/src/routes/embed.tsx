import Embed from "@/features/Embed";
import { createFileRoute } from "@tanstack/react-router";

// Top-level (not under _main / _editor): no site header, no project store lookup.
export const Route = createFileRoute("/embed")({
  component: Embed,
});

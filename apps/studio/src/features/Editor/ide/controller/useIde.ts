import { createContext, useContext, useSyncExternalStore } from "react";
import { IdeController } from "./IdeController";
import type { IdeSnapshot } from "./types";

export const IdeContext = createContext<IdeController | null>(null);

export function useController(): IdeController {
  const controller = useContext(IdeContext);
  if (!controller) throw new Error("useController must be used within <IdeProvider>");
  return controller;
}

/** Subscribes to the controller's immutable UI snapshot. */
export function useIde(): { c: IdeController; snap: IdeSnapshot } {
  const c = useController();
  const snap = useSyncExternalStore(c.subscribe, c.getSnapshot);
  return { c, snap };
}

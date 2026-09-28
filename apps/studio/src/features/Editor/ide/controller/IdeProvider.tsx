import { useEffect, useMemo, type ReactNode } from "react";
import { getWcvmInstance } from "@/lib/wcvm";
import { IdeController } from "./IdeController";
import { IdeContext } from "./useIde";

interface IProps {
  rootPath: string;
  projectId: string;
  children: ReactNode;
}

export function IdeProvider({ rootPath, projectId, children }: IProps) {
  const controller = useMemo(
    () => new IdeController(getWcvmInstance(), rootPath, projectId),
    [rootPath, projectId],
  );

  useEffect(() => {
    controller.start();
    // Dev-only handle for debugging + headless parity tests.
    if (import.meta.env.DEV) (window as unknown as { __ide: unknown }).__ide = controller;
    return () => controller.dispose();
  }, [controller]);

  return <IdeContext.Provider value={controller}>{children}</IdeContext.Provider>;
}

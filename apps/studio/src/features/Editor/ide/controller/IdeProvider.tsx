import { useEffect, useMemo, type ReactNode } from "react";
import { getWcvmInstance } from "@/lib/wcvm";
import { IdeController } from "./IdeController";
import { IdeContext } from "./useIde";

interface IProps {
  rootPath: string;
  children: ReactNode;
}

export function IdeProvider({ rootPath, children }: IProps) {
  const controller = useMemo(
    () => new IdeController(getWcvmInstance(), rootPath),
    [rootPath],
  );

  useEffect(() => {
    controller.start();
    // Dev-only handle for debugging + headless parity tests.
    if (import.meta.env.DEV) (window as unknown as { __ide: unknown }).__ide = controller;
    return () => controller.dispose();
  }, [controller]);

  return <IdeContext.Provider value={controller}>{children}</IdeContext.Provider>;
}

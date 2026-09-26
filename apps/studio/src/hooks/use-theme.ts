import { useState } from "react";
import { applyTheme, getInitialIsDark } from "@/lib/theme";

/** Local `isDark` state kept in sync with the shared, persisted app theme (see
 * src/lib/theme.ts) — for any page that just needs a toggle button, no editor/terminal side
 * effects to also apply (that's what IdeController.toggleTheme() is for). */
export function useTheme() {
  const [isDark, setIsDark] = useState(getInitialIsDark);

  const toggleTheme = () => {
    const next = !isDark;
    applyTheme(next);
    setIsDark(next);
  };

  return { isDark, toggleTheme };
}

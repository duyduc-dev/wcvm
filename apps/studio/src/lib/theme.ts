export const THEME_STORAGE_KEY = "wcvm-studio-theme";

/** Reads the persisted preference, falling back to the OS/browser preference the very first
 * time nothing's been chosen yet. */
export const getInitialIsDark = (): boolean => {
  const stored = localStorage.getItem(THEME_STORAGE_KEY);
  if (stored === "dark") return true;
  if (stored === "light") return false;
  return matchMedia("(prefers-color-scheme: dark)").matches;
};

/** Persists the choice and applies it to the whole app (the `.dark` class lives on `<html>`,
 * shared across every route — Tailwind's `dark:` variant and the app's own CSS variables key off
 * it). Called from the root route on boot (so every page starts in the right theme) and from
 * wherever a theme toggle button lives. */
export const applyTheme = (isDark: boolean): void => {
  localStorage.setItem(THEME_STORAGE_KEY, isDark ? "dark" : "light");
  document.documentElement.classList.toggle("dark", isDark);
};

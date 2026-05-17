/**
 * Lightweight theme toggle — dark by default, opt-in light.
 *
 * The canonical brand is dark (matches the warm-cream-on-near-black
 * direction). Light mode is supported but is the secondary skin: we
 * apply a `.light` class on <html> to switch into it. The default
 * (no class) is dark, which is what `:root` and `.dark` resolve to
 * in tokens.css.
 *
 * Persists choice in localStorage. Falls back to system preference on
 * first load.
 */
import { useEffect, useState } from "react";

const STORAGE_KEY = "ui.theme";

export type Theme = "light" | "dark";

function readInitialTheme(): Theme {
  if (typeof window === "undefined") return "dark";
  const stored = window.localStorage.getItem(STORAGE_KEY);
  if (stored === "light" || stored === "dark") return stored;
  // Default to dark (the canonical brand) unless the OS strongly
  // prefers light.
  return window.matchMedia("(prefers-color-scheme: light)").matches ? "light" : "dark";
}

function applyTheme(theme: Theme) {
  if (typeof document === "undefined") return;
  const root = document.documentElement;
  root.classList.remove("light", "dark");
  // We add "dark" too because Tailwind's darkMode: "class" still needs
  // it for `dark:` utilities to fire; both are valid simultaneously
  // because our base tokens default to dark.
  if (theme === "light") root.classList.add("light");
  else root.classList.add("dark");
}

export function useTheme(): { theme: Theme; setTheme: (t: Theme) => void; toggle: () => void } {
  const [theme, setThemeState] = useState<Theme>(readInitialTheme);

  useEffect(() => {
    applyTheme(theme);
  }, [theme]);

  useEffect(() => {
    if (typeof window === "undefined") return;
    const mq = window.matchMedia("(prefers-color-scheme: light)");
    const handler = (e: MediaQueryListEvent) => {
      if (window.localStorage.getItem(STORAGE_KEY)) return;
      setThemeState(e.matches ? "light" : "dark");
    };
    mq.addEventListener("change", handler);
    return () => mq.removeEventListener("change", handler);
  }, []);

  const setTheme = (next: Theme) => {
    setThemeState(next);
    if (typeof window !== "undefined") {
      window.localStorage.setItem(STORAGE_KEY, next);
    }
  };

  return {
    theme,
    setTheme,
    toggle: () => setTheme(theme === "dark" ? "light" : "dark"),
  };
}

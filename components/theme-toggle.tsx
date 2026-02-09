"use client";

import React from "react";

const KEY = "meka_theme";
type Theme = "dark" | "light";

function applyTheme(t: Theme) {
  const root = document.documentElement;
  if (t === "dark") root.classList.add("dark");
  else root.classList.remove("dark");
}

export default function ThemeToggle() {
  const [theme, setTheme] = React.useState<Theme>("dark");

  React.useEffect(() => {
    try {
      const saved = (localStorage.getItem(KEY) || "").trim() as Theme;
      const t: Theme = saved === "light" ? "light" : "dark";
      setTheme(t);
      applyTheme(t);
    } catch {
      setTheme("dark");
      applyTheme("dark");
    }
  }, []);

  const toggle = () => {
    const next: Theme = theme === "dark" ? "light" : "dark";
    setTheme(next);
    applyTheme(next);
    try {
      localStorage.setItem(KEY, next);
    } catch {
      // ignore
    }
  };

  return (
    <button
      onClick={toggle}
      className={[
        "rounded-md border px-3 py-1.5 text-xs font-semibold",
        "border-stone-200 bg-white text-stone-900 hover:bg-stone-50",
        "dark:border-stone-700 dark:bg-stone-900 dark:text-stone-100 dark:hover:bg-stone-800",
      ].join(" ")}
      title="Toggle theme"
      aria-label="Toggle theme"
    >
      {theme === "dark" ? "Dark" : "Light"}
    </button>
  );
}

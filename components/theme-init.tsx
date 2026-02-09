"use client";

import React from "react";

const KEY = "meka_theme";
type Theme = "dark" | "light";

function applyTheme(t: Theme) {
  const root = document.documentElement;
  if (t === "dark") root.classList.add("dark");
  else root.classList.remove("dark");
}

export default function ThemeInit() {
  React.useEffect(() => {
    try {
      const saved = (localStorage.getItem(KEY) || "").trim() as Theme;
      const theme: Theme = saved === "light" ? "light" : "dark"; // default dark
      applyTheme(theme);
      localStorage.setItem(KEY, theme);
    } catch {
      // If storage is blocked, still default to dark.
      applyTheme("dark");
    }
  }, []);

  return null;
}

(function initializeTheme() {
  let mode = "system";
  try {
    const saved = localStorage.getItem("laboratory_theme");
    if (saved === "dark" || saved === "light") mode = saved;
  } catch {}
  const resolved = mode === "system"
    ? (matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light")
    : mode;
  document.documentElement.dataset.theme = resolved;
  document.documentElement.dataset.themeMode = mode;
})();

// Runs before the app bundle so a saved Light theme paints on the very first
// frame instead of flashing dark. Must stay in step with APPEARANCE_STORAGE_KEY
// and APPEARANCE_MAX_BYTES in src/appearance.ts; the app bundle re-applies the
// full preferences later.
(function () {
  try {
    var raw = window.localStorage.getItem("gg-app:appearance:v1");
    if (!raw || raw.length > 2048) return;
    var theme = JSON.parse(raw).theme;
    if (theme !== "light" && theme !== "dark") return;
    document.documentElement.setAttribute("data-appearance-theme", theme);
    document.documentElement.style.colorScheme = theme;
  } catch (_) {
    // Unreadable storage keeps the default Dark startup background.
  }
})();

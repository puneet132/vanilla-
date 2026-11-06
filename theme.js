// Runs synchronously in <head> so the saved theme is applied before first
// paint (no light-to-dark flash). External file because the CSP forbids inline
// scripts. "light" / "dark" are explicit choices; no value means follow the OS.
(function () {
  try {
    var t = localStorage.getItem("vanilla.theme");
    if (t === "light" || t === "dark") document.documentElement.setAttribute("data-theme", t);
  } catch (e) { /* storage blocked: follow the OS */ }
})();

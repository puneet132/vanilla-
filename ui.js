// Presentation-only behaviour: theme toggle, landing-page CTAs, the
// "how it works" demo and scroll reveals. Deliberately separate from app.js —
// nothing here touches auth state, Firestore or the capture flow.
(function () {
  "use strict";
  var root = document.documentElement;
  var KEY = "vanilla.theme";
  var mq = window.matchMedia ? window.matchMedia("(prefers-color-scheme: dark)") : null;
  var reduce = window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches;

  function currentTheme() {
    var t = root.getAttribute("data-theme");
    if (t === "light" || t === "dark") return t;
    return mq && mq.matches ? "dark" : "light";
  }
  function syncToggle() {
    var btn = document.getElementById("themeToggle");
    if (!btn) return;
    var dark = currentTheme() === "dark";
    btn.setAttribute("aria-label", dark ? "Switch to light mode" : "Switch to dark mode");
    btn.setAttribute("aria-pressed", String(dark));
  }

  /* ---------- theme ---------- */
  var toggle = document.getElementById("themeToggle");
  if (toggle) {
    toggle.addEventListener("click", function () {
      var next = currentTheme() === "dark" ? "light" : "dark";
      root.setAttribute("data-theme", next);
      try { localStorage.setItem(KEY, next); } catch (e) { /* not persisted */ }
      syncToggle();
    });
  }
  if (mq && mq.addEventListener) mq.addEventListener("change", syncToggle);
  syncToggle();

  /* ---------- extra sign-in CTAs ----------
     app.js owns the one real handler on #btnGoogleSignIn. Every other CTA
     forwards to it, still inside the user's click, so the popup isn't blocked. */
  document.addEventListener("click", function (e) {
    var el = e.target.closest ? e.target.closest("[data-signin]") : null;
    if (!el) return;
    e.preventDefault();
    var real = document.getElementById("btnGoogleSignIn");
    if (real) real.click();
  });

  /* ---------- in-page anchors (smooth, header-aware) ---------- */
  document.addEventListener("click", function (e) {
    var a = e.target.closest ? e.target.closest('a[href^="#"]') : null;
    if (!a) return;
    var id = a.getAttribute("href").slice(1);
    if (id === "main") return; // skip-link: let the browser move focus
    var target = id && document.getElementById(id);
    if (id !== "top" && (!target || !target.offsetParent)) return;
    e.preventDefault();
    var y = id === "top" ? 0 : target.getBoundingClientRect().top + window.scrollY - 72;
    window.scrollTo({ top: Math.max(0, y), behavior: reduce ? "auto" : "smooth" });
  });

  /* ---------- header shadow once scrolled ---------- */
  var header = document.querySelector("header.top");
  function onScroll() { if (header) header.classList.toggle("scrolled", window.scrollY > 8); }
  window.addEventListener("scroll", onScroll, { passive: true });
  onScroll();

  /* ---------- how-it-works demo (accessible tabs + gentle autoplay) ---------- */
  var demo = document.querySelector("[data-demo]");
  if (demo) {
    var tabs = Array.prototype.slice.call(demo.querySelectorAll(".demo-tab"));
    var panels = Array.prototype.slice.call(demo.querySelectorAll(".demo-panel"));
    var idx = 0, timer = null, userTook = false, DWELL = 5200;

    function select(i, focus) {
      idx = (i + tabs.length) % tabs.length;
      tabs.forEach(function (t, n) {
        var on = n === idx;
        t.setAttribute("aria-selected", String(on));
        t.tabIndex = on ? 0 : -1;
        t.classList.remove("playing");
      });
      panels.forEach(function (p, n) {
        var on = n === idx;
        p.hidden = !on;
        p.classList.toggle("is-on", on);
      });
      if (focus) tabs[idx].focus();
      if (!userTook && !reduce) {
        void tabs[idx].offsetWidth; // restart progress bar animation
        tabs[idx].classList.add("playing");
      }
    }
    function play() {
      if (userTook || reduce) return;
      clearInterval(timer);
      timer = setInterval(function () { select(idx + 1); }, DWELL);
    }
    function stop() { userTook = true; clearInterval(timer); tabs.forEach(function (t) { t.classList.remove("playing"); }); }

    tabs.forEach(function (t, n) {
      t.addEventListener("click", function () { stop(); select(n); });
      t.addEventListener("keydown", function (e) {
        if (e.key === "ArrowRight" || e.key === "ArrowDown") { e.preventDefault(); stop(); select(idx + 1, true); }
        if (e.key === "ArrowLeft" || e.key === "ArrowUp") { e.preventDefault(); stop(); select(idx - 1, true); }
        if (e.key === "Home") { e.preventDefault(); stop(); select(0, true); }
        if (e.key === "End") { e.preventDefault(); stop(); select(tabs.length - 1, true); }
      });
    });

    // Only autoplay while the demo is on screen.
    if ("IntersectionObserver" in window) {
      new IntersectionObserver(function (entries) {
        entries.forEach(function (en) {
          if (en.isIntersecting) { select(idx); play(); } else clearInterval(timer);
        });
      }, { threshold: 0.35 }).observe(demo);
    }
  }

  /* ---------- scroll reveal ---------- */
  var reveals = document.querySelectorAll(".reveal");
  if (!reduce && "IntersectionObserver" in window) {
    root.classList.add("js-reveal");
    var io = new IntersectionObserver(function (entries) {
      entries.forEach(function (en) {
        if (en.isIntersecting) { en.target.classList.add("in"); io.unobserve(en.target); }
      });
    }, { rootMargin: "0px 0px -8% 0px", threshold: 0.08 });
    reveals.forEach(function (el) { io.observe(el); });
  }
})();

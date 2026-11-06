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
    toggle.addEventListener("click", function (e) {
      var next = currentTheme() === "dark" ? "light" : "dark";
      function apply() {
        root.setAttribute("data-theme", next);
        try { localStorage.setItem(KEY, next); } catch (err) { /* not persisted */ }
        syncToggle();
      }
      // Circular reveal from the toggle where the browser supports it.
      if (document.startViewTransition && !reduce) {
        var r = toggle.getBoundingClientRect();
        root.style.setProperty("--vtx", (r.left + r.width / 2) + "px");
        root.style.setProperty("--vty", (r.top + r.height / 2) + "px");
        document.startViewTransition(apply);
      } else apply();
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

  /* ================= "wow" layer ================= */
  var isLanding = function () { return !document.body.classList.contains("authed"); };
  var finePointer = window.matchMedia && window.matchMedia("(pointer: fine)").matches;

  /* scroll progress + sticky mobile CTA */
  var sticky = document.querySelector(".sticky-cta");
  var hero = document.querySelector(".lp-hero");
  var finalCta = document.querySelector(".final-cta");
  var ticking = false;
  function onScrollFx() {
    ticking = false;
    if (!isLanding()) return;
    var h = document.documentElement.scrollHeight - window.innerHeight;
    root.style.setProperty("--sp", h > 0 ? (window.scrollY / h).toFixed(4) : 0);
    if (sticky && hero) {
      var pastHero = hero.getBoundingClientRect().bottom < 0;
      var atEnd = finalCta && finalCta.getBoundingClientRect().top < window.innerHeight;
      var show = pastHero && !atEnd;
      sticky.classList.toggle("show", show);
      sticky.setAttribute("aria-hidden", String(!show));
      var b = sticky.querySelector("button"); if (b) b.tabIndex = show ? 0 : -1;
    }
  }
  window.addEventListener("scroll", function () { if (!ticking) { ticking = true; requestAnimationFrame(onScrollFx); } }, { passive: true });
  onScrollFx();

  if (!reduce) {
    /* pointer spotlight on cards */
    if (finePointer) {
      document.addEventListener("pointermove", function (e) {
        var el = e.target.closest ? e.target.closest("[data-spot]") : null;
        if (!el) return;
        var r = el.getBoundingClientRect();
        el.style.setProperty("--mx", (e.clientX - r.left) + "px");
        el.style.setProperty("--my", (e.clientY - r.top) + "px");
      }, { passive: true });

      /* hero: cursor glow + parallax tilt of the product visual */
      var tilt = document.querySelector("[data-tilt]");
      if (hero) {
        hero.addEventListener("pointermove", function (e) {
          var r = hero.getBoundingClientRect();
          hero.style.setProperty("--hx", (e.clientX - r.left) + "px");
          hero.style.setProperty("--hy", (e.clientY - r.top) + "px");
          hero.style.setProperty("--hs", "1");
          if (tilt) {
            var t = tilt.getBoundingClientRect();
            var tx = ((e.clientX - t.left) / t.width - 0.5) * 2;
            var ty = ((e.clientY - t.top) / t.height - 0.5) * 2;
            tilt.setAttribute("data-tilting", "");
            tilt.style.setProperty("--tx", Math.max(-1, Math.min(1, tx)).toFixed(3));
            tilt.style.setProperty("--ty", Math.max(-1, Math.min(1, ty)).toFixed(3));
          }
        }, { passive: true });
        hero.addEventListener("pointerleave", function () {
          hero.style.setProperty("--hs", "0");
          if (tilt) { tilt.style.setProperty("--tx", 0); tilt.style.setProperty("--ty", 0); }
        });
      }
    }

    /* typing loop for the email subject in the hero */
    var typed = document.querySelector(".typed[data-type]");
    if (typed) {
      var full = typed.getAttribute("data-type"), i = 0;
      typed.textContent = "";
      (function type() {
        if (!isLanding()) return;
        if (i <= full.length) { typed.textContent = full.slice(0, i++); setTimeout(type, 45 + Math.random() * 50); }
        else setTimeout(function () { i = 0; type(); }, 4200);
      })();
    }

    /* count-up numbers */
    var counters = document.querySelectorAll("[data-count]");
    if ("IntersectionObserver" in window) {
      var cio = new IntersectionObserver(function (entries) {
        entries.forEach(function (en) {
          if (!en.isIntersecting) return;
          cio.unobserve(en.target);
          var el = en.target, to = +el.getAttribute("data-count"), from = +(el.getAttribute("data-from") || 0);
          var t0 = performance.now(), dur = 1400;
          (function step(now) {
            var k = Math.min(1, (now - t0) / dur), e = 1 - Math.pow(1 - k, 4);
            el.textContent = Math.round(from + (to - from) * e);
            if (k < 1) requestAnimationFrame(step);
          })(t0);
        });
      }, { threshold: 0.6 });
      counters.forEach(function (c) { cio.observe(c); });
    }
  }

  /* tailoring demo: master <-> tailored with a FLIP reorder of the bullets */
  var tailor = document.querySelector("[data-tailor]");
  if (tailor) {
    var list = tailor.querySelector(".tailor-list");
    var items = Array.prototype.slice.call(list.children);
    var btns = Array.prototype.slice.call(tailor.querySelectorAll("[data-set]"));
    var auto = null, touched = false;
    function setState(state) {
      if (tailor.getAttribute("data-state") === state) return;
      var first = items.map(function (li) { return li.getBoundingClientRect().top; });
      tailor.setAttribute("data-state", state);
      btns.forEach(function (b) { b.setAttribute("aria-pressed", String(b.getAttribute("data-set") === state)); });
      var key = state === "after" ? "data-a" : "data-b";
      items.slice().sort(function (x, y) { return x.getAttribute(key) - y.getAttribute(key); })
        .forEach(function (li) { list.appendChild(li); });
      if (reduce) return;
      items.forEach(function (li, n) {
        var dy = first[n] - li.getBoundingClientRect().top;
        if (!dy) return;
        li.animate([{ transform: "translateY(" + dy + "px)" }, { transform: "none" }],
          { duration: 650, easing: "cubic-bezier(.16,1,.3,1)" });
      });
    }
    btns.forEach(function (b) {
      b.addEventListener("click", function () { touched = true; clearInterval(auto); setState(b.getAttribute("data-set")); });
    });
    if ("IntersectionObserver" in window && !reduce) {
      new IntersectionObserver(function (entries) {
        clearInterval(auto);
        if (entries[0].isIntersecting && !touched) {
          setTimeout(function () { if (!touched) setState("after"); }, 900);
          auto = setInterval(function () {
            if (touched) return clearInterval(auto);
            setState(tailor.getAttribute("data-state") === "after" ? "before" : "after");
          }, 4200);
        }
      }, { threshold: 0.45 }).observe(tailor);
    }
  }
})();

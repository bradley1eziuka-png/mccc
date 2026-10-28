/* Monroe It’s Time To Run — interactions. No dependencies. */
(() => {
  const root = document.documentElement;
  root.classList.add("js");
  const reduce = window.matchMedia("(prefers-reduced-motion: reduce)").matches;

  /* header state */
  const header = document.querySelector(".site-header");
  const onScroll = () => header && header.classList.toggle("is-scrolled", window.scrollY > 24);
  onScroll();
  window.addEventListener("scroll", onScroll, { passive: true });

  /* mobile menu */
  const toggle = document.querySelector(".menu-toggle");
  const menu = document.getElementById("mobile-menu");
  if (toggle && menu) {
    const setMenu = (open) => {
      toggle.setAttribute("aria-expanded", String(open));
      toggle.setAttribute("aria-label", open ? "Close menu" : "Open menu");
      menu.classList.toggle("is-open", open);
      header.classList.toggle("is-open", open);
      document.body.style.overflow = open ? "hidden" : "";
      if (open) menu.querySelector("a").focus();
    };
    toggle.addEventListener("click", () => setMenu(toggle.getAttribute("aria-expanded") !== "true"));
    menu.addEventListener("click", (e) => { if (e.target.closest("a")) setMenu(false); });
    document.addEventListener("keydown", (e) => {
      if (e.key === "Escape" && menu.classList.contains("is-open")) { setMenu(false); toggle.focus(); }
    });
    window.matchMedia("(min-width: 980px)").addEventListener("change", (m) => m.matches && setMenu(false));
  }

  /* scroll reveal */
  const revealEls = document.querySelectorAll(".reveal, .clip, .rule-draw, .bar-row");
  if ("IntersectionObserver" in window && !reduce) {
    const io = new IntersectionObserver((entries) => {
      entries.forEach((en) => { if (en.isIntersecting) { en.target.classList.add("is-in"); io.unobserve(en.target); } });
    }, { threshold: 0.15, rootMargin: "0px 0px -6% 0px" });
    revealEls.forEach((el) => io.observe(el));
  } else {
    revealEls.forEach((el) => el.classList.add("is-in"));
  }

  /* count-up numbers */
  const counters = document.querySelectorAll("[data-count]");
  const runCount = (el) => {
    const end = Number(el.dataset.count);
    if (reduce) { el.textContent = end; return; }
    const dur = 1400, t0 = performance.now();
    const tick = (t) => {
      const p = Math.min((t - t0) / dur, 1);
      el.textContent = Math.round(end * (1 - Math.pow(1 - p, 3)));
      if (p < 1) requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  };
  if ("IntersectionObserver" in window) {
    const co = new IntersectionObserver((entries) => {
      entries.forEach((en) => { if (en.isIntersecting) { runCount(en.target); co.unobserve(en.target); } });
    }, { threshold: 0.6 });
    counters.forEach((c) => co.observe(c));
  }

  /* FAQ accordion */
  document.querySelectorAll(".faq-q").forEach((btn) => {
    btn.addEventListener("click", () => {
      const open = btn.getAttribute("aria-expanded") === "true";
      btn.setAttribute("aria-expanded", String(!open));
      document.getElementById(btn.getAttribute("aria-controls")).hidden = open;
    });
  });

  /* mobile sticky registration bar: show after hero, hide while the register section is on screen */
  const sticky = document.querySelector(".sticky-cta");
  if (sticky && "IntersectionObserver" in window) {
    document.body.classList.add("has-sticky");
    const state = { past: false, regVisible: false };
    const update = () => sticky.classList.toggle("is-visible", state.past && !state.regVisible);
    const anchor = document.querySelector("[data-sticky-after]");
    const reg = document.querySelector("[data-sticky-hide]");
    if (anchor) new IntersectionObserver(([e]) => { state.past = !e.isIntersecting && e.boundingClientRect.top < 0; update(); }).observe(anchor);
    else { state.past = true; }
    if (reg) new IntersectionObserver(([e]) => { state.regVisible = e.isIntersecting; update(); }).observe(reg);
    update();
  }


  /* hero background video: attach source only when appropriate; the poster image is the fallback */
  const hv = document.querySelector(".hero-video");
  if (hv) {
    const saver = navigator.connection && navigator.connection.saveData;
    if (!reduce && !saver) {
      hv.muted = true;
      hv.src = window.matchMedia("(max-width: 760px)").matches ? hv.dataset.srcSm : hv.dataset.src;
      hv.addEventListener("playing", () => hv.classList.add("is-on"), { once: true });
      hv.play().catch(() => {});
      if ("IntersectionObserver" in window) {
        new IntersectionObserver(([e]) => { e.isIntersecting ? hv.play().catch(() => {}) : hv.pause(); }).observe(hv);
      }
    }
  }

  /* click-to-play video players (audio allowed, never autoplays) */
  const players = document.querySelectorAll("[data-video]");
  players.forEach((box) => {
    const v = box.querySelector("video");
    const start = () => {
      players.forEach((o) => { const ov = o.querySelector("video"); if (o !== box && !ov.paused) ov.pause(); });
      v.controls = true;
      v.preload = "auto";
      v.play().catch(() => {});
    };
    box.addEventListener("click", (e) => { if (!box.classList.contains("is-playing") && !e.target.closest("video")) start(); });
    v.addEventListener("play", () => box.classList.add("is-playing"));
    v.addEventListener("ended", () => { box.classList.remove("is-playing"); v.controls = false; v.currentTime = 0; });
  });


  /* testimonials: full text always in the DOM; CSS clamps it, the button reveals the rest */
  const tcards = document.querySelectorAll(".tcard");
  const fitCards = () => tcards.forEach((card) => {
    const text = card.querySelector(".tcard__text");
    const btn = card.querySelector(".tcard__toggle");
    if (card.classList.contains("is-open")) return;
    btn.hidden = text.scrollHeight <= text.clientHeight + 1;
  });
  tcards.forEach((card) => {
    const btn = card.querySelector(".tcard__toggle");
    btn.addEventListener("click", () => {
      const open = card.classList.toggle("is-open");
      btn.setAttribute("aria-expanded", String(open));
      btn.textContent = open ? "Show less" : "Read full testimonial";
    });
  });
  if (tcards.length) { fitCards(); window.addEventListener("resize", fitCards); window.addEventListener("load", () => { fitCards(); setTimeout(fitCards, 800); }); if (document.fonts) document.fonts.ready.then(fitCards); }


  /* testimonials carousel: phones only (max-width 760px). One card at a time, auto-advances, arrows + pause + swipe. */
  const voices = document.querySelector(".voices");
  if (voices) {
    const DWELL = 2500; // ms each card stays before sliding to the next
    const track = voices.querySelector(".voices__grid");
    const cards = [...track.children];
    const viewport = voices.querySelector(".voices__viewport");
    const count = voices.querySelector(".vc-count");
    const pauseBtn = voices.querySelector(".vc-pause");
    const mq = window.matchMedia("(max-width: 760px)");
    let i = 0, timer = null, playing = !reduce, onScreen = true, active = false;
    const anyOpen = () => cards.some((c) => c.classList.contains("is-open"));
    const stop = () => { clearInterval(timer); timer = null; };
    const start = () => { stop(); if (active && playing && onScreen && !anyOpen()) timer = setInterval(() => go(i + 1), DWELL); };
    const collapseAll = () => cards.forEach((c) => {
      if (!c.classList.contains("is-open")) return;
      c.classList.remove("is-open");
      const b = c.querySelector(".tcard__toggle");
      b.setAttribute("aria-expanded", "false"); b.textContent = "Read full testimonial";
    });
    const go = (n) => {
      collapseAll();
      i = (n + cards.length) % cards.length;
      track.style.setProperty("--i", i);
      cards.forEach((c, k) => { c.inert = k !== i; c.setAttribute("aria-hidden", k === i ? "false" : "true"); });
      count.textContent = (i + 1) + " / " + cards.length;
      fitCards();
    };
    const paintPause = () => {
      pauseBtn.dataset.paused = String(!playing);
      pauseBtn.setAttribute("aria-label", playing ? "Pause automatic rotation" : "Start automatic rotation");
      track.setAttribute("aria-live", playing ? "off" : "polite");
    };
    const activate = () => {
      active = true; voices.classList.add("voices--carousel");
      cards.forEach((c, k) => { c.setAttribute("role", "group"); c.setAttribute("aria-roledescription", "slide"); c.setAttribute("aria-label", (k + 1) + " of " + cards.length); });
      viewport.setAttribute("aria-roledescription", "carousel");
      paintPause(); go(i); start();
    };
    const deactivate = () => {
      active = false; stop(); voices.classList.remove("voices--carousel");
      track.style.removeProperty("--i"); track.removeAttribute("aria-live");
      viewport.removeAttribute("aria-roledescription");
      cards.forEach((c) => { c.inert = false; ["aria-hidden", "role", "aria-roledescription", "aria-label"].forEach((a) => c.removeAttribute(a)); });
      fitCards();
    };
    voices.querySelector(".vc-prev").addEventListener("click", () => { go(i - 1); start(); });
    voices.querySelector(".vc-next").addEventListener("click", () => { go(i + 1); start(); });
    pauseBtn.addEventListener("click", () => { playing = !playing; paintPause(); start(); });
    // expanding a card holds the carousel on it; collapsing resumes
    voices.addEventListener("click", (e) => { if (e.target.closest(".tcard__toggle")) setTimeout(start, 0); });
    // swipe
    let x0 = null;
    viewport.addEventListener("touchstart", (e) => { x0 = e.touches[0].clientX; stop(); }, { passive: true });
    viewport.addEventListener("touchend", (e) => {
      if (x0 !== null) { const dx = e.changedTouches[0].clientX - x0; if (Math.abs(dx) > 50) go(i + (dx < 0 ? 1 : -1)); }
      x0 = null; start();
    });
    voices.addEventListener("focusin", stop);
    voices.addEventListener("focusout", start);
    if ("IntersectionObserver" in window) new IntersectionObserver(([e]) => { onScreen = e.isIntersecting; start(); }, { threshold: 0.3 }).observe(voices);
    const sync = () => (mq.matches ? activate() : deactivate());
    mq.addEventListener("change", sync);
    sync();
  }

  /* gallery filters */
  const filterBtns = document.querySelectorAll(".filters button");
  if (filterBtns.length) {
    const items = document.querySelectorAll("[data-cat]");
    filterBtns.forEach((b) => b.addEventListener("click", () => {
      filterBtns.forEach((x) => x.setAttribute("aria-pressed", String(x === b)));
      const cat = b.dataset.filter;
      items.forEach((i) => { i.hidden = cat !== "all" && i.dataset.cat !== cat; });
    }));
  }

  const y = document.getElementById("year");
  if (y) y.textContent = new Date().getFullYear();
})();

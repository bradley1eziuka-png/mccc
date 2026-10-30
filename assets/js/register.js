/* Registration flow: 4 steps -> save to /api/register -> PayPal. No dependencies.
 * Privacy: form data is only ever sent to our own /api/register over POST. It is never put in a URL,
 * logged, stored in the browser, or sent to analytics. */
(() => {
  const form = document.getElementById("reg-form");
  if (!form) return;
  const cfg = window.SITE_CONFIG || {};
  const open = cfg.registrationOpen === true;
  const steps = [...form.querySelectorAll(".rstep")];
  const prog = [...document.querySelectorAll(".rprog li")];
  const back = form.querySelector("[data-back]");
  const next = form.querySelector("[data-next]");
  const submit = form.querySelector("[data-submit]");
  const status = document.getElementById("form-status");
  const notice = document.getElementById("reg-notice");
  const payPanel = document.getElementById("pay-panel");
  const $ = (n) => form.elements[n];
  let cur = 0;

  if (open) notice.hidden = true;
  document.documentElement.classList.add("reg-steps");

  /* ---------- helpers ---------- */
  const val = (n) => ($(n) && $(n).value ? $(n).value.trim() : "");
  const digits = (s) => s.replace(/\D/g, "");
  const norm = (s) => s.toLowerCase().replace(/\s+/g, " ").trim();
  const fmtDate = (iso) => (iso ? new Date(iso + "T00:00:00Z").toLocaleDateString("en-US", { timeZone: "UTC", year: "numeric", month: "long", day: "numeric" }) : "");
  const expLabel = { new: "New to running", some: "Some experience", experienced: "Experienced" };
  const today = new Date().toLocaleDateString("en-US", { year: "numeric", month: "long", day: "numeric" });
  $("signed_date_display").value = today;

  /* ---------- validation ---------- */
  const labelOf = (el) => { const l = form.querySelector('label[for="' + el.id + '"]'); return l ? l.textContent.trim() : "This field"; };
  function problem(el) {
    if (el.type === "radio") return form.querySelector('input[name="' + el.name + '"]:checked') ? "" : "Choose one option.";
    if (el.type === "checkbox") return el.checked ? "" : "Check this box to confirm before you sign.";
    if (el.validity.valueMissing) return el.tagName === "SELECT" ? "Select an option." : "Enter " + labelOf(el).toLowerCase() + ".";
    if (el.type === "email" && !/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(el.value)) return "Enter a valid email address, like name@example.com.";
    if (el.hasAttribute("data-phone") && digits(el.value).length < 10) return "Enter a phone number with area code.";
    if (el.type === "date") {
      const t = Date.parse(el.value + "T00:00:00Z");
      if (Number.isNaN(t) || t > Date.now() || new Date(t).getUTCFullYear() < 2000) return "Enter a valid date of birth.";
    }
    if (el.name === "signature_typed" && norm(el.value) !== norm(val("parent"))) return "Your signature must match the parent/legal guardian name you entered (" + val("parent") + ").";
    return "";
  }
  function setError(el, msg) {
    const host = el.type === "radio" ? el.closest("fieldset") : el.closest(".field") || el.closest(".check");
    let err = host.querySelector(":scope > .field__error");
    if (msg) {
      if (!err) { err = document.createElement("p"); err.className = "field__error"; err.id = (el.id || el.name) + "-err"; host.appendChild(err); }
      err.textContent = msg; el.setAttribute("aria-invalid", "true"); el.setAttribute("aria-describedby", err.id);
    } else {
      if (err) err.remove();
      el.removeAttribute("aria-invalid"); el.removeAttribute("aria-describedby");
    }
  }
  function validateStep(i) {
    let first = null;
    const seen = new Set();
    steps[i].querySelectorAll("input[required],select[required],textarea[required]").forEach((el) => {
      if (el.type === "radio") { if (seen.has(el.name)) return; seen.add(el.name); }
      const msg = problem(el);
      setError(el, msg);
      if (msg && !first) first = el;
    });
    if (first) { first.focus({ preventScroll: false }); }
    return !first;
  }
  form.addEventListener("input", (e) => { if (e.target.getAttribute && e.target.getAttribute("aria-invalid")) setError(e.target, problem(e.target)); });
  form.addEventListener("change", (e) => { if (e.target.getAttribute && e.target.getAttribute("aria-invalid")) setError(e.target, problem(e.target)); });

  /* ---------- waiver auto-fill + review ---------- */
  function fillWaiver() {
    const map = {
      athlete_name: (val("athlete_first") + " " + val("athlete_last")).trim(),
      dob: fmtDate(val("dob")),
      parent: val("parent"), phone: val("phone"), email: val("email"),
      emergency: val("emergency_name") + " — " + val("emergency_phone"),
      medical: val("medical"),
    };
    form.querySelectorAll("[data-fill]").forEach((d) => { d.textContent = map[d.dataset.fill] || ""; });
  }
  function fillReview() {
    const rows = [
      ["Athlete", (val("athlete_first") + " " + val("athlete_last")).trim()], ["Date of birth", fmtDate(val("dob"))],
      ["Grade entering", val("grade")], ["School", val("school")],
      ["Running experience", expLabel[(form.querySelector('input[name="level"]:checked') || {}).value] || ""], ["T-shirt size", val("tshirt_size")],
      ["Parent / legal guardian", val("parent")], ["Email", val("email")], ["Phone", val("phone")],
      ["Emergency contact", val("emergency_name") + " — " + val("emergency_phone")], ["Medical / emergency information", val("medical")],
      ["Waiver signed by", val("signature_typed")], ["Date", today],
    ];
    const dl = document.getElementById("review");
    dl.textContent = "";
    rows.forEach(([k, v]) => { const d = document.createElement("div"), dt = document.createElement("dt"), dd = document.createElement("dd"); dt.textContent = k; dd.textContent = v; d.append(dt, dd); dl.appendChild(d); });
  }

  /* ---------- step navigation ---------- */
  function show(n, focus) {
    cur = n;
    steps.forEach((s, k) => { s.hidden = k !== n; });
    prog.forEach((li, k) => { li.classList.toggle("is-current", k === n); li.classList.toggle("is-done", k < n); if (k === n) li.setAttribute("aria-current", "step"); else li.removeAttribute("aria-current"); });
    back.hidden = n === 0; next.hidden = n === steps.length - 1; submit.hidden = n !== steps.length - 1;
    if (n >= 2) fillWaiver();
    if (n === 3) fillReview();
    submit.disabled = !open;
    if (n === 3 && !open) { setStatus("Online registration is not open yet, so this step cannot be completed. Nothing was sent or saved."); } else setStatus("");
    if (focus) { const t = document.querySelector(".rprog"); t.scrollIntoView({ block: "start", behavior: matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth" }); const lg = steps[n].querySelector("legend"); lg.setAttribute("tabindex", "-1"); (steps[n].querySelector("input,select,textarea") || lg).focus({ preventScroll: true }); }
  }
  function setStatus(msg) { status.hidden = !msg; status.textContent = msg || ""; }
  next.addEventListener("click", () => { if (validateStep(cur)) show(cur + 1, true); });
  back.addEventListener("click", () => show(cur - 1, true));
  form.addEventListener("keydown", (e) => { if (e.key === "Enter" && e.target.tagName === "INPUT" && cur < steps.length - 1) { e.preventDefault(); next.click(); } });
  show(0, false);

  /* ---------- drawn signature (optional) ---------- */
  const cv = document.getElementById("sig-canvas"), ctx = cv.getContext("2d");
  let drawing = false, drawn = false;
  const scale = window.devicePixelRatio || 1;
  const sizeCanvas = () => { const w = cv.clientWidth || 600; cv.width = w * scale; cv.height = 150 * scale; ctx.scale(scale, scale); ctx.lineWidth = 2.2; ctx.lineCap = "round"; ctx.strokeStyle = "#101010"; };
  sizeCanvas();
  const pt = (e) => { const r = cv.getBoundingClientRect(); return [e.clientX - r.left, e.clientY - r.top]; };
  cv.addEventListener("pointerdown", (e) => { drawing = true; cv.setPointerCapture(e.pointerId); const [x, y] = pt(e); ctx.beginPath(); ctx.moveTo(x, y); e.preventDefault(); });
  cv.addEventListener("pointermove", (e) => { if (!drawing) return; const [x, y] = pt(e); ctx.lineTo(x, y); ctx.stroke(); drawn = true; });
  ["pointerup", "pointercancel"].forEach((t) => cv.addEventListener(t, () => { drawing = false; }));
  document.getElementById("sig-clear").addEventListener("click", () => { ctx.clearRect(0, 0, cv.width, cv.height); drawn = false; });

  /* ---------- submit ---------- */
  async function waiverHash() {
    const text = [...document.querySelectorAll("[data-wp]")].map((el) => el.textContent.trim()).join("\n\n");
    const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
    return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");
  }
  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    if (!validateStep(cur)) return;
    for (let i = 0; i < steps.length - 1; i++) if (!validateStep(i)) { show(i, true); return; }
    if (!open) { setStatus("Online registration is not open yet. Nothing was sent or saved."); return; }
    submit.disabled = true; submit.textContent = "Saving…";
    try {
      const payload = {
        website: val("website"),
        athlete_first: val("athlete_first"), athlete_last: val("athlete_last"), dob: val("dob"), grade: val("grade"), school: val("school"),
        tshirt_size: val("tshirt_size"), level: (form.querySelector('input[name="level"]:checked') || {}).value || "",
        parent: val("parent"), email: val("email"), phone: val("phone"),
        emergency_name: val("emergency_name"), emergency_phone: val("emergency_phone"), medical: val("medical"),
        agree: $("agree").checked, signature_typed: val("signature_typed"), signed_date_display: today,
        signature_image: drawn ? cv.toDataURL("image/png") : "",
        waiver_version: document.querySelector("[data-waiver-version]").dataset.waiverVersion, waiver_sha256: await waiverHash(),
      };
      const res = await fetch(cfg.apiUrl, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(payload), credentials: "same-origin" });
      const data = await res.json().catch(() => ({}));
      if (res.ok && data.ok) {
        document.getElementById("pay-ref").textContent = data.reference;
        document.getElementById("pay-email").textContent = val("email");
        document.getElementById("pay-link").href = cfg.paypalUrl;
        form.hidden = true; document.querySelector(".rprog").hidden = true; payPanel.hidden = false; payPanel.focus(); payPanel.scrollIntoView({ block: "start" });
        return;
      }
      if (res.status === 409 && data.error === "already_registered") {
        setStatus("We already have a registration for this athlete and email (reference " + data.reference + "), and it has different details than what you just entered. Your new answers were NOT saved. Please email MonroeJiuJitsu11@gmail.com with your reference so Todd can withdraw the old registration, then submit this form again.");
      }
      else if (res.status === 400 && data.fields) { setStatus(Object.values(data.fields).join(" ")); }
      else if (res.status === 413) setStatus("That submission is too large. Remove the drawn signature or shorten your answers and try again.");
      else if (res.status === 429) setStatus("Too many attempts. Please wait a few minutes and try again.");
      else if (res.status === 503) setStatus("Registration is temporarily unavailable. Please email MonroeJiuJitsu11@gmail.com.");
      else setStatus("We could not save your registration. Nothing was charged. Please try again, or email MonroeJiuJitsu11@gmail.com.");
    } catch (_) {
      setStatus("We could not reach the server. Nothing was saved or charged. Please check your connection and try again.");
    }
    submit.disabled = false; submit.innerHTML = 'Save registration &amp; continue to PayPal <span class="arr" aria-hidden="true">→</span>';
  });
})();

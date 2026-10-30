/* Private back-office. The token lives only in memory for this tab. All data is rendered with textContent. */
(() => {
  let token = "";
  const $ = (id) => document.getElementById(id);
  const el = (tag, attrs, ...kids) => { const n = document.createElement(tag); Object.entries(attrs || {}).forEach(([k, v]) => (k === "class" ? (n.className = v) : n.setAttribute(k, v))); kids.forEach((k) => n.append(k)); return n; };
  const api = (path, opts) => fetch("/api/admin" + path, { ...opts, headers: { Authorization: "Bearer " + token, "Content-Type": "application/json" }, cache: "no-store" });
  const when = (iso) => (iso ? new Date(iso).toLocaleString("en-US", { dateStyle: "medium", timeStyle: "short" }) : "");

  const markTest = (isTest, env) => {
    const b = $("testbanner");
    b.hidden = !isTest;
    if (isTest) { b.textContent = "TEST MODE · " + (env || "non-production") + " · test data only · not real registrations"; document.title = "[TEST] Registrations (private)"; }
  };
  // Which environment is this? (public, data-free) so TEST MODE shows even before login.
  fetch("/api/admin?mode=1", { cache: "no-store" }).then((r) => r.json()).then((m) => markTest(m.testMode, m.environment)).catch(() => {});

  async function load() {
    const r = await api("");
    if (r.status === 401) { $("msg").textContent = "Wrong token."; return false; }
    if (r.status === 503) { $("msg").textContent = "Registration storage is not set up yet (see REGISTRATION-SETUP.md)."; return false; }
    if (!r.ok) { $("msg").textContent = "Could not load registrations."; return false; }
    const { registrations, testMode, environment } = await r.json();
    markTest(testMode, environment);
    $("msg").textContent = ""; $("login").hidden = true; $("app").hidden = false;
    $("count").textContent = registrations.length + " registration" + (registrations.length === 1 ? "" : "s") + " · " + registrations.filter((x) => x.status === "paid").length + " paid" + (registrations.some((x) => x.status === "unreadable") ? " · " + registrations.filter((x) => x.status === "unreadable").length + " UNREADABLE" : "");
    const body = $("rows"); body.textContent = "";
    registrations.forEach((x) => {
      const tr = el("tr");
      if (x.status === "unreadable") {
        tr.append(el("td", {}, x.reference), el("td", { colspan: "7" }, "⚠ This registration could not be read: " + (x.paymentNote || "unknown problem") + " The other registrations are unaffected."), el("td", {}, el("span", { class: "pill pill--bad" }, "Unreadable")), el("td", {}));
        body.append(tr);
        return;
      }
      const label = x.status === "paid" ? "Paid" : x.status === "superseded" ? "Withdrawn" : "Awaiting payment";
      const cls = x.status === "paid" ? "pill--paid" : x.status === "superseded" ? "pill--super" : "pill--pending";
      tr.append(el("td", {}, x.reference), el("td", {}, x.athleteFirst + " " + x.athleteLast), el("td", {}, x.gradeEntering), el("td", {}, x.parent),
        el("td", {}, x.email + "\n" + x.phone), el("td", {}, x.tshirtSize), el("td", {}, when(x.createdAt)),
        el("td", {}, el("span", { class: "pill " + cls }, label)));
      const view = el("button", { class: "sm", type: "button" }, "View / waiver");
      view.onclick = () => showDetail(x.reference);
      const actions = el("td", {}, view);
      if (x.status !== "superseded") {
        const pay = el("button", { class: "sm", type: "button" }, x.status === "paid" ? "Mark unpaid" : "Mark paid");
        pay.onclick = () => togglePaid(x);
        actions.append(" ", pay);
      }
      if (x.status === "pending_payment") {
        const wd = el("button", { class: "sm", type: "button" }, "Withdraw (allow re-submit)");
        wd.onclick = () => withdraw(x);
        actions.append(" ", wd);
      }
      tr.append(actions);
      body.append(tr);
    });
    return true;
  }
  async function withdraw(x) {
    if (!confirm("Withdraw " + x.reference + " (" + x.athleteFirst + " " + x.athleteLast + ")?\n\nUse this only so the parent can submit corrected details. The old signed record is kept, marked Withdrawn. Paid registrations cannot be withdrawn.")) return;
    const r = await api("", { method: "POST", body: JSON.stringify({ reference: x.reference, action: "supersede" }) });
    if (!r.ok) { alert("Could not withdraw this registration."); return; }
    load();
  }
  async function togglePaid(x) {
    if (x.status === "paid") { if (!confirm("Mark " + x.reference + " as NOT paid?")) return; }
    const txn = x.status === "paid" ? "" : prompt("PayPal transaction ID (from your PayPal activity) for " + x.athleteFirst + " " + x.athleteLast + ":", "");
    if (txn === null) return;
    const r = await api("", { method: "POST", body: JSON.stringify({ reference: x.reference, action: x.status === "paid" ? "markUnpaid" : "markPaid", transactionId: txn || "" }) });
    if (!r.ok) { alert("Could not update."); return; }
    load();
  }
  async function showDetail(ref) {
    const r = await api("?ref=" + encodeURIComponent(ref));
    if (r.status === 422) { alert("This registration could not be read (corrupted or tampered). The other registrations are unaffected."); return; }
    if (!r.ok) return;
    const { record: g } = await r.json();
    if (g.payment && g.payment.status === "superseded") { /* shown with a notice below */ }
    const box = $("detail"); box.hidden = false; box.textContent = "";
    const dl = (rows) => { const d = el("dl"); rows.forEach(([k, v]) => d.append(el("dt", {}, k), el("dd", {}, v == null ? "" : String(v)))); return d; };
    box.append(el("h2", { class: "display" }, g.reference + " — " + g.athlete.firstName + " " + g.athlete.lastName));
    box.append(dl([["Status", g.payment.status === "paid" ? "Paid " + when(g.payment.paidAt) + (g.payment.transactionId ? " · PayPal txn " + g.payment.transactionId : "") : g.payment.status === "superseded" ? "WITHDRAWN " + when(g.payment.supersededAt) + " (replaced by a corrected submission)" : "Awaiting payment"],
      ["Registered", when(g.createdAt)], ["Date of birth", g.athlete.dob], ["Grade entering", g.athlete.gradeEntering], ["School", g.athlete.school], ["Experience", g.athlete.experience], ["T-shirt size", g.athlete.tshirtSize],
      ["Parent / guardian", g.parent.fullName], ["Email", g.parent.email], ["Phone", g.parent.phone],
      ["Emergency contact", g.emergency.contactName + " — " + g.emergency.contactPhone], ["Medical / emergency info", g.emergency.medical]]));
    const wv = el("div", { class: "wv" });
    wv.append(el("h2", { class: "display" }, "Signed waiver record"));
    wv.append(dl([["Waiver version", g.waiver.version], ["Text fingerprint (SHA-256)", g.waiver.sha256], ["Agreement accepted", g.waiver.accepted ? "Yes" : "No"],
      ["Typed signature", g.waiver.typedSignature], ["Signed (server time)", when(g.waiver.signedAt)], ["Date shown to signer", g.waiver.signedDateShown], ["IP address", g.waiver.ip], ["Browser", g.waiver.userAgent]]));
    if (g.waiver.drawnSignaturePng) { wv.append(el("p", { class: "muted" }, "Drawn signature:")); wv.append(el("img", { class: "sigimg", alt: "Drawn signature", src: g.waiver.drawnSignaturePng })); }
    box.append(wv);
    try {
      const t = await (await fetch("assets/data/waiver-" + g.waiver.version + ".json")).json();
      const full = el("div", { class: "wv" }); full.append(el("h2", { class: "display" }, "Waiver text as shown (" + t.version + ")"));
      t.parts.forEach(([k, txt]) => full.append(el("p", { style: k === "title" || k === "h" || k === "infoh" ? "font-weight:700" : "" }, txt)));
      box.append(full);
    } catch (_) { box.append(el("p", { class: "muted" }, "Waiver text file for this version was not found.")); }
    const pr = el("button", { class: "btn btn--dark noprint", type: "button" }, "Print / save as PDF"); pr.onclick = () => window.print(); box.append(pr);
    box.scrollIntoView({ behavior: "smooth", block: "start" });
  }
  $("login").addEventListener("submit", async (e) => { e.preventDefault(); token = $("tok").value.trim(); $("tok").value = ""; if (!(await load())) token = ""; });
  $("refresh").onclick = load;
  $("csv").onclick = async () => {
    const r = await api("?format=csv"); if (!r.ok) return;
    const a = el("a", { href: URL.createObjectURL(await r.blob()), download: "registrations.csv" }); document.body.append(a); a.click(); a.remove();
  };
})();

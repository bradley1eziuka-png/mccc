"use strict";
/*
 * /api/admin — Todd's back office. Every request needs  Authorization: Bearer <ADMIN_TOKEN>.
 *   GET  /api/admin                  list registrations (summary, no signature images)
 *   GET  /api/admin?ref=ITR-XXXXXX   one full record (includes the signed-waiver record)
 *   GET  /api/admin?format=csv       CSV download of the summary list
 *   POST /api/admin {reference, action: "markPaid" | "markUnpaid" | "supersede", transactionId?, note?}
 *        supersede = withdraw an UNPAID registration so the parent can resubmit corrected details (the old signed record is kept).
 * A registration is only "paid" after a person records it here. A PayPal redirect never marks anything paid.
 */
const S = require("./_lib/store");

const csvCell = (v) => {
  let s = v == null ? "" : String(v);
  if (/^[=+\-@\t\r]/.test(s)) s = "'" + s; // neutralise spreadsheet formula injection
  return '"' + s.replace(/"/g, '""') + '"';
};

function summary(r) {
  return {
    reference: r.reference,
    environment: r.environment || "production",
    createdAt: r.createdAt,
    status: r.payment && r.payment.status === "paid" ? "paid" : r.payment && r.payment.status === "superseded" ? "superseded" : "pending_payment",
    athleteFirst: r.athlete.firstName,
    athleteLast: r.athlete.lastName,
    dob: r.athlete.dob,
    gradeEntering: r.athlete.gradeEntering,
    school: r.athlete.school,
    experience: r.athlete.experience,
    tshirtSize: r.athlete.tshirtSize,
    parent: r.parent.fullName,
    email: r.parent.email,
    phone: r.parent.phone,
    emergencyName: r.emergency.contactName,
    emergencyPhone: r.emergency.contactPhone,
    medical: r.emergency.medical,
    waiverVersion: r.waiver.version,
    signedBy: r.waiver.typedSignature,
    signedAt: r.waiver.signedAt,
    paidAt: (r.payment && r.payment.paidAt) || "",
    transactionId: (r.payment && r.payment.transactionId) || "",
    paymentNote: (r.payment && r.payment.note) || "",
  };
}
const COLUMNS = Object.keys(summary({ reference: "", athlete: {}, parent: {}, emergency: {}, waiver: {}, payment: {} }));
/** Placeholder row for a registration that exists in the index but cannot be read. It never blocks the other registrations. */
function unreadable(ref, why) {
  const row = {};
  COLUMNS.forEach((k) => (row[k] = ""));
  row.reference = ref;
  row.status = "unreadable";
  row.paymentNote = why;
  return row;
}

async function load(ref) {
  const [raw] = await S.pipeline([["GET", S.key("reg:" + ref)]]);
  return raw ? S.decrypt(raw) : null;
}

module.exports = async function handler(req, res) {
  try {
    // Public, data-free: tells the admin page which environment it is talking to so it can show TEST MODE.
    if (req.method === "GET" && new URL(req.url, "http://x").searchParams.has("mode")) {
      return S.send(res, 200, { testMode: !S.isProduction(), environment: S.environmentName() });
    }
    if (!S.configured() || !S.env().admin) return S.send(res, 503, { error: "admin_unavailable" });
    if (await S.limited("admin", S.clientIp(req), 40, 600)) return S.send(res, 429, { error: "too_many_requests" });
    if (!S.adminOk(req)) return S.send(res, 401, { error: "unauthorized" });

    const url = new URL(req.url, "http://x");
    if (req.method === "GET") {
      const ref = url.searchParams.get("ref");
      if (ref) {
        if (!/^(ITR|TST)-[A-Z0-9]{6}$/.test(ref)) return S.send(res, 400, { error: "bad_reference" });
        let r;
        try { r = await load(ref); } catch (_) { return S.send(res, 422, { error: "record_unreadable" }); } // corrupted or tampered; other records are unaffected
        return r ? S.send(res, 200, { record: r }) : S.send(res, 404, { error: "not_found" });
      }
      const refs = (await S.pipeline([["ZRANGE", S.key("regs"), 0, -1, "REV"]]))[0] || [];
      const rows = [];
      if (refs.length) {
        const raws = await S.pipeline([["MGET", ...refs.map((x) => S.key("reg:" + x))]]);
        (raws[0] || []).forEach((raw, i) => {
          if (!raw) return rows.push(unreadable(refs[i], "Record is listed but its data is missing."));
          try { rows.push(summary(S.decrypt(raw))); } catch (_) { rows.push(unreadable(refs[i], "Record could not be decrypted (corrupted, tampered, or encrypted with a different key).")); }
        });
      }
      if (url.searchParams.get("format") === "csv") {
        const cols = COLUMNS;
        const out = [cols.map(csvCell).join(",")].concat(rows.map((r) => cols.map((c) => csvCell(r[c])).join(","))).join("\r\n");
        res.statusCode = 200;
        res.setHeader("Content-Type", "text/csv; charset=utf-8");
        res.setHeader("Content-Disposition", 'attachment; filename="' + (S.isProduction() ? "registrations.csv" : "TEST-registrations.csv") + '"');
        res.setHeader("Cache-Control", "no-store");
        return res.end(out);
      }
      return S.send(res, 200, { registrations: rows, unreadable: rows.filter((x) => x.status === "unreadable").length, testMode: !S.isProduction(), environment: S.environmentName() });
    }

    if (req.method === "POST") {
      let b;
      try { b = await S.readJson(req, 20 * 1024); } catch (e) { return S.send(res, e.message === "too_large" ? 413 : 400, { error: "bad_request" }); }
      if (!b || typeof b !== "object" || Array.isArray(b)) return S.send(res, 400, { error: "bad_request" });
      if (!/^(ITR|TST)-[A-Z0-9]{6}$/.test(String(b.reference || ""))) return S.send(res, 400, { error: "bad_reference" });
      let r;
      try { r = await load(b.reference); } catch (_) { return S.send(res, 422, { error: "record_unreadable" }); }
      if (!r) return S.send(res, 404, { error: "not_found" });
      const txn = typeof b.transactionId === "string" ? b.transactionId.trim() : "";
      const note = typeof b.note === "string" ? b.note.trim() : "";
      if (txn.length > 80 || note.length > 300) return S.send(res, 400, { error: "too_long" });
      const state = r.payment && r.payment.status;
      if (b.action === "markPaid") {
        if (state === "superseded") return S.send(res, 409, { error: "registration_withdrawn" });
        r.payment = { ...r.payment, status: "paid", paidAt: new Date().toISOString(), transactionId: txn, note };
      } else if (b.action === "markUnpaid") {
        if (state === "superseded") return S.send(res, 409, { error: "registration_withdrawn" });
        r.payment = { ...r.payment, status: "unpaid", paidAt: "", transactionId: "", note };
      } else if (b.action === "supersede") {
        // Withdraw an UNPAID registration so the parent can submit corrected details. The old signed record is KEPT (marked superseded).
        if (state === "paid") return S.send(res, 409, { error: "cannot_withdraw_paid" });
        if (state === "superseded") return S.send(res, 409, { error: "already_withdrawn" });
        r.payment = { ...r.payment, status: "superseded", supersededAt: new Date().toISOString(), note };
        const dk = S.dedupeKey(r.athlete.firstName, r.athlete.lastName, r.parent.email, r.season);
        await S.pipeline([["SET", S.key("reg:" + r.reference), S.encrypt(r)]]);
        const [owner] = await S.pipeline([["GET", dk]]);
        if (owner === r.reference) await S.pipeline([["DEL", dk]]); // free the slot (only if it is still this registration's)
        return S.send(res, 200, { ok: true, registration: summary(r) });
      } else return S.send(res, 400, { error: "bad_action" });
      await S.pipeline([["SET", S.key("reg:" + r.reference), S.encrypt(r)]]);
      return S.send(res, 200, { ok: true, registration: summary(r) });
    }

    res.setHeader("Allow", "GET, POST");
    return S.send(res, 405, { error: "method_not_allowed" });
  } catch (_) {
    return S.send(res, 500, { error: "server_error" });
  }
};

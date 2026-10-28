"use strict";
/*
 * /api/admin — Todd's back office. Every request needs  Authorization: Bearer <ADMIN_TOKEN>.
 *   GET  /api/admin                  list registrations (summary, no signature images)
 *   GET  /api/admin?ref=ITR-XXXXXX   one full record (includes the signed-waiver record)
 *   GET  /api/admin?format=csv       CSV download of the summary list
 *   POST /api/admin {reference, action: "markPaid" | "markUnpaid", transactionId?, note?}
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
    createdAt: r.createdAt,
    status: r.payment && r.payment.status === "paid" ? "paid" : "pending_payment",
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

async function load(ref) {
  const [raw] = await S.pipeline([["GET", "reg:" + ref]]);
  return raw ? S.decrypt(raw) : null;
}

module.exports = async function handler(req, res) {
  try {
    if (!S.configured() || !S.env().admin) return S.send(res, 503, { error: "admin_unavailable" });
    if (await S.limited("admin", S.clientIp(req), 40, 600)) return S.send(res, 429, { error: "too_many_requests" });
    if (!S.adminOk(req)) return S.send(res, 401, { error: "unauthorized" });

    const url = new URL(req.url, "http://x");
    if (req.method === "GET") {
      const ref = url.searchParams.get("ref");
      if (ref) {
        if (!/^ITR-[A-Z0-9]{6}$/.test(ref)) return S.send(res, 400, { error: "bad_reference" });
        const r = await load(ref);
        return r ? S.send(res, 200, { record: r }) : S.send(res, 404, { error: "not_found" });
      }
      const refs = (await S.pipeline([["ZRANGE", "regs", 0, -1, "REV"]]))[0] || [];
      const rows = [];
      if (refs.length) {
        const raws = await S.pipeline([["MGET", ...refs.map((x) => "reg:" + x)]]);
        for (const raw of raws[0] || []) if (raw) rows.push(summary(S.decrypt(raw)));
      }
      if (url.searchParams.get("format") === "csv") {
        const cols = rows.length ? Object.keys(rows[0]) : ["reference"];
        const out = [cols.map(csvCell).join(",")].concat(rows.map((r) => cols.map((c) => csvCell(r[c])).join(","))).join("\r\n");
        res.statusCode = 200;
        res.setHeader("Content-Type", "text/csv; charset=utf-8");
        res.setHeader("Content-Disposition", 'attachment; filename="registrations.csv"');
        res.setHeader("Cache-Control", "no-store");
        return res.end(out);
      }
      return S.send(res, 200, { registrations: rows });
    }

    if (req.method === "POST") {
      const b = await S.readJson(req, 20 * 1024);
      if (!/^ITR-[A-Z0-9]{6}$/.test(String(b.reference || ""))) return S.send(res, 400, { error: "bad_reference" });
      const r = await load(b.reference);
      if (!r) return S.send(res, 404, { error: "not_found" });
      const clip = (v, n) => (typeof v === "string" ? v.trim().slice(0, n) : "");
      if (b.action === "markPaid") {
        r.payment = { ...r.payment, status: "paid", paidAt: new Date().toISOString(), transactionId: clip(b.transactionId, 80), note: clip(b.note, 300) };
      } else if (b.action === "markUnpaid") {
        r.payment = { ...r.payment, status: "unpaid", paidAt: "", transactionId: "", note: clip(b.note, 300) };
      } else return S.send(res, 400, { error: "bad_action" });
      await S.pipeline([["SET", "reg:" + r.reference, S.encrypt(r)]]);
      return S.send(res, 200, { ok: true, registration: summary(r) });
    }

    res.setHeader("Allow", "GET, POST");
    return S.send(res, 405, { error: "method_not_allowed" });
  } catch (_) {
    return S.send(res, 500, { error: "server_error" });
  }
};

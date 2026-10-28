"use strict";
/*
 * POST /api/register  — receives a completed registration + signed waiver and stores it encrypted.
 * It does NOT take payment and never marks anything paid. Payment is reconciled manually (see REGISTRATION-SETUP.md).
 * Nothing in here logs request bodies.
 */
const crypto = require("crypto");
const waiver = require("./_lib/waiver");
const S = require("./_lib/store");

const MAX_BODY = 400 * 1024;
const GRADES = ["5th", "6th", "7th", "8th", "9th", "10th", "11th", "12th"];
const LEVELS = ["new", "some", "experienced"];
const SEASON = "Summer 2027";
const ALPHABET = "ABCDEFGHJKMNPQRSTUVWXYZ23456789"; // no 0/O/1/I/L

const clean = (v, max) => (typeof v === "string" ? v.replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, "").trim().slice(0, max) : "");
const norm = (s) => String(s).toLowerCase().replace(/\s+/g, " ").trim();
const digits = (s) => String(s).replace(/\D/g, "");

function validate(b) {
  const f = {};
  const need = (key, max, label) => {
    const v = clean(b[key], max);
    if (!v) f[key] = label + " is required.";
    return v;
  };
  const d = {
    athlete_first: need("athlete_first", 60, "Athlete first name"),
    athlete_last: need("athlete_last", 60, "Athlete last name"),
    school: need("school", 100, "School"),
    parent: need("parent", 100, "Parent/legal guardian full name"),
    emergency_name: need("emergency_name", 100, "Emergency contact name"),
    medical: need("medical", 1500, "Medical restrictions / emergency information"),
    tshirt_size: need("tshirt_size", 20, "T-shirt size"),
    signature_typed: need("signature_typed", 100, "Signature"),
  };
  d.grade = clean(b.grade, 10);
  if (!GRADES.includes(d.grade)) f.grade = "Select the grade entering.";
  d.level = clean(b.level, 20);
  if (!LEVELS.includes(d.level)) f.level = "Select running experience.";
  d.dob = clean(b.dob, 10);
  const t = Date.parse(d.dob + "T00:00:00Z");
  if (!/^\d{4}-\d{2}-\d{2}$/.test(d.dob) || Number.isNaN(t) || t > Date.now() || new Date(t).getUTCFullYear() < 2000) f.dob = "Enter a valid date of birth.";
  d.email = clean(b.email, 160);
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(d.email)) f.email = "Enter a valid email address.";
  d.phone = clean(b.phone, 30);
  if (digits(d.phone).length < 10) f.phone = "Enter a valid phone number.";
  d.emergency_phone = clean(b.emergency_phone, 30);
  if (digits(d.emergency_phone).length < 10) f.emergency_phone = "Enter a valid phone number.";
  if (d.signature_typed && d.parent && norm(d.signature_typed) !== norm(d.parent)) f.signature_typed = "The signature must match the parent/legal guardian name.";
  if (b.agree !== true) f.agree = "You must confirm the waiver acknowledgment.";
  if (b.waiver_version !== waiver.WAIVER_VERSION || b.waiver_sha256 !== waiver.SHA256) f.waiver = "The waiver on your screen is out of date. Please reload the page and try again.";
  d.signature_image = "";
  if (b.signature_image) {
    if (typeof b.signature_image === "string" && /^data:image\/png;base64,[A-Za-z0-9+/=]+$/.test(b.signature_image) && b.signature_image.length <= 160 * 1024) d.signature_image = b.signature_image;
    else f.signature_image = "Drawn signature could not be read.";
  }
  d.signed_date_display = clean(b.signed_date_display, 40);
  return { f, d };
}

module.exports = async function handler(req, res) {
  try {
    if (req.method !== "POST") {
      res.setHeader("Allow", "POST");
      return S.send(res, 405, { error: "method_not_allowed" });
    }
    if (!S.configured()) return S.send(res, 503, { error: "registration_unavailable" });

    const origin = req.headers.origin;
    if (origin) {
      let ok = false;
      try { ok = new URL(origin).host === req.headers.host; } catch (_) { ok = false; }
      if (!ok) return S.send(res, 403, { error: "forbidden" });
    }
    if (!String(req.headers["content-type"] || "").includes("application/json")) return S.send(res, 415, { error: "unsupported_media_type" });

    let body;
    try { body = await S.readJson(req, MAX_BODY); } catch (e) { return S.send(res, e.message === "too_large" ? 413 : 400, { error: "bad_request" }); }
    if (!body || typeof body !== "object") return S.send(res, 400, { error: "bad_request" });

    if (body.website) return S.send(res, 200, { ok: true, reference: "ITR-000000" }); // honeypot: pretend success, store nothing

    const ip = S.clientIp(req);
    if (await S.limited("reg", ip, 12, 600)) return S.send(res, 429, { error: "too_many_requests" });

    const { f, d } = validate(body);
    if (Object.keys(f).length) return S.send(res, 400, { error: "validation", fields: f });

    // De-duplicate: same athlete + parent email for this season returns the existing reference instead of a second record.
    const dedupe = "dedupe:" + crypto.createHash("sha256").update([norm(d.athlete_first), norm(d.athlete_last), norm(d.email), SEASON].join("|")).digest("hex");
    const reference = "ITR-" + Array.from(crypto.randomBytes(6), (b) => ALPHABET[b % ALPHABET.length]).join("");
    const [claimed] = await S.pipeline([["SET", dedupe, reference, "NX"]]);
    if (claimed !== "OK") {
      const [existing] = await S.pipeline([["GET", dedupe]]);
      return S.send(res, 200, { ok: true, reference: existing, duplicate: true });
    }

    const now = new Date().toISOString();
    const record = {
      reference,
      season: SEASON,
      createdAt: now,
      athlete: { firstName: d.athlete_first, lastName: d.athlete_last, dob: d.dob, gradeEntering: d.grade, school: d.school, experience: d.level, tshirtSize: d.tshirt_size },
      parent: { fullName: d.parent, email: d.email, phone: d.phone },
      emergency: { contactName: d.emergency_name, contactPhone: d.emergency_phone, medical: d.medical },
      waiver: {
        version: waiver.WAIVER_VERSION,
        sha256: waiver.SHA256,
        accepted: true,
        typedSignature: d.signature_typed,
        drawnSignaturePng: d.signature_image,
        signedDateShown: d.signed_date_display,
        signedAt: now,
        ip,
        userAgent: clean(req.headers["user-agent"], 300),
      },
      payment: { status: "unpaid", amountDue: 200, currency: "USD" },
    };
    try {
      await S.pipeline([["SET", "reg:" + reference, S.encrypt(record)], ["ZADD", "regs", Date.now(), reference]]);
    } catch (e) {
      await S.pipeline([["DEL", dedupe]]).catch(() => {});
      return S.send(res, 500, { error: "storage_failed" });
    }
    return S.send(res, 200, { ok: true, reference });
  } catch (_) {
    return S.send(res, 500, { error: "server_error" });
  }
};
module.exports._validate = validate;

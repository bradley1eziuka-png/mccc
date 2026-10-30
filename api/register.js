"use strict";
/*
 * POST /api/register  — receives a completed registration + signed waiver and stores it encrypted.
 * It does NOT take payment and never marks anything paid. Payment is reconciled manually (see REGISTRATION-SETUP.md).
 * Nothing in here logs request bodies.
 *
 * Resubmissions: an IDENTICAL repeat returns the existing reference. A resubmission with DIFFERENT details is refused (409) and
 * never saved, so a parent can never believe a corrected phone number or medical note was recorded when it was not. Todd withdraws
 * the old (unpaid) registration in /admin and the parent submits again.
 * Nothing is silently truncated: any field over its limit is rejected with a message.
 */
const crypto = require("crypto");
const waiver = require("./_lib/waiver");
const S = require("./_lib/store");

const MAX_BODY = 400 * 1024;
// Per IP. Generous enough for several families sharing one network (school/event wifi, mobile carrier NAT), but still bounded.
const LIMITS = { requests: 60, windowSec: 600, newPerHour: 40 };
const GRADES = ["5th", "6th", "7th", "8th", "9th", "10th", "11th", "12th"];
const LEVELS = ["new", "some", "experienced"];
const SEASON = "Summer 2027";
const ALPHABET = "ABCDEFGHJKMNPQRSTUVWXYZ23456789"; // no 0/O/1/I/L

const text = (v) => (typeof v === "string" ? v.replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, "").trim() : "");
const norm = (s) => String(s == null ? "" : s).toLowerCase().replace(/\s+/g, " ").trim();
const digits = (s) => String(s == null ? "" : s).replace(/\D/g, "");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function validate(b) {
  const f = {};
  // Required text. Over-long input is REJECTED, never cut off.
  const need = (key, max, label) => {
    const v = text(b[key]);
    if (!v) f[key] = label + " is required.";
    else if (v.length > max) f[key] = label + " is too long (maximum " + max + " characters). Please shorten it.";
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
  d.grade = text(b.grade);
  if (!GRADES.includes(d.grade)) f.grade = "Select the grade entering.";
  d.level = text(b.level);
  if (!LEVELS.includes(d.level)) f.level = "Select running experience.";
  d.dob = text(b.dob);
  const t = Date.parse(d.dob + "T00:00:00Z");
  if (!/^\d{4}-\d{2}-\d{2}$/.test(d.dob) || Number.isNaN(t) || t > Date.now() || new Date(t).getUTCFullYear() < 2000) f.dob = "Enter a valid date of birth.";
  d.email = text(b.email);
  if (d.email.length > 160 || !/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(d.email)) f.email = "Enter a valid email address.";
  d.phone = text(b.phone);
  if (d.phone.length > 30 || digits(d.phone).length < 10) f.phone = "Enter a valid phone number.";
  d.emergency_phone = text(b.emergency_phone);
  if (d.emergency_phone.length > 30 || digits(d.emergency_phone).length < 10) f.emergency_phone = "Enter a valid phone number.";
  if (d.signature_typed && d.parent && norm(d.signature_typed) !== norm(d.parent)) f.signature_typed = "The signature must match the parent/legal guardian name.";
  if (b.agree !== true) f.agree = "You must confirm the waiver acknowledgment.";
  if (b.waiver_version !== waiver.WAIVER_VERSION || b.waiver_sha256 !== waiver.SHA256) f.waiver = "The waiver on your screen is out of date. Please reload the page and try again.";
  d.signature_image = "";
  if (b.signature_image) {
    if (typeof b.signature_image === "string" && /^data:image\/png;base64,[A-Za-z0-9+/=]+$/.test(b.signature_image) && b.signature_image.length <= 160 * 1024) d.signature_image = b.signature_image;
    else f.signature_image = "Drawn signature could not be read.";
  }
  d.signed_date_display = text(b.signed_date_display);
  if (d.signed_date_display.length > 40) f.signed_date_display = "Signature date is invalid.";
  return { f, d };
}

/** Fingerprint of what the parent actually told us (ignores signature drawing, timestamps, capitalization and spacing). */
function fingerprint(x) {
  return crypto
    .createHash("sha256")
    .update(JSON.stringify([norm(x.athlete_first), norm(x.athlete_last), x.dob, x.grade, norm(x.school), x.level, norm(x.tshirt_size), norm(x.parent), norm(x.email), digits(x.phone), norm(x.emergency_name), digits(x.emergency_phone), norm(x.medical), norm(x.signature_typed)]))
    .digest("hex");
}
const fromRecord = (r) => ({
  athlete_first: r.athlete.firstName, athlete_last: r.athlete.lastName, dob: r.athlete.dob, grade: r.athlete.gradeEntering, school: r.athlete.school,
  level: r.athlete.experience, tshirt_size: r.athlete.tshirtSize, parent: r.parent.fullName, email: r.parent.email, phone: r.parent.phone,
  emergency_name: r.emergency.contactName, emergency_phone: r.emergency.contactPhone, medical: r.emergency.medical, signature_typed: r.waiver.typedSignature,
});

module.exports = async function handler(req, res) {
  try {
    // MASTER SWITCH: closed unless REGISTRATION_OPEN is exactly "true". Checked FIRST, before the body is read or the database is touched.
    if (!S.registrationOpen()) return S.send(res, 503, { error: "registration_closed" });
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
    try { body = await S.readJson(req, MAX_BODY); } catch (e) { return S.send(res, e.message === "too_large" ? 413 : 400, { error: e.message === "too_large" ? "payload_too_large" : "bad_request" }); }
    if (!body || typeof body !== "object" || Array.isArray(body)) return S.send(res, 400, { error: "bad_request" });

    if (body.website) return S.send(res, 200, { ok: true, reference: S.isProduction() ? "ITR-000000" : "TST-000000" }); // honeypot: pretend success, store nothing

    const ip = S.clientIp(req);
    if (await S.limited("reg", ip, LIMITS.requests, LIMITS.windowSec)) return S.send(res, 429, { error: "too_many_requests" });

    const { f, d } = validate(body);
    if (Object.keys(f).length) return S.send(res, 400, { error: "validation", fields: f });

    // Second, slower cap on actual registrations per IP (stops bulk junk without hurting a shared network).
    if (await S.limited("regnew", ip, LIMITS.newPerHour, 3600)) return S.send(res, 429, { error: "too_many_requests" });

    const dedupe = S.dedupeKey(d.athlete_first, d.athlete_last, d.email, SEASON);
    const reference = (S.isProduction() ? "ITR-" : "TST-") + Array.from(crypto.randomBytes(6), (b) => ALPHABET[b % ALPHABET.length]).join("");
    const mine = fingerprint(d);

    // Claim the slot for this athlete + parent email. The claim expires on its own (30s) unless the record is saved, so a crash can never lock a family out.
    let claimed = false;
    for (let attempt = 0; attempt < 14 && !claimed; attempt++) {
      const [ok] = await S.pipeline([["SET", dedupe, reference, "NX", "EX", 30]]);
      if (ok === "OK") { claimed = true; break; }
      const [existingRef] = await S.pipeline([["GET", dedupe]]);
      if (existingRef) {
        const [raw] = await S.pipeline([["GET", S.key("reg:" + existingRef)]]);
        if (raw) {
          let existing;
          try { existing = S.decrypt(raw); } catch (_) { return S.send(res, 500, { error: "server_error" }); } // never overwrite something we cannot read
          // Same details -> harmless repeat. Different details -> refuse loudly; NOTHING from this submission is saved.
          if (fingerprint(fromRecord(existing)) === mine) return S.send(res, 200, { ok: true, reference: existingRef, duplicate: true });
          return S.send(res, 409, { error: "already_registered", reference: existingRef });
        }
      }
      await sleep(150); // another request is still writing this registration (or the claim just expired): wait and look again
    }
    if (!claimed) return S.send(res, 503, { error: "try_again" });

    const now = new Date().toISOString();
    const record = {
      reference,
      environment: S.environmentName(), // "production" for real registrations; anything else is test data
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
        userAgent: text(req.headers["user-agent"]).slice(0, 300), // diagnostic metadata only, not registrant-entered data
      },
      payment: { status: "unpaid", amountDue: 200, currency: "USD" },
    };
    try {
      await S.pipeline([["SET", S.key("reg:" + reference), S.encrypt(record)], ["ZADD", S.key("regs"), Date.now(), reference], ["PERSIST", dedupe]]);
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

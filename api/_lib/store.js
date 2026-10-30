"use strict";
/*
 * Storage + encryption for registrations. NO third-party dependencies.
 *
 * Storage: Upstash Redis over its REST API (add the "Upstash for Redis" integration from the Vercel
 * Marketplace; it injects the URL/token env vars below). Records are ALSO encrypted by us with
 * AES-256-GCM before they are written, so the database never holds readable minors' data.
 *
 * Required environment variables (set in the Vercel project, never in the repo):
 *   UPSTASH_REDIS_REST_URL / UPSTASH_REDIS_REST_TOKEN   (or KV_REST_API_URL / KV_REST_API_TOKEN)
 *   REGISTRATION_ENCRYPTION_KEY   base64 of 32 random bytes:  openssl rand -base64 32
 *   ADMIN_TOKEN                   long random string used to open the admin page
 *
 * If any of these is missing, configured() is false and the API refuses to accept registrations.
 *
 * ENVIRONMENT ISOLATION (fail closed):
 *   - Production (VERCEL_ENV=production) uses the KV_REST_API_* credentials (UPSTASH_* accepted as a fallback).
 *   - Every other environment (preview, development, local) uses ONLY UPSTASH_REDIS_REST_URL / _TOKEN and NEVER the KV_* ones.
 *     If those are missing, or they point at the same database as KV_*, the store is "not configured" and everything is refused.
 *   - Non-production keys are namespaced ("test:") and references start with TST- so test data can never be confused with real data.
 *   - Registration is also closed unless REGISTRATION_OPEN is exactly "true" (see registrationOpen()). Never set it in Production
 *     until the legal review and a full test are done.
 */
const crypto = require("crypto");

const vercelEnv = () => process.env.VERCEL_ENV || "";
const isProduction = () => vercelEnv() === "production";
const environmentName = () => vercelEnv() || "local";
const trimUrl = (u) => String(u || "").replace(/\/$/, "");

/** Which database credentials this deployment may use. Never lets a non-production deployment reach the production database. */
function dbCreds() {
  const e = process.env;
  if (isProduction()) {
    return { url: e.KV_REST_API_URL || e.UPSTASH_REDIS_REST_URL || "", token: e.KV_REST_API_TOKEN || e.UPSTASH_REDIS_REST_TOKEN || "" };
  }
  const url = e.UPSTASH_REDIS_REST_URL || "";
  const token = e.UPSTASH_REDIS_REST_TOKEN || "";
  const sameAsProd = (url && e.KV_REST_API_URL && trimUrl(url) === trimUrl(e.KV_REST_API_URL)) || (token && e.KV_REST_API_TOKEN && token === e.KV_REST_API_TOKEN);
  if (sameAsProd) return { url: "", token: "" }; // test creds that match the production DB are refused
  return { url, token };
}

const env = () => ({
  ...dbCreds(),
  encKey: process.env.REGISTRATION_ENCRYPTION_KEY || "",
  admin: process.env.ADMIN_TOKEN || "",
});

/** Server-side master switch. Closed unless REGISTRATION_OPEN is exactly the string "true". */
const registrationOpen = () => process.env.REGISTRATION_OPEN === "true";

/** Namespaces every key outside production so test data is physically separate and obvious. */
const key = (k) => (isProduction() ? k : "test:" + k);

function encKeyBuf() {
  const k = Buffer.from(env().encKey, "base64");
  return k.length === 32 ? k : null;
}

function configured() {
  const e = env();
  return Boolean(e.url && e.token && encKeyBuf());
}

async function pipeline(commands) {
  const e = env();
  const res = await fetch(e.url.replace(/\/$/, "") + "/pipeline", {
    method: "POST",
    headers: { Authorization: "Bearer " + e.token, "Content-Type": "application/json" },
    body: JSON.stringify(commands),
  });
  if (!res.ok) throw new Error("store_error");
  const out = await res.json();
  return out.map((o) => {
    if (o && o.error) throw new Error("store_error");
    return o ? o.result : null;
  });
}

const b64u = (b) => Buffer.from(b).toString("base64url");
const AAD = Buffer.from("itr-registration-v1");

function encrypt(obj) {
  const key = encKeyBuf();
  const iv = crypto.randomBytes(12);
  const c = crypto.createCipheriv("aes-256-gcm", key, iv);
  c.setAAD(AAD);
  const ct = Buffer.concat([c.update(JSON.stringify(obj), "utf8"), c.final()]);
  return ["v1", b64u(iv), b64u(c.getAuthTag()), b64u(ct)].join(".");
}

function decrypt(str) {
  const [v, iv, tag, ct] = String(str).split(".");
  if (v !== "v1") throw new Error("bad_record");
  const d = crypto.createDecipheriv("aes-256-gcm", encKeyBuf(), Buffer.from(iv, "base64url"));
  d.setAAD(AAD);
  d.setAuthTag(Buffer.from(tag, "base64url"));
  const pt = Buffer.concat([d.update(Buffer.from(ct, "base64url")), d.final()]);
  return JSON.parse(pt.toString("utf8"));
}

/** Constant-time check of the admin bearer token. */
function adminOk(req) {
  const want = env().admin;
  if (!want || want.length < 20) return false;
  const got = String(req.headers.authorization || "").replace(/^Bearer\s+/i, "");
  const a = crypto.createHash("sha256").update(got).digest();
  const b = crypto.createHash("sha256").update(want).digest();
  return crypto.timingSafeEqual(a, b);
}

function clientIp(req) {
  const xf = String(req.headers["x-forwarded-for"] || "").split(",")[0].trim();
  return xf || (req.socket && req.socket.remoteAddress) || "unknown";
}

/** Simple fixed-window limiter. Returns true when the caller is OVER the limit. */
async function limited(bucket, ip, max, windowSec) {
  const k = key("rl:" + bucket) + ":" + crypto.createHash("sha256").update(ip).digest("hex").slice(0, 24);
  const [n] = await pipeline([["INCR", k], ["EXPIRE", k, windowSec, "NX"]]);
  return Number(n) > max;
}

function send(res, status, body) {
  res.statusCode = status;
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.setHeader("Cache-Control", "no-store");
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.end(JSON.stringify(body));
}

async function readJson(req, maxBytes) {
  if (req.body && typeof req.body === "object") return req.body;
  let raw = typeof req.body === "string" ? req.body : "";
  if (!raw) {
    const chunks = [];
    let size = 0;
    for await (const c of req) {
      size += c.length;
      if (size > maxBytes) throw new Error("too_large");
      chunks.push(c);
    }
    raw = Buffer.concat(chunks).toString("utf8");
  }
  if (raw.length > maxBytes) throw new Error("too_large");
  return JSON.parse(raw);
}

module.exports = { configured, pipeline, encrypt, decrypt, adminOk, clientIp, limited, send, readJson, env, registrationOpen, isProduction, environmentName, key };

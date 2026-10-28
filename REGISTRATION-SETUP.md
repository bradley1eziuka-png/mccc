# Registration, waiver and payment: setup guide

**Current state: built, tested with fake data, and switched OFF.**
Parents can walk through the registration steps on `/register`, but nothing is sent, saved or charged,
and no PayPal link is shown. `/api/register` and `/api/admin` also refuse every request (HTTP 503) until
storage is configured. Two independent switches keep it closed:

1. `registrationOpen: false` in `assets/js/config.js` (the page).
2. Missing environment variables on Vercel (the server).

## How registration works once it is on

1. Parent completes: Athlete, Parent and emergency, Waiver and signature, Review.
2. The browser sends the form (HTTPS POST, never in the URL) to `/api/register`.
3. The server validates it, encrypts it (AES-256-GCM) and stores it in Upstash Redis. The parent gets a reference like `ITR-7K3P9Q`.
4. The parent is sent to Todd's PayPal link: https://www.paypal.com/ncp/payment/XYLCNA95P322C ($200 USD).
5. Todd matches the payment and marks the registration paid in `/admin`. **Nothing is ever marked paid automatically.**

What is saved with each registration: athlete, date of birth, grade, school, experience, shirt size, parent
name/email/phone, emergency contact, medical info, the waiver version and its SHA-256 fingerprint, the typed
signature (and drawn signature if provided), the acceptance, the server timestamp, IP address and browser,
and the payment status.

## What Todd needs to do before going live

### 1. Legal review (do this first)
The waiver text is Todd's, copied word for word from `Monroe It's Time To Run Club Waiver.docx`.
**It has not had legal review and nothing here claims it is enforceable.** A Michigan attorney should
review the waiver and the typed/drawn e-signature process before live registrations. Minors' waivers in
particular vary by state.

### 2. Create the storage (about 5 minutes, free tier is enough)
In the Vercel dashboard for this project: **Storage → Marketplace → "Upstash for Redis" → Create**, and connect
it to the project. Vercel adds `UPSTASH_REDIS_REST_URL` and `UPSTASH_REDIS_REST_TOKEN` (or `KV_REST_API_URL` /
`KV_REST_API_TOKEN`) automatically.

### 3. Add two secrets (Project → Settings → Environment Variables, Production)
| Name | Value |
|---|---|
| `REGISTRATION_ENCRYPTION_KEY` | output of `openssl rand -base64 32` |
| `ADMIN_TOKEN` | a long random string (20+ characters) used as the admin password |

**Save the encryption key somewhere safe outside Vercel (password manager).** If it is lost, stored
registrations cannot be decrypted. Never put either value in GitHub.

### 4. Test on a Vercel preview with fake data
Change `registrationOpen` to `true` on a branch, open the preview URL, register a fake athlete, confirm you get a
reference and the PayPal button, then open `/admin`, enter the admin token, and check the record, signed
waiver, "Mark paid" and CSV download. Delete the test records (Upstash console, Data Browser: keys
`reg:ITR-…` and `dedupe:…`, and remove the reference from the `regs` sorted set).

### 5. Go live
Merge `registrationOpen: true` to `main`. Do not do this before steps 1 to 4.

## Matching payments to registrations (important limitation)

The supplied PayPal link is a **hosted payment link**. It cannot be told which athlete is paying, and
returning from PayPal proves nothing, so the site deliberately has no "payment successful" page and never
marks anyone paid on its own.

What the site does instead (simple and reliable with the current PayPal setup):

* The parent sees their reference and is told to pay with **the same email they registered with** and to add
  the reference in any PayPal note field.
* Todd opens PayPal → Activity, finds each $200 payment, and in `/admin` clicks **Mark paid** (and pastes the PayPal
  transaction ID). Match on payer email, then payer name and amount.
* `/admin` shows who is still **Awaiting payment**; that is the list of incomplete registrations.
* `/admin` → **Download CSV** exports everyone for rosters and shirt orders.

Paying parents who used a different PayPal email or a nickname will need a quick manual match (parent email and
phone are in `/admin`).

**To automate this later** (not built; needs Todd's PayPal account): create a PayPal REST app in the
PayPal Developer dashboard (Live) to get a client ID and secret, then switch from the hosted link to PayPal
Orders API checkout with `custom_id` = the registration reference, plus a webhook for
`PAYMENT.CAPTURE.COMPLETED`. Only the account owner can create those credentials.

**Heads-up:** the PayPal checkout page currently says "Todd Williams Cross Country Summer Camp". Todd can
rename the item in PayPal so it matches Monroe It's Time To Run.

## Known limits

* Only completed registrations are saved. People who stop before the final step leave no record.
* No confirmation emails are sent (none were requested or configured).
* No refund, edit or delete screens; use the Upstash Data Browser for those.
* The T-shirt size list on `/register` is provisional (Youth S to Adult XXL). Todd must confirm the real sizes.
* Parent testimonial attribution "Parent of a Club Athlete" is temporary until Todd supplies the name.
* Contact email `MonroeJiuJitsu11@gmail.com` still needs Todd's confirmation as the public address.

## Changing the waiver later
The waiver text lives in `api/_lib/waiver.js` (generated), `assets/data/waiver-<version>.json` (viewer copy) and the
markup in `register.html` (`data-wp` elements). The server rejects a registration if the text the parent
saw does not match its fingerprint. To change it: update all three, bump the version string, and keep the old
`waiver-<oldversion>.json` so earlier signed waivers can still be displayed.

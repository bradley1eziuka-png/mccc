/* Public site configuration. Contains NO secrets. */
window.SITE_CONFIG = {
  // MUST stay false until: (1) encrypted storage env vars are set on Vercel, (2) the waiver has had legal review,
  // (3) a test registration has been saved and checked in /admin. See REGISTRATION-SETUP.md.
  registrationOpen: false,
  apiUrl: "/api/register",
  // Todd's hosted PayPal checkout ($200 USD). Shown ONLY after a registration has been saved.
  // NOTE: the PayPal page currently shows the item name "Todd Williams Cross Country Summer Camp"; Todd can rename it in PayPal.
  paypalUrl: "https://www.paypal.com/ncp/payment/XYLCNA95P322C",
};

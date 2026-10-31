/* Public site configuration. Contains NO secrets. */
window.SITE_CONFIG = {
  // Page switch: shows the registration form. The real lock is the server variable REGISTRATION_OPEN in Vercel (Production);
  // /api/register answers 503 until it is "true". See REGISTRATION-SETUP.md.
  registrationOpen: true,
  apiUrl: "/api/register",
  // Todd's hosted PayPal checkout ($200 USD). Shown ONLY after a registration has been saved.
  // NOTE: the PayPal page currently shows the item name "Todd Williams Cross Country Summer Camp"; Todd can rename it in PayPal.
  paypalUrl: "https://www.paypal.com/ncp/payment/XYLCNA95P322C",
};

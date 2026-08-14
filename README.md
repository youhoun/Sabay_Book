# Sabai Books

Sabai Books is a small paid/free book platform built with plain Node.js and vanilla HTML/CSS/JS. It now uses **real OAuth login** and is **ready for real ABA PayWay checkout**.

## Run

```bash
node server.js
```

Open `http://localhost:3000`. Do not use VS Code Live Server for this project.

## Real login

The old typed-name/demo-admin login has been removed. Users are authenticated by Google and/or Facebook OAuth. The server creates or finds the user only after the OAuth provider returns the verified profile.

Set these environment variables before starting the server:

```text
APP_BASE_URL=http://localhost:3000
ADMIN_EMAILS=your-google-email@example.com

GOOGLE_CLIENT_ID=...
GOOGLE_CLIENT_SECRET=...
GOOGLE_REDIRECT_URI=http://localhost:3000/auth/google/callback

FACEBOOK_CLIENT_ID=...
FACEBOOK_CLIENT_SECRET=...
FACEBOOK_REDIRECT_URI=http://localhost:3000/auth/facebook/callback
```

You can use only Google if you prefer; Facebook is optional. The admin role is **not** controlled by a browser checkbox. An email listed in `ADMIN_EMAILS` is assigned the admin role after successful OAuth login.

For Google, register a Web OAuth client and add the exact callback URL shown above to the OAuth client's authorized redirect URIs. Google documents the server-side OAuth authorization-code flow here: https://developers.google.com/identity/protocols/oauth2/web-server

## Real ABA PayWay

The simulated payment buttons have been removed. Paid books now create a real PayWay transaction and send the customer to ABA PayWay's hosted checkout. The server also checks the transaction status through PayWay's Check Transaction API before unlocking the book.

Set:

```text
PAYWAY_MERCHANT_ID=your-merchant-id
PAYWAY_API_KEY=your-api-key
PAYWAY_SANDBOX=true
PAYWAY_RETURN_URL=http://localhost:3000/payway/return
```

For production, use `PAYWAY_SANDBOX=false` and your production credentials. PayWay requires a merchant account/API credentials and may require your public domain/IP to be whitelisted. Their current developer documentation says sandbox credentials are provided after creating a sandbox account and production credentials require merchant onboarding.

### Important for local testing

PayWay's callback/return flow needs an address PayWay can reach. `localhost` works for your browser but is not reachable from PayWay's servers. For end-to-end sandbox callback testing, use a public HTTPS address and put that address in `APP_BASE_URL`/`PAYWAY_RETURN_URL`, then whitelist it in PayWay if required.

The current integration follows PayWay's documented Purchase API, which accepts a hosted checkout request and supports ABA Pay, KHQR, cards and other payment methods depending on the merchant configuration. The app never stores card/ABA credentials.

## Environment file

Copy `.env.example` to your own notes/configuration and set the values in your shell or hosting provider. This project intentionally does not use `dotenv`, so secrets stay outside the repository.

### PowerShell example

```powershell
$env:GOOGLE_CLIENT_ID="your-client-id"
$env:GOOGLE_CLIENT_SECRET="your-client-secret"
$env:GOOGLE_REDIRECT_URI="http://localhost:3000/auth/google/callback"
$env:ADMIN_EMAILS="your-email@example.com"
$env:PAYWAY_MERCHANT_ID="your-payway-merchant-id"
$env:PAYWAY_API_KEY="your-payway-api-key"
$env:PAYWAY_SANDBOX="true"
node server.js
```

Never commit real OAuth or PayWay secrets to GitHub.

## What changed from the old prototype

- Removed `/api/auth/mock-login`.
- Removed the fake name/email/admin checkbox.
- Added Google OAuth and optional Facebook OAuth callbacks.
- Admin assignment is server-side via `ADMIN_EMAILS`.
- Removed `/api/orders/:id/simulate-payment`.
- Paid orders now go to `/payway/checkout/:id`.
- Added PayWay HMAC signing and transaction-status checking.
- `pay.html` now shows real transaction status instead of fake success/failure buttons.

## Project layout

```text
server.js         OAuth, sessions, PayWay integration, API and static server
seed.js           initial local JSON data
public/
  index.html      home/search
  book.html       book details and purchase button
  pay.html        real PayWay transaction status
  mybooks.html    purchased books
  admin.html      admin dashboard
  app.js          shared auth/UI helpers
  style.css       styling
.env.example      configuration template
```


## Lecture library

This version includes a **Lectures** section with PDF materials from the uploaded lecture archives. Open `http://localhost:3000/lectures.html` after starting the server. The library contains 32 free PDFs and 12 PDFs marked $0.25.

Run locally with:

```bash
node server.js
```

The lecture viewer opens PDFs directly in the browser. The $0.25 labels are catalog labels in this version; payment gating for those lecture files is not implemented yet.

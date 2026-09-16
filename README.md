# ZeroVault

**Secure team file storage with WebAuthn MFA, server-side AES-256-CTR streaming encryption, shared links with expiry, and geofencing.**

[![Node.js](https://img.shields.io/badge/Node.js-18+-green.svg)](https://nodejs.org)
[![Express](https://img.shields.io/badge/Express-4.x-lightgrey.svg)](https://expressjs.com)
[![Firebase](https://img.shields.io/badge/Firebase-Auth+Realtime%20DB-orange.svg)](https://firebase.google.com)
[![WebAuthn](https://img.shields.io/badge/WebAuthn-simplewebauthn-blue.svg)](https://simplewebauthn.dev)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)

---

## Overview

ZeroVault is a server-side encrypted file storage platform. Files are encrypted on-the-fly as they stream through the Node.js proxy to S3-compatible storage (Wasabi/AWS S3), and decrypted when downloaded — without ever buffering the full file into memory. The browser never sees encryption logic; it uploads and downloads raw files through the proxy.

User authentication runs through **Firebase Auth** (email/password + optional WebAuthn MFA), and file metadata, shared links, and access control live in **Firebase Realtime Database**.

Default deployment target is **Vercel** with **Wasabi** as the S3 backend.

---

## Features

- **Streaming proxy encryption (AES-256-CTR)** — Files are encrypted/decrypted in a streaming pipe between the client and S3. No full-file buffering, no client-side crypto overhead.
- **Byte-range seeking for video playback** — Encrypted videos can be seeked normally. The server calculates the correct CTR counter offset for any byte range requested, so players like Video.js work without modification.
- **Legacy file compatibility** — Files uploaded before encryption was enabled remain accessible. The server checks an S3 metadata tag (`encrypted: "true"`) and only decrypts files that need it.
- **Firebase Auth** — Email/password signup and login, with session tracking (login count, last login time, last login location).
- **WebAuthn MFA** — Optional second factor via platform authenticators (Windows Hello, Touch ID, Android Biometrics, etc.) using `simplewebauthn`.
- **Shared links** — Generate time-limited, download-limited share links for any file or folder. Links can optionally enforce a **geofence** (latitude/longitude + radius) so only people in a specific location can download.
- **Shared folder access** — Share entire folders with specific email addresses, with permissions and expiry.
- **Geolocation on login** — Optional lat/lng capture at login time, stored per user and used for geofence checks on shared links.
- **S3-compatible storage** — Built for Wasabi by default, works with any S3-compatible provider via environment variables.
- **CORS ready** — Broad CORS headers configured for cross-origin browser access.
- **Vercel deployment** — `vercel.json` included. Works as a serverless function on Vercel with the built-in `VERCEL_URL` env var handling the WebAuthn origin automatically.

---

## Architecture

### Encryption model

The core idea is **transparent streaming encryption at the proxy layer**.

```
 Browser                   Node.js Proxy                    S3 / Wasabi
   |                            |                              |
   |--- POST /api/upload ------->|                              |
   |                            |-- s3.upload() --------------->|
   |                            |   (pipe: req -> AES-CTR -> S3) |
   |<-- 200 OK ------------------+                              |
   |                            |                              |
   |--- GET /download/filename ->|                              |
   |                            |<-- s3.getObject() ------------|--|
   |                            |   (pipe: S3 -> AES-CTR -> res) |
   |<-- decrypted file ----------+                              |
```

- **Upload:** The incoming request stream is piped through an AES-256-CTR cipher, then into `s3.upload()`. The file is stored encrypted in S3 with metadata `encrypted: "true"`.
- **Download:** The server does a `HEAD` on the object first. If `encrypted: "true"` is present, the `GET` stream is piped backward through a decipher before reaching the client. If not present, the raw S3 stream passes through untouched.
- **Video seeking:** When the browser sends a `Range: bytes=X-Y` header (e.g. for `<video>` seeking), the server calculates the correct CTR counter offset using `BigInt` arithmetic on the block index, reinitializes the decipher at that position, and returns a `206 Partial Content` response. This lets standard HTML5 video players seek encrypted videos seamlessly.

### Why AES-CTR

CTR mode turns a block cipher into a stream cipher — encryption and decryption are the same operation, and any byte offset can be decrypted independently by computing the correct counter value. This is what makes range requests possible without decrypting the whole file first. CBC mode can't do this cleanly because each block depends on the previous one.

### Auth flow

1. User signs up/logs in via Firebase Auth (email/password).
2. If the user has registered WebAuthn credentials, the login pauses at an MFA step — the user must complete a WebAuthn assertion before the session is finalized.
3. On successful login, the session is stored in a cookie-session (HTTP-only, 24h), and login metadata (count, time, location) is updated in Firebase Realtime Database.
4. All file routes are guarded by `requireLogin` middleware. Shared access routes additionally check `checkSharedAccess`.

### Shared access

Two mechanisms:

- **Shared links** — A link ID is stored in Firebase (`links/{linkId}`) with `expiryTime`, `maxDownloads`, optional `geofence`, and the target `folderPath`. Anyone with the link can download until expiry/download limit is hit.
- **Shared folder access** — An entry in `Access/{accessId}` records who has access (`accessTo` email), which folder, permissions, and expiry. Appears in the file browser sidebar for the recipient.

Both support optional geofencing: if the link/folder has a geofence defined, the request must include `lat` and `lng` query parameters within the allowed radius, or the download is rejected.

---

## Tech Stack

| Layer | Technology |
|-------|-----------|
| Runtime | Node.js 18+ |
| Web framework | Express 4.x |
| Templates | EJS |
| Authentication | Firebase Auth (email/password) + simplewebauthn (WebAuthn MFA) |
| Metadata / realtime DB | Firebase Realtime Database |
| File storage | S3-compatible (Wasabi default, AWS S3 compatible) |
| Encryption | Node.js native `crypto` — AES-256-CTR, HMAC-SHA256 for file keys, scrypt for key derivation |
| Session | cookie-session (HTTP-only, 24h) |
| Geolocation | Haversine formula (custom utility) |
| Deployment | Vercel (serverless) or any Node.js host |
| Linting | ESLint 10.x |
| Testing | Jest (placeholder) |

---

## Prerequisites

- **Node.js 18 or higher**
- **A Firebase project** with:
  - Authentication (email/password) enabled
  - Realtime Database enabled (locked down to authenticated users)
- **An S3-compatible storage account** (Wasabi recommended) with a bucket created
- **A WebAuthn relying party ID** (for production, this should be your domain; for local dev it can be `localhost`)

---

## Environment Variables

Create a `.env` file in the project root. All variables are loaded via `dotenv` at startup.

| Variable | Required | Description |
|----------|----------|-------------|
| `SESSION_SECRET` | **Yes** | Secret key for cookie-session encryption. Use a long random string. |
| `STORAGE_MASTER_KEY` | **Yes** | Master key for file encryption. Used to derive per-file encryption keys. A separate key from `SESSION_SECRET` is recommended. |
| `FIREBASE_API_KEY` | **Yes** | Firebase project API key (client-side config, safe to expose). |
| `FIREBASE_AUTH_DOMAIN` | **Yes** | Firebase Auth domain (e.g. `your-project.firebaseapp.com`). |
| `FIREBASE_DATABASE_URL` | **Yes** | Realtime Database URL (e.g. `https://your-project-default-rtdb.firebaseio.com`). |
| `WASABI_ACCESS_KEY_ID` | **Yes** | S3 access key ID for your storage provider. |
| `WASABI_SECRET_ACCESS_KEY` | **Yes** | S3 secret access key for your storage provider. |
| `WASABI_BUCKET` | **Yes** | Name of the S3 bucket to store files in. |
| `WASABI_REGION` | No | S3 region (default: `us-east-1`). |
| `UNIVERSAL_API_KEY` | No | A server-side API key used for the WebAuthn relying party configuration. Can be any string. |
| `RP_ID` | No | WebAuthn Relying Party ID. Defaults to the Vercel URL. For local dev, set to `localhost`. |
| `ORIGIN` | No | WebAuthn origin URL. Defaults to the Vercel URL. Must match the browser's origin exactly for WebAuthn to work. |
| `NODE_ENV` | No | Set to `production` to enable secure cookies and suppress the local server startup log (for Vercel). |
| `PORT` | No | Local port to listen on. Default: `3000`. |
| `VERCEL_PROJECT_PRODUCTION_URL` | No | Your production Vercel domain. Used to construct the WebAuthn origin when `VERCEL_URL` is not set. |
| `VERCEL_URL` | Auto | Set automatically by Vercel. Used as the WebAuthn origin in production. |
| `VERCEL` | Auto | Set to `1` by Vercel. The app checks this to decide whether to start its own HTTP server. |

**Minimal `.env` example:**

```
SESSION_SECRET=your_random_session_secret_here
STORAGE_MASTER_KEY=your_random_storage_master_key_here
FIREBASE_API_KEY=your_firebase_api_key
FIREBASE_AUTH_DOMAIN=your-project.firebaseapp.com
FIREBASE_DATABASE_URL=https://your-project-default-rtdb.firebaseio.com
WASABI_ACCESS_KEY_ID=your_wasabi_access_key
WASABI_SECRET_ACCESS_KEY=your_wasabi_secret_key
WASABI_BUCKET=your-bucket-name
UNIVERSAL_API_KEY=your_universal_api_key
RP_ID=localhost
ORIGIN=http://localhost:3000
NODE_ENV=development
```

> **Important:** Never commit real values of `SESSION_SECRET`, `STORAGE_MASTER_KEY`, `WASABI_SECRET_ACCESS_KEY`, or `UNIVERSAL_API_KEY` to version control. The `.env` file is in `.gitignore` and should stay that way.

---

## Installation

```bash
# Clone the repository
git clone https://github.com/Pawan947/ZeroVault.git
cd ZeroVault

# Install dependencies
npm install
```

---

## Running Locally

```bash
# Set up your .env file first (see Environment Variables above)
cp .env.example .env   # if an example exists, otherwise create .env manually
nano .env              # fill in your values

# Start the server
npm start
# or
node server.js
```

The server starts on `http://localhost:3000` by default.

For local WebAuthn testing, make sure `RP_ID=localhost` and `ORIGIN=http://localhost:3000` are set in your `.env`.

---

## Deployment on Vercel

ZeroVault is designed to run as a Vercel serverless function.

### Option 1: Vercel CLI

```bash
# Install Vercel CLI if you haven't
npm i -g vercel

# From the project root
vercel login
vercel
```

Follow the prompts. Vercel will detect `vercel.json` and configure the project as a Node.js serverless function.

### Option 2: Vercel Dashboard

1. Go to [vercel.com](https://vercel.com) and create a new project.
2. Import the GitHub repository `Pawan947/ZeroVault`.
3. In **Settings → Environment Variables**, add all the variables from the table above.
4. Deploy.

### Vercel-specific notes

- `vercel.json` configures the app as a serverless function entry point.
- When running on Vercel, `VERCEL=1` and `VERCEL_URL` are set automatically.
- The app uses `VERCEL_URL` to build the WebAuthn `origin` automatically, so you don't need to hardcode your domain.
- Set `VERCEL_PROJECT_PRODUCTION_URL` to your production domain (e.g. `zero-vault-s22z.vercel.app`) so the WebAuthn RP ID is correct even when `VERCEL_URL` points to a preview deployment.
- The server does **not** start its own HTTP listener when `VERCEL=1` — it exports the Express app for Vercel's runtime to invoke.

---

## Project Structure

```
ZeroVault/
├── server.js                  # Express app entry point, middleware, route mounting
├── vercel.json                # Vercel deployment configuration
├── package.json               # Dependencies and scripts
├── .env                       # Environment variables (gitignored)
├── .gitignore                 # Git ignore rules
├── eslint.config.mjs          # ESLint configuration
├── .vscode/launch.json       # VS Code debug configuration
│
├── config/
│   ├── aws.js                 # S3/Wasabi client and bucket config
│   ├── firebase.js            # Firebase app initialization (Auth + Realtime DB)
│   └── webauthn.js            # WebAuthn relying party configuration
│
├── middleware/
│   └── auth.js                # requireLogin, checkSharedAccess middleware
│
├── routes/
│   ├── auth.js                # Login, register, MFA, logout
│   ├── storage.js             # File browser, upload, download, share, delete
│   ├── webauthn.js            # WebAuthn registration and assertion endpoints
│   └── public.js              # Public/share link download routes
│
├── utils/
│   ├── cryptoHelpers.js       # AES-256-CTR stream cipher helpers, file key derivation
│   ├── s3Helpers.js           # S3 folder creation, file listing
│   ├── appHelpers.js          # User folder resolution, path parsing, expiry parsing
│   └── geo.js                 # Haversine distance calculation
│
├── views/                     # EJS templates
│   ├── index.ejs              # Main file browser
│   ├── login.ejs              # Login page
│   ├── register.ejs           # Registration page
│   ├── mfa.ejs                # WebAuthn MFA challenge page
│   ├── download.ejs           # Share link download page (geofence prompt)
│   ├── error.ejs              # Error page
│   ├── share-video.ejs       # Video sharing page
│   └── partials/             # Reusable template fragments
│       ├── head.ejs
│       ├── header.ejs
│       ├── sidebar.ejs
│       ├── modals.ejs
│       └── scripts.ejs
│
├── public/                    # Static assets
│   ├── cryptoWorker.js        # Web Worker for client-side crypto (if used)
│   └── webrtcShare.js         # WebRTC sharing helper (if used)
│
├── .github/
│   ├── dependabot.yml         # Dependabot configuration
│   └── workflows/
│       ├── ci.yml             # CI workflow
│       └── cd.yml             # CD workflow
│
└── documnetation.md           # Technical documentation (architecture deep-dive)
```

---

## Security Considerations

### Encryption

- File encryption keys are derived from `STORAGE_MASTER_KEY` using `crypto.scryptSync` with a fixed salt. The master key should be a high-entropy random string.
- Per-file keys (version 2 encryption) are derived via `HMAC-SHA256(MASTER_KEY, filePath)`, so each file has a unique key without needing to store key material separately.
- The default fallback values in `cryptoHelpers.js` and `server.js` (`"default_secret_key_123456"`, `"supersecret"`) are **only** used when the corresponding environment variables are missing. Do not deploy to production without setting `STORAGE_MASTER_KEY` and `SESSION_SECRET`.

### Firebase security

- Firebase Auth handles user credentials. The server never sees passwords — it only receives Firebase ID tokens indirectly via the session flow.
- Firebase Realtime Database rules should be configured to allow read/write only for authenticated users, and to restrict cross-user access to the `Access` and `links` paths as appropriate.
- The Firebase API key in `.env` is a client-side config value and is safe to expose in the EJS templates (it's already passed to the login/register pages for Firebase client SDK use).

### WebAuthn

- WebAuthn requires the origin to exactly match the browser's URL. If you deploy to a custom domain, update `ORIGIN` and `RP_ID` accordingly.
- For local development, use `http://localhost:3000`. WebAuthn works on localhost without HTTPS.

### Session security

- Sessions are stored in HTTP-only cookies with a 24-hour expiry.
- In production (`NODE_ENV=production`), the `secure` flag is set on the session cookie.

### Geofencing

- Geofence checks rely on `lat`/`lng` query parameters sent by the client. These can be spoofed by a malicious client. Geofencing is a convenience feature, not a strong security boundary. Don't rely on it alone to protect sensitive files.

---

## Environment Setup Checklist

Before deploying, confirm:

- [ ] Firebase project created with Auth (email/password) and Realtime Database enabled
- [ ] Realtime Database security rules configured for authenticated access
- [ ] S3-compatible bucket created (Wasabi or AWS S3)
- [ ] `SESSION_SECRET` set to a strong random value
- [ ] `STORAGE_MASTER_KEY` set to a strong random value (different from session secret)
- [ ] `WASABI_ACCESS_KEY_ID` and `WASABI_SECRET_ACCESS_KEY` are valid
- [ ] `WASABI_BUCKET` matches your bucket name
- [ ] `RP_ID` and `ORIGIN` match your deployment domain (or `localhost` for dev)
- [ ] `.env` is in `.gitignore` and never committed with real values

---

## Scripts

| Command | Description |
|---------|-------------|
| `npm start` | Start the server (`node server.js`) |
| `npm run dev` | Same as `npm start` (no hot reload configured) |
| `npm run lint` | Run ESLint across the project |
| `npm test` | Run Jest tests (currently no tests defined) |

---

## License

MIT License — see [LICENSE](LICENSE) for details.

---

## Author

Pawan Yadav ([@Pawan947](https://github.com/Pawan947))
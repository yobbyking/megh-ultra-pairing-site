# MEGH ULTRA XD — Pairing Site

Premium WhatsApp pairing site for the **MEGH ULTRA XD** bot. Generates phone-number pairing codes (no QR) using the **official `@whiskeysockets/baileys`** library with a **Chrome browser fingerprint**.

## Features
- **Cyberpunk neon UI** with animated matrix-rain background + glassmorphism
- **Phone-number based pairing** (no QR scanning required)
- **Official Baileys** — no forks, no patched versions, full WhatsApp compatibility
- **Chrome browser fingerprint** via `Browsers.appropriate('Chrome')`
- **SQLite-backed user store** (dp stored as base64 for performance)
- **Self-contained session IDs** — embed base64 credentials so the Pterodactyl bot needs no DB sync

## Deploy on Render

1. Push this folder to a GitHub repo.
2. On Render → New → Web Service → connect the repo.
3. Render will auto-detect `render.yaml` — confirm and deploy.
4. Render reads `engines.node` from `package.json` (pinned to `20.x`) — that's what guarantees `better-sqlite3` will install cleanly. **Do not override the Node version** in Render's dashboard.
5. Once live, the site is at `https://<your-service>.onrender.com`.

> Render's free tier may sleep on idle. For 24/7 pairing, consider the Starter plan ($7/mo).

## Why official Baileys?

The previous version used `mrxd-baileys` (a CJS-only fork with a hardcoded Baileys version). That version became stale and WhatsApp started rejecting it. The official `@whiskeysockets/baileys@^6.7.0` calls `fetchLatestBaileysVersion()` on every connect, so it always uses the version WhatsApp currently expects — no more 405 rejections.

## Local dev

```bash
cd pairing-site
npm install
npm start
# open http://localhost:3000
```

## API

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/api/pair` | POST | `{ phone: "254712345678" }` → returns `{ sessionCode, pairingCode }` |
| `/api/status/:sessionCode` | GET | Poll status (`pending`/`code_sent`/`linked`/`failed`) + session ID when ready |
| `/api/health` | GET | Health check |

## Session ID format

`megh-ultra:~<16-char-session-code>~<base64url-credentials>`

The Pterodactyl bot decodes this session ID and writes the credentials to `auth_state/` — no DB sync needed.

## License

MIT

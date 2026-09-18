# MEGH ULTRA XD — Pairing Site

Premium WhatsApp pairing site for the MEGH ULTRA XD bot. Generates pairing codes (no QR) using the official `@whiskeysockets/baileys` library.

## Features
- Cyberpunk neon UI with animated matrix-rain background + glassmorphism
- Phone-number based pairing (no QR scanning required)
- SQLite-backed user store (dp stored as base64 for performance)
- Self-contained session IDs — embed base64 credentials so the Pterodactyl bot needs no DB sync

## Deploy on Render

1. Push this folder to a GitHub repo (or use the included `create-repos.sh` from the parent package).
2. On Render → New → Web Service → connect the repo.
3. Render will auto-detect `render.yaml` — confirm and deploy.
4. Once live, the site is at `https://<your-service>.onrender.com`.

> Render's free tier may sleep on idle. For 24/7 pairing, consider the Starter plan ($7/mo).

## Local dev

```bash
cd pairing-site
npm install
npm start
# open http://localhost:3000
```

## Session ID format

```
megh-ultra:~<16-char code>~<base64url-encoded credentials>
```

The bot on Pterodactyl parses this string at startup, decodes the trailing base64 to recover the Baileys auth state, and connects without needing access to this site's database.

## API

| Endpoint | Method | Body | Returns |
|---|---|---|---|
| `/api/pair` | POST | `{ phone: "254712345678" }` | `{ ok, sessionCode, pairingCode, phone }` |
| `/api/status/:code` | GET | — | `{ ok, state, pairingCode?, sessionId? }` |
| `/api/health` | GET | — | `{ ok, ts, pending }` |

/**
 * MEGH MD — Pairing Site (Render-hosted)  [ESM — uses official @whiskeysockets/baileys]
 *
 * v2.0.1 — official Baileys is published as ESM-only, so this file is now
 *          ESM (package.json has "type": "module"). CJS deps like express,
 *          better-sqlite3, pino are imported via `import x from 'pkg'` which
 *          works fine from ESM.
 *
 * Pairing flow:
 *  1. fetchLatestBaileysVersion() — official Baileys REQUIRES this; without it
 *     WhatsApp will reject the connection with status 405 (bad version).
 *  2. createSock() — open the socket with Chrome browser fingerprint
 *  3. Wait for `connection.update` with `qr` field — Baileys' signal that WS is ready
 *  4. THEN call `requestPairingCode(phone)` — the code is actually pushed to WhatsApp
 *  5. User enters code on phone
 *  6. ★ WhatsApp sends new credentials → WS CLOSES (then must reconnect with new auth)
 *  7. createSock() is called again — reads fresh auth state from disk (with new creds)
 *  8. New socket fires `connection: 'open'` — we capture creds + build session ID
 *  9. Keep socket alive for 30s so WhatsApp's "Logging in..." fully completes
 */

'use strict';

import express from 'express';
import cors from 'cors';
import path from 'node:path';
import fs from 'node:fs';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import makeWASocket, {
  useMultiFileAuthState,
  DisconnectReason,
  fetchLatestBaileysVersion,
  makeCacheableSignalKeyStore,
  Browsers
} from '@whiskeysockets/baileys';
import P from 'pino';
import Database from 'better-sqlite3';

// __dirname is not defined in ESM — derive it from import.meta.url
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

const PORT = process.env.PORT || 3000;
const SESSION_TTL_MS = 10 * 60 * 1000;
const logger = P({ level: 'warn' }, P.destination({ sync: true }));

// ── SQLite ───────────────────────────────────────────────────────────
fs.mkdirSync(path.join(__dirname, 'data'), { recursive: true });
const db = new Database(path.join(__dirname, 'data', 'pairing.db'));
db.pragma('journal_mode = WAL');
db.exec(`
  CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    phone TEXT NOT NULL UNIQUE,
    jid TEXT,
    name TEXT,
    dp_base64 TEXT,
    session_code TEXT UNIQUE,
    session_id TEXT,
    created_at INTEGER,
    last_seen INTEGER
  );
  CREATE INDEX IF NOT EXISTS idx_users_session_code ON users(session_code);
`);

const insertUserStmt = db.prepare(`
  INSERT OR REPLACE INTO users (phone, jid, name, dp_base64, session_code, session_id, created_at, last_seen)
  VALUES (@phone, @jid, @name, @dp_base64, @session_code, @session_id, @created_at, @last_seen)
`);

// ─── In-memory map of pending pairing sessions ──────────────────────
const pendingSessions = new Map();

// ─── Helpers ────────────────────────────────────────────────────────
function normalizePhone(input) {
  if (!input) return null;
  let p = String(input).replace(/[^\d]/g, '');
  if (!p) return null;
  if (p.length > 10 && p.startsWith('0')) p = p.slice(1);
  if (!/^\d{8,15}$/.test(p)) return null;
  return p;
}

function randomSessionCode() {
  return crypto.randomBytes(12).toString('base64url').slice(0, 16);
}

function buildSessionId(sessionCode, credsBase64) {
  return `megh-ultra:~${sessionCode}~${credsBase64}`;
}

function encodeCreds(state) {
  const json = JSON.stringify({
    creds: state.creds,
    keys: state.keys ? Array.from(state.keys.entries()) : []
  });
  return Buffer.from(json, 'utf8').toString('base64url');
}

async function downloadDpBase64(sock, jid) {
  try {
    const url = await Promise.race([
      sock.profilePictureUrl(jid, 'image'),
      new Promise((_, rej) => setTimeout(() => rej(new Error('profilePictureUrl timeout')), 5000))
    ]);
    if (!url) return null;
    const res = await Promise.race([
      fetch(url),
      new Promise((_, rej) => setTimeout(() => rej(new Error('fetch DP timeout')), 5000))
    ]);
    if (!res.ok) return null;
    const buf = Buffer.from(await res.arrayBuffer());
    return buf.toString('base64');
  } catch (e) {
    console.log(`  DP fetch skipped: ${e.message}`);
    return null;
  }
}

// ─── ★ createSock() — extracted so we can RECONNECT on close ─────────
async function createSock(sessionCode, phone, sessionFolder, entry) {
  // ★ Official Baileys REQUIRES fetchLatestBaileysVersion() — without it,
  //    WhatsApp will reject the connection with status 405 (bad version).
  const { version, isLatest } = await fetchLatestBaileysVersion();
  console.log(`[${sessionCode}] createSock — Baileys v${version.join('.')} (latest: ${isLatest})`);

  // ★ Re-read auth state from disk EVERY time createSock is called
  const { state, saveCreds } = await useMultiFileAuthState(sessionFolder);

  // ★ Chrome browser fingerprint — Browsers.appropriate('Chrome') returns
  //    ['Ubuntu', 'Chrome', '<kernel>'] which is what WhatsApp Web users see.
  const browserConfig = Browsers.appropriate('Chrome');
  console.log(`[${sessionCode}] createSock — browser: ${JSON.stringify(browserConfig)}`);

  const sock = makeWASocket({
    version,
    auth: {
      creds: state.creds,
      keys: makeCacheableSignalKeyStore(state.keys, logger)
    },
    printQRInTerminal: false,
    logger,
    browser: browserConfig,
    defaultQueryTimeoutMs: 120000,
    connectTimeoutMs: 120000,
    qrTimeout: 120000,
    keepAliveIntervalMs: 30000,
    retryRequestDelayMs: 2000,
    generateHighQualityLinkPreview: false,
    shouldIgnoreJid: () => false,
    markOnlineOnConnect: false,
    syncFullHistory: false,
    linkPreview: false,
    getMessage: async () => undefined
  });

  entry.sock = sock;

  // ─── Event handlers ────────────────────────────────────────────────
  sock.ev.on('creds.update', () => {
    console.log(`[${sessionCode}] 🔑 creds.update (saving to disk)`);
    saveCreds();
  });

  sock.ev.on('messages.upsert', ({ messages, type }) => {
    if (!messages || !messages.length) return;
    for (const m of messages) {
      const t = m.message ? Object.keys(m.message)[0] : 'unknown';
      console.log(`[${sessionCode}] 📨 msg.recv type=${type} | msg.type=${t} from=${m.key?.remoteJid}`);
    }
  });

  sock.ev.on('connection.update', async (update) => {
    const { connection, lastDisconnect, qr, receivedPendingNotifications, pairingCode: pc } = update;
    console.log(`[${sessionCode}] connection.update:`, JSON.stringify({
      connection,
      statusCode: lastDisconnect?.error?.output?.statusCode,
      hasQr: !!qr,
      receivedPendingNotifications,
      pairingCode: pc || null
    }));

    if (pc) {
      entry.pairingCode = pc;
      if (entry.state === 'pending') entry.state = 'code_sent';
      console.log(`[${sessionCode}] Pairing code from event: ${pc}`);
    }

    if (connection === 'open') {
      console.log(`[${sessionCode}] 🟢 Connection OPEN — waiting 3s for creds to fully save…`);
      await new Promise(r => setTimeout(r, 3000));
      console.log(`[${sessionCode}] Capturing creds now…`);
      try {
        // ★ Re-read fresh auth state from disk — the `state` variable in
        //    this closure was captured at createSock() time, which was
        //    before the new creds were saved. Re-read so we capture the
        //    full creds that were just written by creds.update.
        const freshState = await useMultiFileAuthState(sessionFolder);
        const credsBase64 = encodeCreds(freshState.state);
        const sessionId = buildSessionId(sessionCode, credsBase64);
        const jid = sock.user?.id || freshState.state.creds?.me?.id;
        const ownerName = sock.user?.name || sock.user?.notify || (jid ? jid.split(':')[0] : 'Owner');
        console.log(`[${sessionCode}] ✓ jid=${jid}, ownerName=${ownerName}, creds size=${credsBase64.length} chars`);

        const dpBase64 = jid ? await downloadDpBase64(sock, jid) : null;
        console.log(`[${sessionCode}] DP fetch: ${dpBase64 ? '✓ got' : 'null (no DP)'}`);

        insertUserStmt.run({
          phone,
          jid: jid || null,
          name: ownerName,
          dp_base64: dpBase64,
          session_code: sessionCode,
          session_id: sessionId,
          created_at: Date.now(),
          last_seen: Date.now()
        });

        entry.state = 'linked';
        entry.creds = { sessionId, dpBase64, jid };
        console.log(`[${sessionCode}] ✓✓ Linked — session ID ready`);
        console.log(`[${sessionCode}] User can copy the session ID from the website now`);

        // ★ Send the 3 owner messages: session ID + linked confirmation
        //   Then log out so the pairing socket goes offline (the panel bot
        //   will use the saved creds to reconnect later).
        if (jid) {
          try {
            console.log(`[${sessionCode}] → Sending owner message 1: "Generation session....."`);
            await sock.sendMessage(jid, { text: 'Generation session.....' });
            await new Promise(r => setTimeout(r, 800));

            console.log(`[${sessionCode}] → Sending owner message 2: session ID`);
            await sock.sendMessage(jid, { text: sessionId });
            await new Promise(r => setTimeout(r, 800));

            console.log(`[${sessionCode}] → Sending owner message 3: 🟢 Session Linked`);
            await sock.sendMessage(jid, {
              text: `🟢 Session Linked\n\n🟢 Paste it as SESSION_ID during deploy or use auto enter on panel.\n🟢 Support: ${process.env.SUPPORT_URL || 'https://wa.me/message/25495314221'}`
            });
            console.log(`[${sessionCode}] ✓ 3 owner messages sent`);
          } catch (e) {
            console.error(`[${sessionCode}] ✗ Failed to send owner messages:`, e.message);
          }
        }

        // ★ Log out so the pairing socket goes offline — the panel bot
        //   will use the saved creds to reconnect when deployed.
        console.log(`[${sessionCode}] → Logging out pairing socket (going offline)…`);
        setTimeout(async () => {
          try { await sock.logout(); } catch {}
          teardownSession(sessionCode);
          console.log(`[${sessionCode}] ✓ Pairing socket offline. Pairing complete.`);
        }, 5000);
      } catch (e) {
        console.error(`[${sessionCode}] ✗ Failed to capture creds:`, e);
        entry.state = 'failed';
      }
    }

    if (connection === 'close') {
      const statusCode = lastDisconnect?.error?.output?.statusCode;
      console.log(`[${sessionCode}] ❌ Closed — code=${statusCode}, state=${entry.state}`);

      if (entry.state === 'linked') return;

      if (statusCode === DisconnectReason.loggedOut || statusCode === 410) {
        console.log(`[${sessionCode}] ✗ Logged out / 410 — not retrying`);
        entry.state = 'failed';
        return;
      }

      // ★ Reconnect with fresh auth state — picks up new creds from disk
      console.log(`[${sessionCode}] ↻ Reconnecting in 3s (createSock with fresh auth state)…`);

      try {
        sock.ev.removeAllListeners('messages.upsert');
        sock.ev.removeAllListeners('connection.update');
        sock.ev.removeAllListeners('creds.update');
      } catch {}

      setTimeout(async () => {
        try {
          await createSock(sessionCode, phone, sessionFolder, entry);
          console.log(`[${sessionCode}] ✅ Reconnected — waiting for new socket to fire 'open'`);
        } catch (e) {
          console.error(`[${sessionCode}] Reconnect failed:`, e.message);
          entry.state = 'failed';
        }
      }, 3000);
    }
  });

  return sock;
}

// ─── Start a pairing session ─────────────────────────────────────────
async function startPairingSession(phone) {
  const sessionCode = randomSessionCode();
  const sessionFolder = path.join(__dirname, 'data', 'auth', sessionCode);
  fs.mkdirSync(sessionFolder, { recursive: true });

  console.log(`[${sessionCode}] Pairing phone: +${phone}`);

  const entry = {
    sock: null,
    phone,
    pairingCode: null,
    state: 'pending',
    sessionFolder,
    startedAt: Date.now(),
    creds: null
  };
  pendingSessions.set(sessionCode, entry);

  // ★ Create initial socket with retries
  let sock;
  let lastError = null;
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      sock = await createSock(sessionCode, phone, sessionFolder, entry);
      break;
    } catch (e) {
      lastError = e;
      if (attempt < 3) {
        console.log(`[${sessionCode}] Attempt ${attempt} failed: ${e.message}. Retrying in 10s…`);
        await new Promise(r => setTimeout(r, 10000));
      }
    }
  }
  if (!sock) {
    throw new Error(`Could not connect to WhatsApp after 3 attempts. Last error: ${lastError?.message || 'unknown'}. This is usually a temporary rate-limit — wait 15-30 minutes and try again.`);
  }

  // ─── ★ Wait for the QR event before requesting pairing code ────────
  await new Promise((resolve, reject) => {
    let resolved = false;
    const timeout = setTimeout(() => {
      if (!resolved) {
        resolved = true;
        reject(new Error('Socket connection timeout after 45s. WhatsApp may be rate-limiting or blocking the connection.'));
      }
    }, 45000);

    const handler = (update) => {
      const { connection, qr, lastDisconnect } = update;
      if (qr && !resolved) {
        resolved = true;
        clearTimeout(timeout);
        sock.ev.off('connection.update', handler);
        console.log(`[${sessionCode}] ✓ QR event received — socket ready for pairing code`);
        resolve();
      } else if (connection === 'open' && !resolved) {
        resolved = true;
        clearTimeout(timeout);
        sock.ev.off('connection.update', handler);
        console.log(`[${sessionCode}] ✓ Connection open — ready`);
        resolve();
      } else if (connection === 'close' && !resolved) {
        resolved = true;
        clearTimeout(timeout);
        sock.ev.off('connection.update', handler);
        const statusCode = lastDisconnect?.error?.output?.statusCode;
        if (statusCode === 405 || statusCode === 419) {
          reject(new Error(
            `WhatsApp rejected the connection (status ${statusCode}). ` +
            `This is usually a temporary rate-limit. ` +
            `Wait 15-30 minutes, try a different phone number, or use a different host.`
          ));
        } else {
          reject(new Error(`Connection closed (status ${statusCode}). WhatsApp rejected the connection.`));
        }
      }
    };
    sock.ev.on('connection.update', handler);
  }).catch(e => {
    throw new Error(`Failed to connect to WhatsApp: ${e.message}`);
  });

  // ─── ★ Now request the pairing code — socket is fully ready ───────
  let code;
  try {
    console.log(`[${sessionCode}] → Calling sock.requestPairingCode("${phone}")`);
    code = await sock.requestPairingCode(phone);
    console.log(`[${sessionCode}] ← WhatsApp returned pairing code: ${code}`);
  } catch (e) {
    console.error(`[${sessionCode}] ✗ requestPairingCode failed:`, e.message);
    try { await sock.logout(); } catch {}
    throw new Error(`Failed to get pairing code from WhatsApp: ${e.message}`);
  }

  if (!code || code.length < 4) {
    try { await sock.logout(); } catch {}
    throw new Error('WhatsApp returned an invalid pairing code. Please try again.');
  }

  entry.pairingCode = code;
  if (entry.state === 'pending') entry.state = 'code_sent';
  console.log(`[${sessionCode}] ✓ Pair request sent to WhatsApp servers for +${phone}`);
  console.log(`[${sessionCode}] User should now see "Link with phone number" prompt in WhatsApp → Settings → Linked Devices`);

  return { sessionCode, pairingCode: code };
}

async function teardownSession(sessionCode) {
  const entry = pendingSessions.get(sessionCode);
  if (!entry) return;
  try { await entry.sock?.logout(); } catch {}
  try { await entry.sock?.end(new Error('pairing-complete')); } catch {}
  pendingSessions.delete(sessionCode);
  try { fs.rmSync(entry.sessionFolder, { recursive: true, force: true }); } catch {}
}

setInterval(() => {
  const now = Date.now();
  for (const [code, entry] of pendingSessions.entries()) {
    if (now - entry.startedAt > SESSION_TTL_MS && entry.state !== 'linked') {
      console.log(`[${code}] Session timed out — cleaning up`);
      teardownSession(code).catch(()=>{});
    }
  }
}, 60 * 1000);

// ─── API Routes ─────────────────────────────────────────────────────

app.post('/api/pair', async (req, res) => {
  const phone = normalizePhone(req.body?.phone);
  if (!phone) {
    return res.status(400).json({
      ok: false,
      error: 'Invalid phone number. Use digits only with country code. Example: 254712345678 (no +, no spaces, no leading 0).'
    });
  }

  try {
    const { sessionCode, pairingCode } = await startPairingSession(phone);
    return res.json({
      ok: true,
      sessionCode,
      pairingCode: pairingCode ? `${pairingCode.slice(0,4)}-${pairingCode.slice(4)}` : null,
      phone
    });
  } catch (e) {
    console.error('[/api/pair] Error:', e.message);
    return res.status(500).json({ ok: false, error: e.message || 'Pairing failed' });
  }
});

app.get('/api/status/:sessionCode', (req, res) => {
  const entry = pendingSessions.get(req.params.sessionCode);
  if (!entry) {
    const row = db.prepare(`SELECT * FROM users WHERE session_code = ?`).get(req.params.sessionCode);
    if (row) {
      return res.json({
        ok: true,
        state: 'linked',
        sessionId: row.session_id,
        jid: row.jid,
        hasDp: !!row.dp_base64
      });
    }
    return res.status(404).json({ ok: false, error: 'Session not found or timed out. Please generate a new code.' });
  }
  return res.json({
    ok: true,
    state: entry.state,
    pairingCode: entry.pairingCode
      ? `${entry.pairingCode.slice(0,4)}-${entry.pairingCode.slice(4)}`
      : null,
    phone: entry.phone,
    sessionId: entry.creds?.sessionId || null
  });
});

app.get('/api/health', (req, res) => {
  res.json({ ok: true, ts: Date.now(), pending: pendingSessions.size });
});

app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.listen(PORT, '0.0.0.0', () => {
  console.log(`╔══════════════════════════════════════════════╗`);
  console.log(`║   MEGH MD — Pairing Site v2.0.1 (ESM, official Baileys) ║`);
  console.log(`╚══════════════════════════════════════════════╝`);
  console.log(`\nMEGH MD pairing site live on :${PORT}`);
  console.log(`Package: @whiskeysockets/baileys (official ESM)`);
  console.log(`Browser: ${JSON.stringify(Browsers.appropriate('Chrome'))}`);
  console.log(`Socket: keepAlive=30s, connectTimeout=120s, qrTimeout=120s, reconnect on close=ON\n`);
});

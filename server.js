/**
 * MEGH MD — Pairing Site (Render-hosted)  [CommonJS — uses official @whiskeysockets/baileys]
 *
 * v2.0 — switched from the mrxd-baileys fork to the official Baileys package
 *        so we get full WhatsApp compatibility + ongoing updates.
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
 *
 * Critical socket options:
 *  - keepAliveIntervalMs: 30000 (ping every 30s so Render doesn't kill WS)
 *  - connectTimeoutMs / qrTimeout: 120000 (2 min)
 *  - makeCacheableSignalKeyStore for keys
 *  - Browsers.appropriate('Chrome') for correct Chrome device identity
 */

'use strict';

const express = require('express');
const cors = require('cors');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const {
  default: makeWASocket,
  useMultiFileAuthState,
  DisconnectReason,
  fetchLatestBaileysVersion,
  makeCacheableSignalKeyStore,
  Browsers
} = require('@whiskeysockets/baileys');
const P = require('pino');
const Database = require('better-sqlite3');

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
//    Each call reads the FRESH auth state from disk. After WhatsApp sends
//    new credentials during pairing, the WS closes. We call createSock()
//    again, which re-reads the auth state (now containing the new creds)
//    and creates a new socket. The new socket fires connection: 'open'
//    with full auth — that's when we capture creds.
async function createSock(sessionCode, phone, sessionFolder, entry) {
  // ★ Official Baileys REQUIRES fetchLatestBaileysVersion() — without it,
  //    WhatsApp will reject the connection with status 405 (bad version).
  //    The old mrxd-baileys fork had a hardcoded version; the official
  //    package fetches it dynamically from WhatsApp's servers.
  const { version, isLatest } = await fetchLatestBaileysVersion();
  console.log(`[${sessionCode}] createSock — Baileys v${version.join('.')} (latest: ${isLatest})`);

  // ★ Re-read auth state from disk EVERY time createSock is called
  //    This picks up credentials saved by previous socket instances.
  const { state, saveCreds } = await useMultiFileAuthState(sessionFolder);

  // ★ Chrome browser fingerprint — Browsers.appropriate('Chrome') returns
  //    ['Ubuntu', 'Chrome', '20.04.4'] (or similar), which is what WhatsApp
  //    expects for a normal WhatsApp Web session. This avoids the bot-detection
  //    flag that using a custom name would trigger.
  const browserConfig = Browsers.appropriate('Chrome');
  console.log(`[${sessionCode}] createSock — browser: ${JSON.stringify(browserConfig)}`);

  const sock = makeWASocket({
    version, // ★ Required by official Baileys
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
    keepAliveIntervalMs: 30000, // ★ ping every 30s — keeps WS alive on Render
    retryRequestDelayMs: 2000,
    generateHighQualityLinkPreview: false,
    shouldIgnoreJid: () => false,
    markOnlineOnConnect: false,
    syncFullHistory: false,
    linkPreview: false,
    getMessage: async () => undefined
  });

  // Update entry with new socket
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
        const credsBase64 = encodeCreds(state);
        const sessionId = buildSessionId(sessionCode, credsBase64);
        const jid = sock.user?.id || state.creds?.me?.id;
        console.log(`[${sessionCode}] ✓ jid=${jid}, creds size=${credsBase64.length} chars`);

        const dpBase64 = jid ? await downloadDpBase64(sock, jid) : null;
        console.log(`[${sessionCode}] DP fetch: ${dpBase64 ? '✓ got' : 'null (no DP)'}`);

        insertUserStmt.run({
          phone,
          jid: jid || null,
          name: null,
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

        // Keep socket alive for 30s so WhatsApp's "Logging in..." completes
        setTimeout(() => teardownSession(sessionCode), 30000);
      } catch (e) {
        console.error(`[${sessionCode}] ✗ Failed to capture creds:`, e);
        entry.state = 'failed';
      }
    }

    if (connection === 'close') {
      const statusCode = lastDisconnect?.error?.output?.statusCode;
      console.log(`[${sessionCode}] ❌ Closed — code=${statusCode}, state=${entry.state}`);

      if (entry.state === 'linked') return; // already done, will be torn down

      if (statusCode === DisconnectReason.loggedOut || statusCode === 410) {
        console.log(`[${sessionCode}] ✗ Logged out / 410 — not retrying`);
        entry.state = 'failed';
        return;
      }

      // ★ THIS IS THE CRITICAL FIX: When the WS closes during pairing
      //    (because WhatsApp sent new credentials and the socket must
      //    reconnect), we create a NEW socket using the same auth folder.
      //    The new socket will read the freshly-saved credentials from
      //    disk, connect with full auth, and fire connection: 'open'.
      //    That's when we capture creds and build the session ID.
      console.log(`[${sessionCode}] ↻ Reconnecting in 3s (createSock with fresh auth state)…`);

      // Clean up old listeners to prevent duplicates on the new socket
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
    sock: null, // will be set by createSock
    phone,
    pairingCode: null,
    state: 'pending',
    sessionFolder,
    startedAt: Date.now(),
    creds: null
  };
  pendingSessions.set(sessionCode, entry);

  // ★ Create initial socket (registers all event handlers)
  //    Retry up to 3 times on transient errors (network/rate-limit).
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
  // The QR event signals the socket is fully open + ready to receive commands.
  // We don't actually use the QR — we use the pairing code instead — but
  // waiting for the QR event is the safest signal that the WS is ready.
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
        // 405 = Method Not Allowed — usually means Baileys version mismatch
        // 419 = rate-limited — too many pairing attempts
        // 401/403 = unauthorized — auth state is invalid
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

  // ★ The old mrxd-baileys fork had a `sock.wsReady` property that we polled
  //   for extra safety. The official Baileys package does NOT have this —
  //   the `qr` event above is the correct readiness signal. We skip the
  //   wsReady check here.

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
  console.log(`║   MEGH MD — Pairing Site v2.0 (official Baileys) ║`);
  console.log(`╚══════════════════════════════════════════════╝`);
  console.log(`\nMEGH MD pairing site live on :${PORT}`);
  console.log(`Package: @whiskeysockets/baileys (official)`);
  console.log(`Browser: ${JSON.stringify(Browsers.appropriate('Chrome'))}`);
  console.log(`Socket: keepAlive=30s, connectTimeout=120s, qrTimeout=120s, reconnect on close=ON\n`);
});

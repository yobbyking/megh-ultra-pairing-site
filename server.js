/**
 * MEGH MD — Pairing Site (Render-hosted)  [CommonJS — matches YOBBY MD pattern]
 *
 * Uses @whiskeysockets/baileys@^6.6.0 which is CommonJS-compatible (no ESM issues).
 *
 * Critical socket options (learned from YOBBY MD's working implementation):
 *  - keepAliveIntervalMs: 30000   (ping WhatsApp every 30s so Render doesn't kill the WS)
 *  - connectTimeoutMs / qrTimeout: 120000
 *  - makeCacheableSignalKeyStore for the keys (faster key lookups during handshake)
 *  - Browsers.appropriate('Chrome') for correct device identity
 *
 * Pairing flow (matches YOBBY MD):
 *  1. Create socket with auth state
 *  2. Wait for `connection.update` with `qr` field (means WS is ready)
 *  3. Also wait for `sock.wsReady === true` (extra safety)
 *  4. THEN call `requestPairingCode(phone)` — the code is actually pushed to WhatsApp
 *  5. User enters code on phone → connection.update fires with `state: 'open'`
 *  6. Wait 3s for all creds.update events to flush
 *  7. Encode creds → session ID → return to user
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
  let p = String(input).replace(/[^\d]/g, ''); // digits only
  if (!p) return null;
  // Strip one leading 0 (e.g., "0712345678" → "712345678") — but ONLY if
  // there's still enough digits after (i.e. user provided a country code).
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
  // 5-second timeout — never hangs the link flow
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

// ─── Start a temporary Baileys socket for pairing ───────────────────
async function startPairingSession(phone) {
  const sessionCode = randomSessionCode();
  const sessionFolder = path.join(__dirname, 'data', 'auth', sessionCode);
  fs.mkdirSync(sessionFolder, { recursive: true });

  const { version, isLatest } = await fetchLatestBaileysVersion();
  console.log(`[${sessionCode}] Using Baileys v${version.join('.')}${isLatest ? ' (latest)' : ''}`);

  const { state, saveCreds } = await useMultiFileAuthState(sessionFolder);

  const browserConfig = Browsers.appropriate('Chrome');
  console.log(`[${sessionCode}] Browser identity: ${JSON.stringify(browserConfig)}`);
  console.log(`[${sessionCode}] Pairing phone: +${phone}`);

  // ★ Match YOBBY MD's socket options — these are critical for the link to complete.
  //    - keepAliveIntervalMs: 30000 → ping WhatsApp every 30s so Render doesn't kill the WS
  //    - connectTimeoutMs / qrTimeout: 120000 → 2 min timeouts
  //    - makeCacheableSignalKeyStore for keys (faster handshake)
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
    generateHighQualityLinkPreview: true,
    shouldIgnoreJid: () => false,
    markOnlineOnConnect: false,
    syncFullHistory: false,
    linkPreview: false,
    getMessage: async () => undefined
  });

  const entry = {
    sock,
    phone,
    pairingCode: null,
    state: 'pending',
    sessionFolder,
    startedAt: Date.now(),
    creds: null
  };
  pendingSessions.set(sessionCode, entry);

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
    const { connection, lastDisconnect, qr, receivedPendingNotifications } = update;
    console.log(`[${sessionCode}] connection.update:`, JSON.stringify({
      connection,
      statusCode: lastDisconnect?.error?.output?.statusCode,
      hasQr: !!qr,
      receivedPendingNotifications
    }));

    // Baileys emits `pairingCode` in some versions via connection.update
    if (update.pairingCode) {
      entry.pairingCode = update.pairingCode;
      entry.state = 'code_sent';
      console.log(`[${sessionCode}] Pairing code from event: ${update.pairingCode}`);
    }

    if (connection === 'open') {
      console.log(`[${sessionCode}] 🟢 Connection OPEN — sending WhatsApp messages to user's phone…`);

      // Wait briefly for socket + creds to settle
      await new Promise(r => setTimeout(r, 1500));

      try {
        const jid = sock.user?.id;
        const userName = sock.user?.name || sock.user?.verifiedName || 'Owner';
        console.log(`[${sessionCode}] User: ${jid} (${userName})`);

        // ─────────────────────────────────────────────────────────────
        // MESSAGE 1: "Generation session....."
        // ─────────────────────────────────────────────────────────────
        try {
          await sock.sendMessage(jid, { text: 'Generation session.....' });
          console.log(`[${sessionCode}] ✓ Sent message 1: "Generation session....."`);
        } catch (e) {
          console.warn(`[${sessionCode}] Failed to send msg 1:`, e.message);
        }

        // Small delay so the user can read it
        await new Promise(r => setTimeout(r, 1500));

        // Build the session ID now
        const credsBase64 = encodeCreds(state);
        const sessionId = buildSessionId(sessionCode, credsBase64);
        console.log(`[${sessionCode}] ✓ Built session ID (size=${credsBase64.length} chars)`);

        // ─────────────────────────────────────────────────────────────
        // MESSAGE 2: just the session ID itself
        // e.g. megh-ultra:~3MWb2cme0eXWQlxR
        // ─────────────────────────────────────────────────────────────
        try {
          await sock.sendMessage(jid, { text: sessionId });
          console.log(`[${sessionCode}] ✓ Sent message 2 (session ID)`);
        } catch (e) {
          console.warn(`[${sessionCode}] Failed to send msg 2:`, e.message);
        }

        // Another small delay
        await new Promise(r => setTimeout(r, 1000));

        // ─────────────────────────────────────────────────────────────
        // MESSAGE 3: "🟢 Session Linked" + deploy instructions + support
        // ─────────────────────────────────────────────────────────────
        const msg3 = `🟢 Session Linked\n\n🟢 Paste it as SESSION_ID during deploy or use auto enter on panel.\n🟢 Support: https://wa.me/message/25495314221`;
        try {
          await sock.sendMessage(jid, { text: msg3 });
          console.log(`[${sessionCode}] ✓ Sent message 3 (Session Linked)`);
        } catch (e) {
          console.warn(`[${sessionCode}] Failed to send msg 3:`, e.message);
        }

        // Save to DB so the website can still show the session ID
        const dpBase64 = jid ? await downloadDpBase64(sock, jid) : null;
        insertUserStmt.run({
          phone,
          jid: jid || null,
          name: userName,
          dp_base64: dpBase64,
          session_code: sessionCode,
          session_id: sessionId,
          created_at: Date.now(),
          last_seen: Date.now()
        });

        entry.state = 'linked';
        entry.creds = { sessionId, dpBase64, jid, userName };
        console.log(`[${sessionCode}] ✓✓ Linked — session ID sent to user's WhatsApp`);
        console.log(`[${sessionCode}] Socket going offline now — bot will activate when deployed on Pterodactyl`);

        // Disconnect after a short delay so the messages are delivered
        // (matches the user's spec: "once it has done all bot goes offline")
        setTimeout(() => teardownSession(sessionCode), 5000);
      } catch (e) {
        console.error(`[${sessionCode}] ✗ Failed to send WhatsApp messages:`, e);
        entry.state = 'failed';
      }
    }

    if (connection === 'close') {
      const statusCode = lastDisconnect?.error?.output?.statusCode;
      console.log(`[${sessionCode}] ❌ Closed — code=${statusCode}, state=${entry.state}`);

      if (entry.state === 'linked') return; // already done, will be torn down

      // If we already have a pairing code, don't restart — would invalidate the code
      if (entry.state === 'code_sent' || entry.pairingCode) {
        console.log(`[${sessionCode}] Preserving pairing code (not restarting). User can still enter the code on their phone.`);
        return;
      }

      if (statusCode === DisconnectReason.loggedOut || statusCode === 410) {
        entry.state = 'failed';
        return;
      }

      if (entry.state === 'pending') {
        console.log(`[${sessionCode}] Connection closed (${statusCode}). Not auto-restarting — user can retry.`);
        entry.state = 'failed';
      }
    }
  });

  // ─── ★ Wait for the QR event before requesting pairing code ────────
  // (matches YOBBY MD pattern — the QR event signals the socket is fully open)
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
      // ★ QR event = socket ready to receive pairing code request
      if (qr && !resolved) {
        resolved = true;
        clearTimeout(timeout);
        sock.ev.off('connection.update', handler);
        console.log(`[${sessionCode}] ✓ QR event received — socket ready for pairing code`);
        resolve();
      } else if (connection === 'open' && !resolved) {
        // Already open (existing auth) — also ready
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
        reject(new Error(`Connection closed (status ${statusCode}). WhatsApp rejected the connection.`));
      }
    };
    sock.ev.on('connection.update', handler);
  }).catch(e => {
    throw new Error(`Failed to connect to WhatsApp: ${e.message}`);
  });

  // ─── ★ Extra safety: wait for sock.wsReady === true (like YOBBY MD) ─
  let waited = 0;
  while (!sock.wsReady && waited < 10) {
    await new Promise(r => setTimeout(r, 500));
    waited++;
  }
  if (!sock.wsReady) {
    console.warn(`[${sessionCode}] wsReady not set after ${waited * 500}ms — proceeding anyway`);
  } else {
    console.log(`[${sessionCode}] ✓ Socket wsReady=true (WhatsApp connection confirmed)`);
  }

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
  console.log(`║   MEGH MD — Pairing Site v1.1  (Baileys 6.6)  ║`);
  console.log(`╚══════════════════════════════════════════════╝`);
  console.log(`\nMEGH MD pairing site live on :${PORT}`);
  console.log(`Browser: ${JSON.stringify(Browsers.appropriate('Chrome'))}`);
  console.log(`Socket options: keepAliveIntervalMs=30000, connectTimeoutMs=120000, qrTimeout=120000\n`);
});

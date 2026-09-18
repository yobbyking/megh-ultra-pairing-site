/**
 * MEGH ULTRA XD — Pairing Site (Render-hosted)  [ESM version]
 * Uses official @whiskeysockets/baileys (ESM-only).
 *
 * Key fixes:
 *  - Browser config uses correct Chrome+MacOS identity (was malformed)
 *  - Pairing code is requested AFTER ws is open (uses ev queue)
 *  - Socket does NOT auto-restart once code is generated (would invalidate the code)
 *  - Phone validation requires country code
 */

import express from 'express';
import cors from 'cors';
import path from 'path';
import fs from 'fs';
import crypto from 'crypto';
import { fileURLToPath } from 'url';
import makeWASocket, {
  useMultiFileAuthState,
  DisconnectReason,
  fetchLatestBaileysVersion
} from '@whiskeysockets/baileys';
import P from 'pino';
import Database from 'better-sqlite3';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

const PORT = process.env.PORT || 3000;
const SESSION_TTL_MS = 8 * 60 * 1000; // 8 min to complete pairing
const logger = P({ level: 'warn' });

// ── SQLite (users dp + session metadata) ────────────────────────────
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
/**
 * @type {Map<string, {
 *   sock: any,
 *   phone: string,
 *   pairingCode: string|null,
 *   state: 'pending'|'code_sent'|'linked'|'failed',
 *   sessionFolder: string,
 *   startedAt: number,
 *   resolve?: Function,
 *   reject?: Function,
 *   creds?: any
 * }>}
 */
const pendingSessions = new Map();

// ─── Helpers ────────────────────────────────────────────────────────
function normalizePhone(phone) {
  let p = (phone || '').toString().replace(/\D/g, '');
  if (p.startsWith('00')) p = p.slice(2);
  // WhatsApp needs the country code — minimum 8 digits total
  return p || null;
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
    const url = await sock.profilePictureUrl(jid, 'image');
    if (!url) return null;
    const res = await fetch(url);
    if (!res.ok) return null;
    const buf = Buffer.from(await res.arrayBuffer());
    return buf.toString('base64');
  } catch { return null; }
}

// ─── Start a temporary Baileys socket for pairing ───────────────────
async function startPairingSession(phone) {
  const sessionCode = randomSessionCode();
  const sessionFolder = path.join(__dirname, 'data', 'auth', sessionCode);
  fs.mkdirSync(sessionFolder, { recursive: true });

  const { state, saveCreds } = await useMultiFileAuthState(sessionFolder);
  const { version } = await fetchLatestBaileysVersion();

  // ✅ Correct Baileys browser format: [appName, browserType, OS]
  //    - 'MEGH ULTRA XD' = our app name
  //    - 'Chrome' = we impersonate Chrome browser (per user request)
  //    - 'MacOS' = the OS we claim to run on
  const browserConfig = ['MEGH ULTRA XD', 'Chrome', 'MacOS'];

  const sock = makeWASocket({
    version,
    auth: state,
    printQRInTerminal: false,
    logger,
    browser: browserConfig,
    generateHighQualityLinkPreview: true,
    shouldIgnoreJid: () => false,
    markOnlineOnConnect: false,
    syncFullHistory: false,
    getMessage: async () => undefined
  });

  sock.ev.on('messages.upsert', () => {});
  sock.ev.on('creds.update', saveCreds);

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

  // Connection lifecycle
  sock.ev.on('connection.update', async (update) => {
    const { connection, lastDisconnect, pairingCode: pc } = update;

    // Some Baileys versions emit pairingCode via connection.update
    if (pc) {
      entry.pairingCode = pc;
      entry.state = 'code_sent';
      console.log(`[${sessionCode}] Pairing code generated: ${pc}`);
    }

    if (connection === 'open') {
      // User successfully linked — capture creds
      try {
        const credsBase64 = encodeCreds(state);
        const sessionId = buildSessionId(sessionCode, credsBase64);
        const jid = sock.user?.id;
        const dpBase64 = jid ? await downloadDpBase64(sock, jid) : null;

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
        console.log(`[${sessionCode}] Linked — jid=${jid}`);

        // Schedule teardown — give the bot nothing to keep alive here
        setTimeout(() => teardownSession(sessionCode), 5000);
      } catch (e) {
        console.error(`[${sessionCode}] Failed to capture creds:`, e);
        entry.state = 'failed';
      }
    }

    if (connection === 'close') {
      const statusCode = lastDisconnect?.error?.output?.statusCode;
      console.log(`[${sessionCode}] Connection closed. Status: ${statusCode}, state: ${entry.state}`);

      // If the user already linked, no action needed (entry will be torn down)
      if (entry.state === 'linked') return;

      // If we already generated a code, DON'T restart — that would
      // invalidate the code shown on the website. Just wait for the
      // user to enter it on their phone; the socket will reconnect
      // using the persisted auth state once they do.
      if (entry.state === 'code_sent' || entry.pairingCode) {
        console.log(`[${sessionCode}] Preserving pairing code (not restarting). User can still enter the code on their phone.`);
        return;
      }

      // If loggedOut or 410 (resource gone), don't retry
      if (statusCode === DisconnectReason.loggedOut || statusCode === 410) {
        entry.state = 'failed';
        return;
      }

      // If we haven't generated a code yet, restart the session
      if (entry.state === 'pending') {
        console.log(`[${sessionCode}] Restarting pending session in 2s…`);
        pendingSessions.delete(sessionCode);
        try { fs.rmSync(sessionFolder, { recursive: true, force: true }); } catch {}
        setTimeout(() => startPairingSession(phone).catch(()=>{}), 2000);
      }
    }
  });

  // Request pairing code — Baileys queues this until the WS is open
  try {
    const code = await sock.requestPairingCode(phone);
    entry.pairingCode = code;
    if (entry.state === 'pending') entry.state = 'code_sent';
    console.log(`[${sessionCode}] Pairing code generated: ${code}`);
    return { sessionCode, pairingCode: code };
  } catch (e) {
    console.error('Failed to request pairing code:', e);
    throw e;
  }
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
    return res.status(400).json({ ok: false, error: 'Invalid phone number' });
  }
  if (phone.length < 8 || phone.length > 15) {
    return res.status(400).json({
      ok: false,
      error: 'Phone must be 8-15 digits with country code (e.g. 254712345678)'
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
    return res.status(404).json({ ok: false, error: 'Session not found' });
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
  console.log(`MEGH ULTRA XD pairing site live on :${PORT}`);
  console.log(`Browser identity: ['MEGH ULTRA XD', 'Chrome', 'MacOS']`);
});

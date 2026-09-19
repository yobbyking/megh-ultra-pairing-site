/* ============================================================
   MEGH ULTRA XD — Pairing Site Frontend (cooler premium)
   - Matrix rain canvas background
   - Country-code dropdown + phone number (combined as E.164)
   - Tap pairing code to auto-copy
   - Tap session ID to auto-copy
   ============================================================ */

// ─── Matrix rain background ────────────────────────────────────────
const canvas = document.getElementById('bg');
const ctx = canvas.getContext('2d');
let columns, drops;

function resizeCanvas() {
  canvas.width = window.innerWidth;
  canvas.height = window.innerHeight;
  const fontSize = 14;
  columns = Math.floor(canvas.width / fontSize);
  drops = new Array(columns).fill(0).map(() => Math.random() * canvas.height);
}
resizeCanvas();
window.addEventListener('resize', resizeCanvas);

const chars = 'MEGHMD0123456789ABCDEF◈▣▓░█✧';
const fontSize = 14;

function drawMatrix() {
  ctx.fillStyle = 'rgba(2, 3, 10, 0.08)';
  ctx.fillRect(0, 0, canvas.width, canvas.height);

  ctx.font = `${fontSize}px JetBrains Mono`;
  for (let i = 0; i < drops.length; i++) {
    const text = chars[Math.floor(Math.random() * chars.length)];
    const x = i * fontSize;
    const y = drops[i];

    ctx.shadowBlur = 10;
    ctx.shadowColor = Math.random() > 0.95 ? '#ff2bd6' : '#00f0ff';
    ctx.fillStyle = Math.random() > 0.5 ? 'rgba(0,240,255,0.9)' : 'rgba(0,255,157,0.65)';
    ctx.fillText(text, x, y);
    ctx.shadowBlur = 0;

    if (y > canvas.height && Math.random() > 0.975) drops[i] = 0;
    drops[i] += fontSize;
  }
}
setInterval(drawMatrix, 60);

// ─── Clock ─────────────────────────────────────────────────────────
function updateClock() {
  const d = new Date();
  const p = n => String(n).padStart(2, '0');
  document.getElementById('clock').textContent =
    `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}
setInterval(updateClock, 1000); updateClock();

// ─── UI helpers ────────────────────────────────────────────────────
const $ = sel => document.querySelector(sel);
function showStep(id) {
  document.querySelectorAll('.step').forEach(s => s.classList.remove('active'));
  document.getElementById(id).classList.add('active');
}
function showError(msg) {
  const b = $('#error-banner');
  b.textContent = `⚠ ${msg}`;
  b.classList.add('show');
  setTimeout(() => b.classList.remove('show'), 5000);
}
function showCopyToast() {
  const t = $('#copyToast');
  t.classList.add('show');
  setTimeout(() => t.classList.remove('show'), 1800);
}

// ─── Phone hint + quick pick ───────────────────────────────────────
const countryInput = $('#countryCode');
const phoneInput = $('#phone');
const phoneHint = $('#phoneHint');

function updatePhoneHint() {
  const cc = countryInput.value || '___';
  phoneHint.innerHTML = `Pairing as <code>+${cc}</code> + your local number. <b>Strip leading 0</b> from your local number (e.g. <code>712345678</code>, not <code>0712345678</code>).`;
}
countryInput.addEventListener('input', updatePhoneHint);
phoneInput.addEventListener('input', updatePhoneHint);
updatePhoneHint();

// Quick-pick buttons
document.querySelectorAll('.cc-btn').forEach(btn => {
  btn.addEventListener('click', () => {
    countryInput.value = btn.dataset.cc;
    updatePhoneHint();
    phoneInput.focus();
  });
});

// ─── Pairing flow ──────────────────────────────────────────────────
let pollTimer = null;
let currentSessionCode = null;

async function requestPairing() {
  const cc = countryInput.value.trim().replace(/\D/g, '');
  let local = phoneInput.value.trim().replace(/\D/g, '');

  if (!cc) return showError('Enter country code (e.g. 254 for Kenya)');
  if (cc.length < 1 || cc.length > 4) return showError('Country code must be 1-4 digits');
  if (!local) return showError('Enter your phone number');
  if (local.length < 5) return showError('Phone number too short');

  // STRIP LEADING ZEROS (trunk prefix) — common in most countries outside US/Canada
  // e.g. Kenya: 0712345678 → 712345678 → +254712345678
  // This is critical: WhatsApp silently rejects "2540712345678" with no error
  while (local.startsWith('0')) local = local.slice(1);

  // Combine country code + local number — proper E.164 format
  const fullPhone = cc + local;

  // Sanity check: total length 8-15 digits (E.164 standard)
  if (fullPhone.length < 8 || fullPhone.length > 15) {
    return showError('Invalid phone length: ' + fullPhone.length + ' digits. Should be 8-15.');
  }

  const btn = $('#btn-pair');
  btn.disabled = true;
  btn.querySelector('.btn-text').textContent = 'Generating…';

  try {
    const res = await fetch('/api/pair', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ phone: fullPhone })
    });
    const data = await res.json();
    if (!data.ok) throw new Error(data.error || 'Failed to generate code');

    currentSessionCode = data.sessionCode;
    // ★ Strip any dashes from the code before animating — the server
    // returns "F6AJ-JYPV" but animatePairingCode adds its own dash
    // between index 3 and 4. Without stripping, we'd end up with
    // "F6AJ--JYPV" when copying.
    if (data.pairingCode) animatePairingCode(data.pairingCode.replace(/-/g, ''));
    showStep('step-code');
    startPolling();
  } catch (e) {
    showError(e.message);
    btn.disabled = false;
    btn.querySelector('.btn-text').textContent = 'Generate Pairing Code';
  }
}

function animatePairingCode(code) {
  const wrap = $('#pairingCodeBox');
  wrap.innerHTML = '';
  const chars = code.split('');
  chars.forEach((c, i) => {
    const span = document.createElement('span');
    span.className = 'char placeholder';
    span.textContent = c;
    wrap.appendChild(span);
    if (i === 3) {
      const sep = document.createElement('span');
      sep.className = 'sep';
      sep.textContent = '-';
      wrap.appendChild(sep);
    }
    setTimeout(() => span.classList.remove('placeholder'), 200 + i * 150);
  });
}

function startPolling() {
  if (pollTimer) clearInterval(pollTimer);
  pollTimer = setInterval(async () => {
    if (!currentSessionCode) return;
    try {
      const res = await fetch(`/api/status/${currentSessionCode}`);
      const data = await res.json();
      if (!data.ok) return;

      if (data.state === 'linked' && data.sessionId) {
        clearInterval(pollTimer); pollTimer = null;
        $('#session-id').textContent = data.sessionId;
        showStep('step-session');
      }
    } catch {}
  }, 2500);
}

// ─── Tap-to-copy: pairing code ─────────────────────────────────────
async function copyPairingCode() {
  const box = $('#pairingCodeBox');
  const chars = box.querySelectorAll('.char:not(.placeholder)');
  if (!chars.length) return;
  const code = Array.from(chars).map(c => c.textContent).join('');
  const formatted = `${code.slice(0,4)}-${code.slice(4)}`;
  await copyToClipboard(formatted, box);
}
async function copySession() {
  const sid = $('#session-id').textContent;
  await copyToClipboard(sid, $('#sessionIdBox'));
  const btn = $('#btn-copy');
  const old = btn.textContent;
  btn.textContent = '✓';
  setTimeout(() => btn.textContent = old, 1500);
}
async function copyToClipboard(text, animateEl) {
  try {
    await navigator.clipboard.writeText(text);
  } catch {
    // Fallback
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.style.position = 'fixed'; ta.style.opacity = '0';
    document.body.appendChild(ta);
    ta.select();
    try { document.execCommand('copy'); } catch {}
    document.body.removeChild(ta);
  }
  showCopyToast();
  if (animateEl) {
    animateEl.classList.add('copied');
    setTimeout(() => animateEl.classList.remove('copied'), 1000);
  }
}

function restart() {
  if (pollTimer) clearInterval(pollTimer);
  currentSessionCode = null;
  $('#phone').value = '';
  $('#pairingCodeBox').innerHTML = `
    <span class="char">●</span><span class="char">●</span><span class="char">●</span><span class="char">●</span>
    <span class="sep">-</span>
    <span class="char">●</span><span class="char">●</span><span class="char">●</span><span class="char">●</span>
  `;
  const btn = $('#btn-pair');
  btn.disabled = false;
  btn.querySelector('.btn-text').textContent = 'Generate Pairing Code';
  showStep('step-phone');
}

// ─── Wire up ───────────────────────────────────────────────────────
$('#btn-pair').addEventListener('click', requestPairing);
$('#btn-copy').addEventListener('click', copySession);
$('#sessionIdBox').addEventListener('click', (e) => {
  if (e.target.id !== 'btn-copy') copySession();
});
$('#pairingCodeBox').addEventListener('click', copyPairingCode);
$('#btn-restart').addEventListener('click', restart);
$('#phone').addEventListener('keydown', e => {
  if (e.key === 'Enter') requestPairing();
});

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

// ─── Phone hint updates based on selected country ─────────────────
const countrySelect = $('#countryCode');
const phoneInput = $('#phone');
const phoneHint = $('#phoneHint');

const COUNTRY_EXAMPLES = {
  '254': '712345678',  // Kenya
  '1':   '5551234567', // US
  '44':  '7400123456', // UK
  '234': '8012345678', // Nigeria
  '91':  '9876543210', // India
  '27':  '721345678',  // SA
  '233': '244567890',  // Ghana
  '256': '712345678',  // Uganda
  '255': '712345678',  // Tanzania
  '971': '501234567',  // UAE
  '966': '512345678',  // Saudi
  '880': '171234567',  // Bangladesh
  '92':  '3012345678', // Pakistan
  '61':  '412345678',  // Australia
  '49':  '15123456789',// Germany
  '33':  '612345678',  // France
  '34':  '612345678',  // Spain
  '39':  '3201234567', // Italy
  '7':   '9123456789', // Russia
  '55':  '11912345678',// Brazil
  '52':  '5512345678', // Mexico
  '62':  '812345678',  // Indonesia
  '63':  '9171234567', // Philippines
  '60':  '123456789',  // Malaysia
  '65':  '81234567',   // Singapore
  '81':  '9012345678', // Japan
  '82':  '1023456789'  // Korea
};

function updatePhoneHint() {
  const cc = countrySelect.value;
  const example = COUNTRY_EXAMPLES[cc] || '123456789';
  const flag = countrySelect.options[countrySelect.selectedIndex].dataset.flag || '🌍';
  phoneHint.innerHTML = `Enter your <b>local</b> number WITHOUT country code.<br/>e.g. <code>${example}</code> → will pair as <code>+${cc}${example}</code> ${flag}`;
}
countrySelect.addEventListener('change', updatePhoneHint);
updatePhoneHint();

// ─── Pairing flow ──────────────────────────────────────────────────
let pollTimer = null;
let currentSessionCode = null;

async function requestPairing() {
  const cc = countrySelect.value;
  const local = phoneInput.value.trim().replace(/\D/g, '');
  if (!local) return showError('Enter your phone number');
  if (local.length < 5) return showError('Phone number too short');

  // Combine country code + local number
  const fullPhone = cc + local;

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
    if (data.pairingCode) animatePairingCode(data.pairingCode);
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

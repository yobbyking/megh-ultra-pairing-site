/* ============================================================
   MEGH ULTRA XD — Pairing Site Frontend
   - Matrix rain on canvas
   - Phone → code → session flow
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

const chars = 'MEGHULTRA0123456789ABCDEF◈▣▓░█';
const fontSize = 14;

function drawMatrix() {
  ctx.fillStyle = 'rgba(2, 3, 10, 0.08)';
  ctx.fillRect(0, 0, canvas.width, canvas.height);

  ctx.font = `${fontSize}px JetBrains Mono`;
  for (let i = 0; i < drops.length; i++) {
    const text = chars[Math.floor(Math.random() * chars.length)];
    const x = i * fontSize;
    const y = drops[i];

    // glow
    ctx.shadowBlur = 8;
    ctx.shadowColor = Math.random() > 0.95 ? '#ff2bd6' : '#00f0ff';
    ctx.fillStyle = Math.random() > 0.5 ? 'rgba(0,240,255,0.85)' : 'rgba(0,255,157,0.6)';
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

// ─── Pairing flow ──────────────────────────────────────────────────
let pollTimer = null;
let currentSessionCode = null;

async function requestPairing() {
  const phoneInput = $('#phone');
  const phone = phoneInput.value.trim();
  if (!phone) return showError('Enter phone number');
  if (phone.length < 8 || !/^\d+$/.test(phone)) {
    return showError('Phone must be 8-15 digits (no + or spaces)');
  }
  const btn = $('#btn-pair');
  btn.disabled = true;
  btn.querySelector('.btn-text').textContent = 'Generating…';

  try {
    const res = await fetch('/api/pair', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ phone })
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
  const wrap = $('#pairing-code');
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

// ─── Copy session ──────────────────────────────────────────────────
async function copySession() {
  const sid = $('#session-id').textContent;
  try {
    await navigator.clipboard.writeText(sid);
    const btn = $('#btn-copy');
    const old = btn.textContent;
    btn.textContent = '✓';
    setTimeout(() => btn.textContent = old, 1500);
  } catch {
    // Fallback
    const range = document.createRange();
    range.selectNode($('#session-id'));
    window.getSelection().removeAllRanges();
    window.getSelection().addRange(range);
    document.execCommand('copy');
  }
}

function restart() {
  if (pollTimer) clearInterval(pollTimer);
  currentSessionCode = null;
  $('#phone').value = '';
  $('#pairing-code').innerHTML = `
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
$('#btn-restart').addEventListener('click', restart);
$('#phone').addEventListener('keydown', e => {
  if (e.key === 'Enter') requestPairing();
});

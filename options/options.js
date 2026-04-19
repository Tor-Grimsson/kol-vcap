// options.js — wires up the options page: defaults form, capabilities
// probe, history list, copy buttons, scrollspy nav.

const STORAGE_KEYS = {
  DEFAULTS: 'vcap:defaults',
  HISTORY: 'vcap:history',
};

const DEFAULT_CONFIG = {
  selector: null,
  isolate: false,
  background: null,
  stripEffects: false,
  margin: 0,
  scrollIntoView: true,
  trackElement: false,
  scale: 2,
  duration: null,
  format: 'auto',
  filename: null,
};

// --- version ---

(async () => {
  try {
    const manifest = chrome.runtime.getManifest();
    document.getElementById('version').textContent = 'v' + manifest.version;
  } catch {}
})();

// --- defaults form ---

async function loadDefaults() {
  const data = await chrome.storage.local.get(STORAGE_KEYS.DEFAULTS);
  return { ...DEFAULT_CONFIG, ...(data[STORAGE_KEYS.DEFAULTS] || {}) };
}

async function saveDefaults(cfg) {
  await chrome.storage.local.set({ [STORAGE_KEYS.DEFAULTS]: cfg });
}

function populateDefaultsForm(cfg) {
  document.getElementById('d-scale').value = String(cfg.scale);
  document.getElementById('d-format').value = cfg.format;
  document.getElementById('d-margin').value = cfg.margin;
  document.getElementById('d-scrollIntoView').value = String(cfg.scrollIntoView);
}

function readDefaultsForm() {
  const form = document.getElementById('defaults-form');
  const data = new FormData(form);
  return {
    scale: parseFloat(data.get('scale')),
    format: data.get('format'),
    margin: parseInt(data.get('margin'), 10) || 0,
    scrollIntoView: data.get('scrollIntoView') === 'true',
  };
}

(async () => {
  const cfg = await loadDefaults();
  populateDefaultsForm(cfg);

  const form = document.getElementById('defaults-form');
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const existing = await loadDefaults();
    const next = { ...existing, ...readDefaultsForm() };
    await saveDefaults(next);
    const status = document.getElementById('defaults-status');
    status.textContent = 'saved';
    status.classList.add('ok');
    setTimeout(() => {
      status.textContent = '';
      status.classList.remove('ok');
    }, 1400);
  });

  document.getElementById('reset-defaults').addEventListener('click', async () => {
    await saveDefaults(DEFAULT_CONFIG);
    populateDefaultsForm(DEFAULT_CONFIG);
    const status = document.getElementById('defaults-status');
    status.textContent = 'reset to defaults';
    status.classList.add('ok');
    setTimeout(() => {
      status.textContent = '';
      status.classList.remove('ok');
    }, 1400);
  });
})();

// --- hotkey ---

(async () => {
  try {
    const commands = await chrome.commands.getAll();
    const cmd = commands.find((c) => c.name === 'toggle-recording');
    const el = document.getElementById('current-hotkey');
    el.textContent = cmd?.shortcut || 'not set';
  } catch {
    document.getElementById('current-hotkey').textContent = 'unavailable';
  }
})();

document.getElementById('open-shortcuts').addEventListener('click', (e) => {
  e.preventDefault();
  chrome.tabs.create({ url: 'chrome://extensions/shortcuts' });
});

// --- capabilities ---

(async () => {
  const body = document.getElementById('caps-body');
  try {
    const caps = await chrome.runtime.sendMessage({ type: 'GET_CAPABILITIES' });
    const data = caps?.data || caps || {};
    const rows = [
      ['mp4 / h264', data.mp4H264],
      ['webm / vp9', data.webmVp9],
      ['webm / vp8', data.webmVp8],
      ['webm alpha (transparent)', data.webmAlpha],
    ];
    body.innerHTML = rows
      .map(
        ([label, ok]) => `
          <tr>
            <td>${label}</td>
            <td class="${ok ? 'yes' : 'no'}">${ok ? 'supported' : 'not supported'}</td>
          </tr>`
      )
      .join('');
  } catch (err) {
    body.innerHTML = `<tr><td colspan="2" class="muted">probe failed: ${err?.message || err}</td></tr>`;
  }
})();

// --- history ---

function formatTs(ms) {
  const d = new Date(ms);
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(
    d.getHours()
  )}:${pad(d.getMinutes())}`;
}

function formatDuration(ms) {
  if (!ms || !Number.isFinite(ms)) return '—';
  const s = ms / 1000;
  if (s < 60) return s.toFixed(1) + 's';
  const m = Math.floor(s / 60);
  const rem = Math.round(s - m * 60);
  return `${m}m ${rem}s`;
}

async function renderHistory() {
  const data = await chrome.storage.local.get(STORAGE_KEYS.HISTORY);
  const list = data[STORAGE_KEYS.HISTORY] || [];
  const host = document.getElementById('history-body');
  if (list.length === 0) {
    host.innerHTML = `<p class="empty">no recordings yet. after your first vcap.start(), entries appear here.</p>`;
    return;
  }
  host.innerHTML = list
    .map((entry) => {
      const sel = entry.config?.selector ? entry.config.selector : '(viewport)';
      const ext = entry.mimeType?.includes('mp4') ? 'mp4' : 'webm';
      return `
        <div class="history-row">
          <span class="ts">${formatTs(entry.at)}</span>
          <span class="fn">${escapeHtml(entry.filename)}<span class="meta"> · ${escapeHtml(
            sel
          )} · ${ext} · ${formatDuration(entry.durationMs)}</span></span>
        </div>`;
    })
    .join('');
}

function escapeHtml(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#39;',
  })[c]);
}

renderHistory();

document.getElementById('clear-history').addEventListener('click', async () => {
  await chrome.storage.local.set({ [STORAGE_KEYS.HISTORY]: [] });
  renderHistory();
});

// Re-render if storage changes (e.g., new recording from another tab)
chrome.storage.onChanged.addListener((changes, area) => {
  if (area === 'local' && changes[STORAGE_KEYS.HISTORY]) renderHistory();
});

// --- copy buttons on code blocks ---

document.querySelectorAll('pre.code[data-copy]').forEach((pre) => {
  pre.addEventListener('click', async (e) => {
    // only trigger if click is in the top-right copy region
    const rect = pre.getBoundingClientRect();
    const x = e.clientX - rect.left;
    const y = e.clientY - rect.top;
    const inCopyZone = x > rect.width - 60 && y < 28;
    if (!inCopyZone) return;

    const code = pre.querySelector('code')?.textContent || '';
    try {
      await navigator.clipboard.writeText(code);
      pre.classList.add('copied');
      setTimeout(() => pre.classList.remove('copied'), 900);
    } catch {}
  });
});

// --- scrollspy ---

const sections = Array.from(document.querySelectorAll('section[id]'));
const navLinks = Array.from(document.querySelectorAll('.nav a'));

function activateNav() {
  const scrollY = window.scrollY + 80;
  let current = sections[0]?.id;
  for (const s of sections) {
    if (s.offsetTop <= scrollY) current = s.id;
  }
  navLinks.forEach((a) => {
    a.classList.toggle('active', a.getAttribute('href') === '#' + current);
  });
}

window.addEventListener('scroll', activateNav, { passive: true });
activateNav();

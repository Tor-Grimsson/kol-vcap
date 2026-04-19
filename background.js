// background.js — MV3 service worker.
// Handles hotkey, obtains media stream IDs, coordinates the offscreen document.

import { DEFAULT_CONFIG, STORAGE_KEYS, SCHEMA_VERSION } from './lib/config.js';

const OFFSCREEN_PATH = 'offscreen.html';

// in-memory state (SWs can be suspended; storage-backed state is reloaded on demand)
let state = {
  mode: 'idle', // 'idle' | 'armed' | 'recording'
  pending: null, // { config, rect, dpr, viewport, pageUrl, tabId }
  recording: null, // { tabId, startedAt, config }
};

// --- lifecycle ---

chrome.runtime.onInstalled.addListener(async () => {
  // persist schema version so future migrations are possible
  await chrome.storage.local.set({ [STORAGE_KEYS.VERSION]: SCHEMA_VERSION });
  // seed defaults if missing
  const existing = await chrome.storage.local.get(STORAGE_KEYS.DEFAULTS);
  if (!existing[STORAGE_KEYS.DEFAULTS]) {
    await chrome.storage.local.set({ [STORAGE_KEYS.DEFAULTS]: DEFAULT_CONFIG });
  }
});

// --- messaging ---

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  handle(msg, sender).then(sendResponse).catch((err) => {
    console.error('[vcap bg]', err);
    sendResponse({ ok: false, error: err?.message || String(err) });
  });
  return true; // async
});

async function handle(msg, sender) {
  switch (msg?.type) {
    case 'PREPARE_CAPTURE':
      return prepareCapture(msg.payload, sender);
    case 'STOP_CAPTURE':
      return stopCapture();
    case 'GET_STATUS':
      return { ok: true, data: { mode: state.mode } };
    case 'GET_CAPABILITIES':
      return { ok: true, data: await getCapabilities() };
    case 'RECORDING_COMPLETE':
      return handleRecordingComplete(msg.payload);
    case 'RECORDING_ERROR':
      console.error('[vcap bg] recording error from offscreen:', msg.payload?.message || JSON.stringify(msg.payload));
      state.mode = 'idle';
      state.recording = null;
      await closeOffscreen();
      return { ok: true };
    default:
      return { ok: false, error: `unknown message type: ${msg?.type}` };
  }
}

async function prepareCapture(payload, sender) {
  const tabId = sender?.tab?.id;
  if (!tabId) {
    return { ok: false, error: 'no tab id on sender' };
  }
  if (state.mode === 'recording') {
    return { ok: false, error: 'already recording. vcap.stop() first.' };
  }

  state.pending = { ...payload, tabId };
  state.mode = 'armed';

  return {
    ok: true,
    data: { message: 'armed. press the vcap hotkey to begin.' },
  };
}

// --- hotkey ---

chrome.commands.onCommand.addListener(async (command) => {
  if (command !== 'toggle-recording') return;
  try {
    if (state.mode === 'recording') {
      await stopCapture();
    } else if (state.mode === 'armed') {
      await startCapture();
    } else {
      // not armed — brief indicator via title badge
      await flashBadge('?', '#888');
    }
  } catch (err) {
    console.error('[vcap bg] hotkey error:', err);
    await flashBadge('!', '#ff3b30');
    state.mode = 'idle';
  }
});

// --- capture pipeline ---

async function startCapture() {
  if (!state.pending) throw new Error('no pending capture');
  const { tabId, config, rect, dpr } = state.pending;

  const streamId = await new Promise((resolve, reject) => {
    chrome.tabCapture.getMediaStreamId({ targetTabId: tabId }, (id) => {
      if (chrome.runtime.lastError) {
        reject(new Error(chrome.runtime.lastError.message));
      } else {
        resolve(id);
      }
    });
  });

  await ensureOffscreen();

  // Read the last known-good codec so offscreen can skip the mp4 probe.
  const cachedCodec = await readCachedCodec();

  // Tell the offscreen doc to start recording with this stream.
  // NB: broadcasts to all extension contexts; only offscreen acts on it.
  await chrome.runtime.sendMessage({
    type: 'OFFSCREEN_START',
    payload: { streamId, config, rect, dpr, cachedMime: cachedCodec },
  });

  state.mode = 'recording';
  state.recording = { tabId, startedAt: Date.now(), config };
  state.pending = null;

  await setBadge('REC', '#ff3b30');
  broadcastEvent('VCAP_EVENT:started', { config });
}

async function stopCapture() {
  if (state.mode !== 'recording') {
    // nothing to do, but clear any armed state too
    state.mode = 'idle';
    state.pending = null;
    await setBadge('', '#000');
    return { ok: true };
  }
  await chrome.runtime.sendMessage({ type: 'OFFSCREEN_STOP' });
  // state flips to idle in handleRecordingComplete
  return { ok: true };
}

async function handleRecordingComplete(payload) {
  const { dataUrl, mimeType, durationMs } = payload;
  const ext = mimeType.includes('mp4') ? 'mp4' : 'webm';
  const filename =
    state.recording?.config?.filename ||
    `vcap-${timestampSlug()}.${ext}`;

  try {
    await chrome.downloads.download({ url: dataUrl, filename, saveAs: false });
    await appendHistory({
      at: Date.now(),
      filename,
      mimeType,
      durationMs,
      config: state.recording?.config || null,
    });
    await writeCachedCodec(mimeType);
  } catch (err) {
    console.error('[vcap bg] download failed:', err);
  }

  state.mode = 'idle';
  state.recording = null;
  await setBadge('', '#000');
  broadcastEvent('VCAP_EVENT:stopped', { filename });
  await closeOffscreen();
  return { ok: true };
}

// --- offscreen document management ---

async function ensureOffscreen() {
  const contexts = await chrome.runtime.getContexts({
    contextTypes: ['OFFSCREEN_DOCUMENT'],
  });
  if (contexts.length > 0) return;
  await chrome.offscreen.createDocument({
    url: OFFSCREEN_PATH,
    reasons: ['USER_MEDIA'],
    justification: 'MediaRecorder for tab capture requires a DOM context.',
  });
}

async function closeOffscreen() {
  const contexts = await chrome.runtime.getContexts({
    contextTypes: ['OFFSCREEN_DOCUMENT'],
  });
  if (contexts.length === 0) return;
  try {
    await chrome.offscreen.closeDocument();
  } catch (err) {
    // Races with another close call when error + stop both fire. Harmless.
    if (!/No current offscreen document/i.test(err?.message || '')) throw err;
  }
}

// --- capabilities ---

async function getCapabilities() {
  // MediaRecorder isn't available in service workers. Ask offscreen.
  await ensureOffscreen();
  const caps = await chrome.runtime.sendMessage({ type: 'OFFSCREEN_CAPABILITIES' });
  await closeOffscreen();
  return caps || { error: 'unable to query offscreen capabilities' };
}

// --- filename ---

function timestampSlug() {
  const d = new Date();
  const pad = (n) => String(n).padStart(2, '0');
  return (
    String(d.getFullYear()).slice(2) +
    pad(d.getMonth() + 1) +
    pad(d.getDate()) +
    '-' +
    pad(d.getHours()) +
    pad(d.getMinutes()) +
    pad(d.getSeconds())
  );
}

// --- codec cache ---

async function readCachedCodec() {
  try {
    const out = await chrome.storage.local.get(STORAGE_KEYS.CODEC);
    return out[STORAGE_KEYS.CODEC] || null;
  } catch {
    return null;
  }
}

async function writeCachedCodec(mime) {
  try {
    await chrome.storage.local.set({ [STORAGE_KEYS.CODEC]: mime });
  } catch (err) {
    console.error('[vcap bg] codec cache write failed:', err?.message || err);
  }
}

// --- history ---

async function appendHistory(entry) {
  const data = await chrome.storage.local.get(STORAGE_KEYS.HISTORY);
  const list = data[STORAGE_KEYS.HISTORY] || [];
  list.unshift(entry);
  // cap at 50 entries
  const trimmed = list.slice(0, 50);
  await chrome.storage.local.set({ [STORAGE_KEYS.HISTORY]: trimmed });
}

// --- ui feedback ---

async function setBadge(text, color) {
  try {
    await chrome.action.setBadgeText({ text });
    if (text) await chrome.action.setBadgeBackgroundColor({ color });
  } catch {
    // chrome.action may not be available if no default_action set; ignore
  }
}

async function flashBadge(text, color) {
  await setBadge(text, color);
  setTimeout(() => setBadge('', '#000'), 600);
}

function broadcastEvent(type, payload) {
  // Fire-and-forget; errors if no listeners are fine.
  chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
    for (const t of tabs) {
      chrome.tabs.sendMessage(t.id, { type, payload }).catch(() => {});
    }
  });
}

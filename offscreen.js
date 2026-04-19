// offscreen.js — hosts MediaRecorder in a DOM context (required in MV3).
// Receives OFFSCREEN_START / OFFSCREEN_STOP from the service worker,
// captures the tab stream, optionally crops via canvas, and posts the
// resulting blob back as a data URL.

let mediaRecorder = null;
let chunks = [];
let currentMime = null;
let startedAt = 0;
let sourceStream = null;
let canvasStream = null;
let rafId = null;
let autoStopTimer = null;
let hiddenVideo = null;
let canvasEl = null;

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  (async () => {
    if (msg?.type === 'OFFSCREEN_START') {
      try {
        await startRecording(msg.payload);
        sendResponse({ ok: true });
      } catch (err) {
        console.error('[vcap offscreen] start error:', err);
        await chrome.runtime.sendMessage({
          type: 'RECORDING_ERROR',
          payload: { message: err?.message || String(err) },
        });
        sendResponse({ ok: false, error: err?.message });
      }
    } else if (msg?.type === 'OFFSCREEN_STOP') {
      stopRecording();
      sendResponse({ ok: true });
    } else if (msg?.type === 'OFFSCREEN_CAPABILITIES') {
      sendResponse(reportCapabilities());
    }
  })();
  return true;
});

async function startRecording({ streamId, config, rect, dpr, cachedMime }) {
  sourceStream = await navigator.mediaDevices.getUserMedia({
    audio: false,
    video: {
      mandatory: {
        chromeMediaSource: 'tab',
        chromeMediaSourceId: streamId,
      },
    },
  });

  const outputStream =
    rect && config.selector ? cropStream(sourceStream, rect, config, dpr) : sourceStream;

  const chain = buildMimeChain(config);
  if (chain.length === 0) throw new Error('no supported mime types for config');

  // Move cached mime to the front so we skip the probe on known-good codec.
  const ordered = cachedMime && chain.includes(cachedMime)
    ? [cachedMime, ...chain.filter((m) => m !== cachedMime)]
    : chain;

  const attempts = [];
  for (const mime of ordered) {
    const ok = await tryMime(outputStream, mime, config);
    attempts.push(`${mime}:${ok ? 'ok' : 'fail'}`);
    if (ok) {
      console.log(`[vcap offscreen] recording with ${mime} (chain: ${attempts.join(', ')})`);
      return;
    }
  }
  throw new Error(`all encoders failed. tried: ${attempts.join(', ')}`);
}

function tryMime(stream, mime, config) {
  return new Promise((resolve) => {
    chunks = [];
    startedAt = Date.now();
    currentMime = mime;

    let rec;
    try {
      // Explicit bitrate sized to the stream. Too low and the encoder can't
      // produce a clean I-frame at start → compression artifacts in the first
      // second. Target ~0.12 bits/pixel/frame (solid quality for VP9/H264),
      // clamped to a sane range.
      const track = stream.getVideoTracks?.()[0];
      const s = track?.getSettings?.() || {};
      const w = s.width || 1920;
      const h = s.height || 1080;
      const fps = s.frameRate || 30;
      const bitrate = Math.max(
        6_000_000,
        Math.min(40_000_000, Math.round(w * h * fps * 0.12))
      );
      rec = new MediaRecorder(stream, { mimeType: mime, videoBitsPerSecond: bitrate });
      console.log(`[vcap offscreen] ${mime} @ ${(bitrate / 1_000_000).toFixed(1)} Mbps (${w}×${h}@${fps})`);
    } catch (err) {
      console.warn(`[vcap offscreen] ${mime} constructor threw: ${err?.name} ${err?.message}`);
      resolve(false);
      return;
    }
    mediaRecorder = rec;

    let settled = false;
    let timeoutId;

    const commit = () => {
      rec.onstop = async () => {
        const durationMs = Date.now() - startedAt;
        if (chunks.length === 0) {
          cleanup();
          await chrome.runtime.sendMessage({
            type: 'RECORDING_ERROR',
            payload: { message: 'no data captured' },
          });
          return;
        }
        const blob = new Blob(chunks, { type: mime });
        const dataUrl = await blobToDataUrl(blob);
        cleanup();
        await chrome.runtime.sendMessage({
          type: 'RECORDING_COMPLETE',
          payload: { dataUrl, mimeType: mime, durationMs },
        });
      };
      rec.onerror = async (e) => {
        const err = e?.error || e;
        const flat = `mid-record: name=${err?.name} msg=${err?.message} mime=${mime}`;
        console.error('[vcap offscreen]', flat);
        await chrome.runtime.sendMessage({
          type: 'RECORDING_ERROR',
          payload: { message: flat },
        });
        cleanup();
      };
      if (config.duration && Number.isFinite(config.duration)) {
        autoStopTimer = setTimeout(() => stopRecording(), config.duration);
      }
    };

    const settle = (ok) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeoutId);
      if (ok) {
        commit();
        resolve(true);
      } else {
        try { if (rec.state !== 'inactive') rec.stop(); } catch {}
        rec.ondataavailable = null;
        rec.onerror = null;
        rec.onstop = null;
        mediaRecorder = null;
        chunks = [];
        resolve(false);
      }
    };

    rec.ondataavailable = (e) => {
      if (e.data && e.data.size > 0) {
        chunks.push(e.data);
        settle(true);
      }
    };
    rec.onerror = (e) => {
      const err = e?.error || e;
      console.warn(`[vcap offscreen] ${mime} rejected: ${err?.name} ${err?.message}`);
      settle(false);
    };
    rec.onstop = () => {
      if (!settled) settle(false);
    };

    timeoutId = setTimeout(() => {
      console.warn(`[vcap offscreen] ${mime} probe timed out`);
      settle(false);
    }, 2500);

    try {
      rec.start(250);
    } catch (err) {
      console.warn(`[vcap offscreen] ${mime} start() threw: ${err?.name} ${err?.message}`);
      settle(false);
    }
  });
}

function stopRecording() {
  if (autoStopTimer) {
    clearTimeout(autoStopTimer);
    autoStopTimer = null;
  }
  if (mediaRecorder && mediaRecorder.state !== 'inactive') {
    mediaRecorder.stop();
  }
}

function cleanup() {
  if (rafId) {
    cancelAnimationFrame(rafId);
    rafId = null;
  }
  if (hiddenVideo) {
    hiddenVideo.srcObject = null;
    hiddenVideo.remove();
    hiddenVideo = null;
  }
  if (canvasEl) {
    canvasEl.remove();
    canvasEl = null;
  }
  if (sourceStream) {
    sourceStream.getTracks().forEach((t) => t.stop());
    sourceStream = null;
  }
  if (canvasStream) {
    canvasStream.getTracks().forEach((t) => t.stop());
    canvasStream = null;
  }
  mediaRecorder = null;
  chunks = [];
}

function cropStream(stream, rect, config, dpr) {
  const margin = config.margin || 0;
  const scale = config.scale || 2;

  // Source rect in device pixels (stream is at DPR).
  const srcX = Math.max(0, Math.round((rect.x - margin) * dpr));
  const srcY = Math.max(0, Math.round((rect.y - margin) * dpr));
  const srcW = Math.round((rect.width + margin * 2) * dpr);
  const srcH = Math.round((rect.height + margin * 2) * dpr);

  // Output: `scale` output px per CSS px.
  const outW = Math.round((rect.width + margin * 2) * scale);
  const outH = Math.round((rect.height + margin * 2) * scale);

  hiddenVideo = document.createElement('video');
  hiddenVideo.srcObject = stream;
  hiddenVideo.muted = true;
  hiddenVideo.autoplay = true;
  hiddenVideo.playsInline = true;

  canvasEl = document.createElement('canvas');
  canvasEl.width = outW;
  canvasEl.height = outH;
  const ctx = canvasEl.getContext('2d', { alpha: config.background === 'transparent' });

  function draw() {
    if (hiddenVideo.readyState >= 2) {
      try {
        // Guard: stream dimensions may be smaller than requested crop
        // (off-viewport targets, narrow windows). Clamp source rect.
        const vw = hiddenVideo.videoWidth;
        const vh = hiddenVideo.videoHeight;
        const sx = Math.min(srcX, Math.max(0, vw - 1));
        const sy = Math.min(srcY, Math.max(0, vh - 1));
        const sw = Math.min(srcW, vw - sx);
        const sh = Math.min(srcH, vh - sy);
        if (sw > 0 && sh > 0) {
          if (config.background === 'transparent') {
            ctx.clearRect(0, 0, outW, outH);
          }
          ctx.drawImage(hiddenVideo, sx, sy, sw, sh, 0, 0, outW, outH);
        }
      } catch (err) {
        console.warn('[vcap offscreen] draw error:', err);
      }
    }
    rafId = requestAnimationFrame(draw);
  }

  hiddenVideo.onloadedmetadata = () => {
    hiddenVideo.play().catch(() => {});
    draw();
  };

  canvasStream = canvasEl.captureStream(60);
  return canvasStream;
}

// Build an ordered fallback chain of mime types to attempt.
// `isTypeSupported` can lie (Chrome says yes but the encoder dies at runtime),
// so we probe each one in order and use the first that actually emits data.
function buildMimeChain(config) {
  const { format, isolate, background } = config;
  const wantAlpha = isolate && background === 'transparent';
  const webm = ['video/webm;codecs=vp9', 'video/webm;codecs=vp8', 'video/webm'];
  // avc1 unspecified — let Chrome pick profile/level for the stream.
  const mp4 = ['video/mp4;codecs=avc1', 'video/mp4'];

  let list;
  if (wantAlpha) list = webm; // h264 has no alpha
  else if (format === 'webm') list = webm;
  else if (format === 'mp4') list = mp4;
  else list = [...mp4, ...webm]; // 'auto' — prefer mp4, fall back to webm

  return list.filter((m) => MediaRecorder.isTypeSupported(m));
}

function reportCapabilities() {
  const check = (t) => MediaRecorder.isTypeSupported(t);
  return {
    mp4H264: check('video/mp4;codecs=avc1.42E01E') || check('video/mp4;codecs=avc1'),
    webmVp9: check('video/webm;codecs=vp9'),
    webmVp8: check('video/webm;codecs=vp8'),
    webmAlpha: check('video/webm;codecs=vp9') || check('video/webm;codecs=vp8'),
    dpr: 'unknown (page-side)',
  };
}

function blobToDataUrl(blob) {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onloadend = () => resolve(r.result);
    r.onerror = () => reject(r.error);
    r.readAsDataURL(blob);
  });
}

// content-main.js — runs in the page's MAIN world.
// Exposes window.vcap so it's callable from the DevTools console.
// Communicates with the ISOLATED world via window CustomEvents.

(function () {
  if (window.vcap) return; // don't double-inject

  const OUT = '__vcap_out__';
  const IN = '__vcap_in__';

  // --- defaults (mirrored from lib/config.js; kept in sync manually) ---
  const DEFAULTS = {
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

  // runtime state in page
  let userDefaults = { ...DEFAULTS };
  let pendingId = 0;
  const pending = new Map();

  window.addEventListener(IN, (e) => {
    const { id, ok, data, error } = e.detail || {};
    if (id == null) return;
    const p = pending.get(id);
    if (!p) return;
    pending.delete(id);
    if (ok) p.resolve(data);
    else p.reject(new Error(error));
  });

  function send(action, payload) {
    return new Promise((resolve, reject) => {
      const id = ++pendingId;
      pending.set(id, { resolve, reject });
      window.dispatchEvent(new CustomEvent(OUT, { detail: { id, action, payload } }));
    });
  }

  // --- validation ---

  function validateOptions(opts) {
    const o = { ...userDefaults, ...opts };

    // scale
    if (![0.5, 1, 2].includes(o.scale)) {
      throw new Error(`vcap: scale must be 0.5, 1, or 2 (got ${o.scale})`);
    }

    const dpr = window.devicePixelRatio || 1;
    if (o.scale > dpr) {
      throw new Error(
        `vcap: scale ${o.scale} exceeds device DPR (${dpr}). ` +
        `Supersampling via debugger is not in v0.1.`
      );
    }

    // format
    if (!['auto', 'mp4', 'webm'].includes(o.format)) {
      throw new Error(`vcap: format must be 'auto', 'mp4', or 'webm'`);
    }

    // isolate
    if (o.isolate !== false && !['hide', 'clone'].includes(o.isolate)) {
      throw new Error(`vcap: isolate must be false, 'hide', or 'clone'`);
    }

    // transparent background only valid with isolate
    if (o.background === 'transparent' && !o.isolate) {
      throw new Error(`vcap: background:'transparent' requires isolate`);
    }
    if (o.background === 'transparent' && o.format === 'mp4') {
      throw new Error(
        `vcap: mp4 (h264) has no alpha channel. ` +
        `Use format:'webm' or format:'auto' for transparent recording.`
      );
    }

    // duration
    if (o.duration != null && (!Number.isFinite(o.duration) || o.duration <= 0)) {
      throw new Error(`vcap: duration must be a positive number (ms) or null`);
    }

    // margin
    if (!Number.isFinite(o.margin) || o.margin < 0) {
      throw new Error(`vcap: margin must be >= 0`);
    }

    return o;
  }

  function resolveSelector(selector) {
    if (!selector) return null; // null = full viewport
    const els = document.querySelectorAll(selector);
    if (els.length === 0) {
      throw new Error(`vcap: no element matches "${selector}"`);
    }
    if (els.length > 1) {
      throw new Error(
        `vcap: "${selector}" matches ${els.length} elements. Selector must be unique.`
      );
    }
    const el = els[0];
    const rect = el.getBoundingClientRect();
    if (rect.width === 0 || rect.height === 0) {
      throw new Error(`vcap: "${selector}" has zero dimensions`);
    }
    return el;
  }

  // --- isolation / effects stripping ---

  const STYLE_ID = '__vcap_isolation_style__';

  function removeInjectedStyle() {
    const existing = document.getElementById(STYLE_ID);
    if (existing) existing.remove();
  }

  function applyIsolation(target, opts) {
    removeInjectedStyle();

    const style = document.createElement('style');
    style.id = STYLE_ID;
    const rules = [];

    // Mark everything we want kept visible: target + its subtree + all ancestors.
    // Simpler than trying to express "target's subtree" via :not() combinators.
    target.setAttribute('data-vcap-target', '');
    target.setAttribute('data-vcap-keep', '');
    target.querySelectorAll('*').forEach((el) => el.setAttribute('data-vcap-keep', ''));
    let cur = target.parentElement;
    while (cur) {
      cur.setAttribute('data-vcap-keep', '');
      cur.setAttribute('data-vcap-ancestor', '');
      cur = cur.parentElement;
    }

    if (opts.isolate === 'hide') {
      // (0,0,2,1) specificity — beats a bare `body *` (0,0,1,1).
      rules.push(`
        body *:not([data-vcap-keep]) {
          visibility: hidden !important;
        }
      `);
      if (opts.background === 'transparent') {
        rules.push(`html, body { background: transparent !important; }`);
      } else if (opts.background) {
        rules.push(`html, body { background: ${opts.background} !important; }`);
      }
    }
    // 'clone' mode: handled below (v0.1 falls back to 'hide' with a warning)

    if (opts.stripEffects) {
      rules.push(`
        [data-vcap-ancestor] {
          filter: none !important;
          backdrop-filter: none !important;
          box-shadow: none !important;
          mix-blend-mode: normal !important;
        }
      `);
    }

    style.textContent = rules.join('\n');
    document.head.appendChild(style);
  }

  function clearIsolation() {
    document.querySelectorAll('[data-vcap-keep]').forEach((el) => {
      el.removeAttribute('data-vcap-keep');
    });
    document.querySelectorAll('[data-vcap-ancestor]').forEach((el) => {
      el.removeAttribute('data-vcap-ancestor');
    });
    document.querySelectorAll('[data-vcap-target]').forEach((el) => {
      el.removeAttribute('data-vcap-target');
    });
    removeInjectedStyle();
  }

  // --- public API ---

  async function start(selectorOrOpts, maybeOpts) {
    // Overload: vcap.start({ selector: '.x', ... }) OR vcap.start('.x', { ... })
    let opts;
    if (typeof selectorOrOpts === 'string') {
      opts = { ...maybeOpts, selector: selectorOrOpts };
    } else if (selectorOrOpts && typeof selectorOrOpts === 'object') {
      opts = { ...selectorOrOpts };
    } else {
      opts = {};
    }

    const resolved = validateOptions(opts);
    const target = resolveSelector(resolved.selector);

    // scroll into view if needed
    if (target && resolved.scrollIntoView) {
      target.scrollIntoView({ block: 'center', inline: 'center', behavior: 'instant' });
      // wait a frame for layout
      await new Promise((r) => requestAnimationFrame(r));
    }

    // apply isolation + effect strip if requested
    if (resolved.isolate || resolved.stripEffects) {
      if (!target) {
        throw new Error(`vcap: isolate/stripEffects require a selector`);
      }
      if (resolved.isolate === 'clone') {
        console.warn(`vcap: isolate:'clone' not fully implemented in v0.1; using 'hide'`);
        resolved.isolate = 'hide';
      }
      applyIsolation(target, resolved);
      // let the repaint happen
      await new Promise((r) => requestAnimationFrame(r));
    }

    // recompute rect after scroll/isolation
    const rect = target ? target.getBoundingClientRect() : null;

    const payload = {
      config: resolved,
      rect: rect
        ? { x: rect.x, y: rect.y, width: rect.width, height: rect.height }
        : null,
      dpr: window.devicePixelRatio || 1,
      viewport: { width: window.innerWidth, height: window.innerHeight },
      pageUrl: location.href,
    };

    try {
      const res = await send('PREPARE_CAPTURE', payload);
      console.log(
        '%cvcap%c ' + (res.message || 'armed. press the vcap hotkey to begin.'),
        'color:#ff3b30;font-weight:bold;',
        'color:inherit;'
      );
      return res;
    } catch (err) {
      clearIsolation();
      throw err;
    }
  }

  async function stop() {
    const res = await send('STOP_CAPTURE', {});
    clearIsolation();
    return res;
  }

  async function config(opts) {
    if (opts && typeof opts === 'object') {
      userDefaults = { ...userDefaults, ...opts };
    }
    return { ...userDefaults };
  }

  async function status() {
    return await send('GET_STATUS', {});
  }

  async function capabilities() {
    return await send('GET_CAPABILITIES', {});
  }

  function help() {
    const lines = [
      'vcap — console-driven tab recording',
      '',
      'quickstart:',
      '  vcap.start(".dialog", { margin: 20, duration: 5000 })',
      '  → press hotkey to begin; auto-stops after duration, or vcap.stop()',
      '',
      'methods:',
      '  vcap.start(selector?, opts?)  arm a capture',
      '  vcap.stop()                   stop the current recording',
      '  vcap.config(opts)             set session defaults',
      '  vcap.status()                 { mode: idle | armed | recording }',
      '  vcap.capabilities()           { mp4, webmVp9, ... }',
      '  vcap.help()                   this message',
      '',
      'options (see extension options page for full reference):',
      '  selector       CSS selector, must be unique',
      '  margin         px around element, default 0',
      '  scale          0.5 | 1 | 2 — output px per CSS px, default 2',
      '  duration       ms, null = manual stop',
      '  format         auto | mp4 | webm',
      '  isolate        false | "hide" | "clone"',
      '  background     "transparent" | CSS color — isolate only',
      '  stripEffects   strip filter/shadow/backdrop on ancestors',
      '  scrollIntoView scroll target into view first, default true',
    ];
    console.log(lines.join('\n'));
  }

  // Listen for service-worker-broadcast events so isolation can be cleared
  // when a recording ends via the hotkey (not just via vcap.stop()).
  window.addEventListener('__vcap_event__', (e) => {
    const { type } = e.detail || {};
    if (type === 'VCAP_EVENT:stopped') {
      clearIsolation();
    }
  });

  window.vcap = Object.freeze({ start, stop, config, status, capabilities, help });

  // quiet ready marker — only logs once per page load
  console.log(
    '%cvcap%c ready. vcap.help() for usage.',
    'color:#ff3b30;font-weight:bold;',
    'color:inherit;'
  );
})();

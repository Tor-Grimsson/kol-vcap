// content-isolated.js — runs in the extension's ISOLATED world.
// Bridges CustomEvents from content-main.js (page world) to the service worker.

const OUT = '__vcap_out__';
const IN = '__vcap_in__';

function reply(id, ok, dataOrError) {
  const detail = ok ? { id, ok: true, data: dataOrError } : { id, ok: false, error: dataOrError };
  window.dispatchEvent(new CustomEvent(IN, { detail }));
}

window.addEventListener(OUT, async (e) => {
  const { id, action, payload } = e.detail || {};
  try {
    const response = await chrome.runtime.sendMessage({ type: action, payload });
    if (!response) {
      reply(id, false, 'no response from background (extension may have reloaded)');
      return;
    }
    if (response.ok) {
      reply(id, true, response.data ?? response);
    } else {
      reply(id, false, response.error || 'unknown error');
    }
  } catch (err) {
    reply(id, false, err?.message || String(err));
  }
});

// Listen for SW-pushed events (recording started, stopped, errors) and
// broadcast into the page as a custom event the page API can subscribe to.
chrome.runtime.onMessage.addListener((msg) => {
  if (!msg || !msg.type || !msg.type.startsWith('VCAP_EVENT:')) return;
  window.dispatchEvent(
    new CustomEvent('__vcap_event__', { detail: { type: msg.type, payload: msg.payload } })
  );
});

// Shared config schema. Imported by background/options.
// Content scripts duplicate these (they can't import modules directly in MV3).

export const DEFAULT_CONFIG = {
  // targeting
  selector: null,          // CSS selector, null = entire viewport
  isolate: false,          // false | 'hide' | 'clone'
  background: null,        // 'transparent' | CSS color string — isolate-only
  stripEffects: false,     // remove filter/shadow/backdrop on ancestors
  margin: 0,               // px around the element
  scrollIntoView: true,    // scroll target into viewport before recording
  trackElement: false,     // crop follows moving element (v2, unused)

  // output
  scale: 2,                // output px per CSS px — 0.5, 1, or 2
  duration: null,          // ms, null = manual stop
  format: 'auto',          // 'auto' | 'mp4' | 'webm'
  filename: null,          // null = auto-generated
};

export const STORAGE_KEYS = {
  DEFAULTS: 'vcap:defaults',
  HISTORY: 'vcap:history',
  VERSION: 'vcap:version',
  CODEC: 'vcap:codec', // last mime that successfully started; duplicated inline in offscreen.js
};

export const SCHEMA_VERSION = 1;

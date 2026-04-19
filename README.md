# vcap

Console-driven skinless tab recording for Chromium browsers. Type `vcap.start()` in DevTools, press the hotkey, get an mp4 or webm out — no browser chrome, no "share this tab" prompt, no overlay UI.

```
vcap.start('.dialog', { margin: 20, duration: 5000 })
→ press ⌘⇧V (mac) / Ctrl+Shift+V (win/linux) to begin
```

## install (dev / unpacked)

1. Open `chrome://extensions`
2. Toggle **Developer mode** (top right)
3. **Load unpacked** → select this folder
4. Open any page, open DevTools → Console, type `vcap.help()`

## file layout

```
vcap/
├── manifest.json           Manifest V3 config
├── background.js           service worker — hotkey, orchestration
├── content-main.js         MAIN-world script — window.vcap API
├── content-isolated.js     ISOLATED-world bridge to the service worker
├── offscreen.html/js       MediaRecorder host (MV3 needs a DOM context)
├── lib/config.js           shared defaults + storage keys
├── options/                reference + settings page
└── icons/                  16/48/128 PNGs
```

## architecture

```
page console         ISOLATED world          service worker          offscreen doc
────────────         ──────────────          ──────────────          ─────────────
vcap.start()  ───►   CustomEvent      ───►   PREPARE_CAPTURE
                                             (stores config)
                                                    │
                                                    ▼
                                             waits for hotkey
                                                    │
hotkey pressed                                      ▼
                                             tabCapture.getMediaStreamId
                                                    │
                                                    ▼
                                             OFFSCREEN_START    ───►    MediaRecorder
                                                                        cropping via canvas
                                                                             │
vcap.stop() or hotkey ────►  STOP_CAPTURE  ───►   OFFSCREEN_STOP ───►    blob out
                                                                             │
                                             RECORDING_COMPLETE  ◄──────────┘
                                                    │
                                                    ▼
                                             chrome.downloads → file
```

## why the hotkey

Chrome's `tabCapture` API requires a real user gesture (action click, registered command, or context menu) to start a capture. A console call to `vcap.start()` doesn't qualify — that's enforced by the browser for security, and no extension can bypass it. So the pattern is: console *arms* the capture with all its options, hotkey *triggers* it.

## format notes

- Opaque recording → mp4 / h264 by default (Chrome 126+)
- `background: 'transparent'` → forces webm / vp9 (h264 has no alpha)
- For DaVinci-friendly transparent clips, transcode webm → ProRes 4444 with ffmpeg post-record (recipe in the options page)

## permissions

`tabCapture`, `activeTab`, `offscreen`, `storage`, `downloads`, `scripting`, host `<all_urls>`. The `<all_urls>` is required so `window.vcap` is present in every page's console. Nothing is transmitted off-device.

## scope for v0.1 and beyond

**In v0.1:**
- All core options (selector, margin, scale, duration, format, scrollIntoView)
- `isolate: 'hide'` + `stripEffects`
- Auto-stop via duration, manual stop via hotkey/`vcap.stop()`
- Options page: reference, editable defaults, capabilities probe, recording history, recipes
- mp4 / webm output with smart defaults

**Deferred / stubs:**
- `isolate: 'clone'` (falls back to `'hide'` with a warning)
- `trackElement: true` (crop follows moving elements)
- Supersampling above device DPR (needs `debugger` permission, opt-in later)
- Native messaging for ffmpeg pipeline (out of scope — transcode externally)

## hacking on it

Edit files → refresh the extension card in `chrome://extensions` → reload the tab you're testing on. No build step. If you change the manifest or service worker, re-click reload on the extension card. If `vcap` doesn't appear in the console, check that the content script matches the URL (some `chrome://` and extension-gallery pages refuse injection by design).

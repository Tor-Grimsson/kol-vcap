// Bundles the extension into a versioned zip for the landing page to serve.
// Runs before `astro dev` and `astro build` via package.json hooks.
//
// Output: web/public/vcap-<version>.zip
// Zip structure: vcap/ at root, so recipients can drag-load-unpacked the
// extracted folder directly.
//
// Uses an explicit whitelist — only the files/folders actually part of the
// extension get included. Robust across environments (local mac, Vercel
// build image, etc.) because it doesn't depend on filesystem layout or the
// system `zip` CLI.

import { createWriteStream, readFileSync, mkdirSync, readdirSync, rmSync, statSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import archiver from 'archiver';

const __dirname = fileURLToPath(new URL('.', import.meta.url));
const webDir = resolve(__dirname, '..');
const repoRoot = resolve(webDir, '..');
const publicDir = resolve(webDir, 'public');

// Read version from the extension's manifest.
const manifest = JSON.parse(readFileSync(join(repoRoot, 'manifest.json'), 'utf8'));
const version = manifest.version;
const zipName = `vcap-${version}.zip`;
const zipPath = join(publicDir, zipName);

mkdirSync(publicDir, { recursive: true });

// Clean out any existing vcap-*.zip so stale versions don't pile up.
for (const f of readdirSync(publicDir)) {
  if (/^vcap-.*\.zip$/.test(f)) {
    rmSync(join(publicDir, f));
  }
}

// Explicit whitelist of what goes in the extension zip.
// Anything outside this list — docs/, web/, .git/, node_modules/, .pnpm-store/,
// .claude/, LLM_RULES.md, etc. — is automatically excluded.
const INCLUDE = [
  { type: 'file', name: 'manifest.json' },
  { type: 'file', name: 'background.js' },
  { type: 'file', name: 'content-main.js' },
  { type: 'file', name: 'content-isolated.js' },
  { type: 'file', name: 'offscreen.html' },
  { type: 'file', name: 'offscreen.js' },
  { type: 'dir', name: 'lib' },
  { type: 'dir', name: 'icons' },
  { type: 'dir', name: 'options' },
];

console.log(`[pack-extension] building ${zipName}`);

const output = createWriteStream(zipPath);
const archive = archiver('zip', { zlib: { level: 9 } });

archive.on('warning', (err) => {
  if (err.code === 'ENOENT') console.warn('[pack-extension] warning:', err);
  else throw err;
});
archive.on('error', (err) => {
  throw err;
});

archive.pipe(output);

for (const item of INCLUDE) {
  const src = join(repoRoot, item.name);
  const dest = `vcap/${item.name}`;
  if (item.type === 'file') {
    archive.file(src, { name: dest });
  } else {
    archive.directory(src, dest);
  }
}

// Await finalize + stream close before reporting size.
await new Promise((resolveClose, rejectClose) => {
  output.on('close', resolveClose);
  output.on('error', rejectClose);
  archive.finalize();
});

const size = (statSync(zipPath).size / 1024).toFixed(1);
console.log(`[pack-extension] wrote ${zipPath} (${size} KB)`);

// Bundles the extension into a versioned zip for the landing page to serve.
// Runs before `astro dev` and `astro build` via package.json hooks.
//
// Output: web/public/vcap-<version>.zip
// Zip structure: vcap/ at root, so recipients can drag-load-unpacked the
// extracted folder directly.

import { execSync } from 'node:child_process';
import { readFileSync, mkdirSync, readdirSync, rmSync, statSync } from 'node:fs';
import { resolve, join, basename } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = fileURLToPath(new URL('.', import.meta.url));
const webDir = resolve(__dirname, '..');
const repoRoot = resolve(webDir, '..');
const repoParent = resolve(repoRoot, '..');
const repoName = basename(repoRoot);
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

// Paths are all relative to repoParent so the archive contains `vcap/...`.
const excludes = [
  `${repoName}/web/*`,
  `${repoName}/docs/*`,
  `${repoName}/.git/*`,
  `${repoName}/.claude/*`,
  `${repoName}/_a-torg/*`,
  `${repoName}/init-repo-protocol/*`,
  `${repoName}/LLM_RULES.md`,
  `${repoName}/.DS_Store`,
  `${repoName}/**/.DS_Store`,
  `${repoName}/node_modules/*`,
  `${repoName}/pnpm-lock.yaml`,
];

const excludeArgs = excludes.map((e) => `-x "${e}"`).join(' ');
const cmd = `cd "${repoParent}" && zip -r "${zipPath}" "${repoName}" ${excludeArgs}`;

console.log(`[pack-extension] building ${zipName}`);
execSync(cmd, { stdio: 'inherit' });

const size = (statSync(zipPath).size / 1024).toFixed(1);
console.log(`[pack-extension] wrote ${zipPath} (${size} KB)`);

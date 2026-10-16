import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const PKG = '@earendil-works/pi-coding-agent';

// The tests drive the real installed Pi runtime rather than a mock, so they need
// its package directory. Discovery is deliberately ordered from cheapest and
// most certain to broadest, and never assumes a Node version manager.
function usable(dir) {
  return dir && fs.existsSync(path.join(dir, 'dist/index.js')) ? dir : undefined;
}

export function findPiRoot() {
  for (const name of ['PI_TEST_ROOT', 'PI_ROOT']) {
    const value = process.env[name];
    if (!value) continue;
    const hit = usable(path.resolve(value));
    if (hit) return hit;
    throw new Error(`${name} points at ${value}, which is not an installed ${PKG} package (no dist/index.js).`);
  }

  const candidates = [];
  // Global installs: the package sits beside the node binary that is running us.
  let nodeBin = process.execPath;
  try { nodeBin = fs.realpathSync(nodeBin); } catch {}
  candidates.push(path.resolve(path.dirname(nodeBin), `../lib/node_modules/${PKG}`));
  // A local copy in this checkout (`npm install --no-save @earendil-works/pi-coding-agent`).
  candidates.push(fileURLToPath(new URL(`./node_modules/${PKG}`, import.meta.url)));
  // Whatever prefix npm actually uses — covers Homebrew, asdf, Volta and custom prefixes.
  try {
    const root = execFileSync('npm', ['root', '-g'], { encoding: 'utf8', timeout: 20000 }).trim();
    if (root) candidates.push(path.join(root, PKG));
  } catch {}
  // nvm installations, newest first (numeric so v9 does not outrank v10).
  const nvmVersions = path.join(process.env.NVM_DIR ?? path.join(os.homedir(), '.nvm'), 'versions/node');
  if (fs.existsSync(nvmVersions)) {
    for (const v of fs.readdirSync(nvmVersions).sort((a, b) => b.localeCompare(a, undefined, { numeric: true }))) {
      candidates.push(path.join(nvmVersions, v, 'lib/node_modules', PKG));
    }
  }

  for (const candidate of candidates) {
    const hit = usable(candidate);
    if (hit) return hit;
  }
  throw new Error(
    `Pi runtime not found. Install ${PKG} (npm install -g ${PKG}) or set PI_TEST_ROOT ` +
    `to the installed package directory. Looked in:\n  ${[...new Set(candidates)].join('\n  ')}`,
  );
}

// Writes apps/server/dist/build-info.json so the running worker can report
// exactly which commit it was built from (capability/version handshake).
// Best-effort: never fails the build when git is unavailable.
import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const packageDir = path.resolve(here, '..');
const distDir = path.join(packageDir, 'dist');

function git(args) {
  try {
    return execFileSync('git', args, { cwd: packageDir, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], windowsHide: true }).trim() || null;
  } catch {
    return null;
  }
}

function packageVersion() {
  try {
    const pkg = JSON.parse(readFileSync(path.join(packageDir, 'package.json'), 'utf8'));
    return typeof pkg.version === 'string' ? pkg.version : '0.0.0';
  } catch {
    return '0.0.0';
  }
}

const commit = git(['rev-parse', 'HEAD']);
let dirty = null;
if (commit) {
  try {
    const porcelain = execFileSync('git', ['status', '--porcelain'], { cwd: packageDir, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], windowsHide: true });
    dirty = porcelain.trim().length > 0;
  } catch {
    dirty = null;
  }
}

mkdirSync(distDir, { recursive: true });
writeFileSync(
  path.join(distDir, 'build-info.json'),
  JSON.stringify({ commit, builtAt: new Date().toISOString(), dirty, packageVersion: packageVersion() }, null, 2) + '\n',
);
console.log(`[build-info] commit=${commit ?? 'unknown'} dirty=${String(dirty)}`);

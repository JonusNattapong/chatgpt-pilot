import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export interface BuildInfo {
  commit: string | null;
  builtAt: string | null;
  dirty: boolean | null;
  packageVersion: string;
}

const here = path.dirname(fileURLToPath(import.meta.url));

/** dist/build-info.json written by scripts/write-build-info.mjs at build time. */
export function loadBuildInfo(): BuildInfo {
  const fallback: BuildInfo = { commit: null, builtAt: null, dirty: null, packageVersion: '0.0.0' };
  try {
    const raw = readFileSync(path.join(here, 'build-info.json'), 'utf8');
    const parsed = JSON.parse(raw) as Partial<BuildInfo>;
    return {
      commit: typeof parsed.commit === 'string' ? parsed.commit : null,
      builtAt: typeof parsed.builtAt === 'string' ? parsed.builtAt : null,
      dirty: typeof parsed.dirty === 'boolean' ? parsed.dirty : null,
      packageVersion: typeof parsed.packageVersion === 'string' ? parsed.packageVersion : fallback.packageVersion,
    };
  } catch {
    return fallback;
  }
}

/** HEAD of the checkout this dist was built from (best-effort, null when unavailable). */
export function headCommit(cwd?: string): string | null {
  try {
    const repoRoot = cwd ?? path.resolve(here, '..', '..', '..');
    const out = execFileSync('git', ['-C', repoRoot, 'rev-parse', 'HEAD'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
      windowsHide: true,
    }).trim();
    return out.length > 0 ? out : null;
  } catch {
    return null;
  }
}

export function buildInfoPath(): string {
  return path.join(here, 'build-info.json');
}

export function hasBuildInfo(): boolean {
  return existsSync(buildInfoPath());
}

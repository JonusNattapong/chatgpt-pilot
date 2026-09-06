// Detached post-response restarter for restart_if_stale / self_update.
// A worker cannot survive its own restart, so control tools return first and
// this helper (spawned detached + unrefed) does the rest:
//   1. wait for the tool response to flush,
//   2. terminate the old worker (the supervisor respawns it from current dist),
//   3. wait for a fresh ready worker,
//   4. run a --check handshake and write a receipt.
// Usage: node apply-restart.mjs <workerPid> <receiptPath> <expectedCommit> <distIndex>
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';

const [workerPidRaw, receiptPath, expectedCommitRaw, distIndex] = process.argv.slice(2);
const workerPid = Number(workerPidRaw);
const expectedCommit = expectedCommitRaw && expectedCommitRaw.length > 0 ? expectedCommitRaw : null;

function writeReceipt(record) {
  try {
    mkdirSync(path.dirname(receiptPath), { recursive: true });
    writeFileSync(receiptPath, JSON.stringify({ ...record, at: new Date().toISOString() }, null, 2) + '\n');
  } catch {
    /* receipt is best-effort */
  }
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function pidAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function killWorker(pid) {
  try {
    if (process.platform === 'win32') {
      spawnSync('taskkill.exe', ['/pid', String(pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true });
    } else {
      process.kill(pid, 'SIGTERM');
    }
  } catch {
    /* already gone */
  }
}

function readState(candidates) {
  for (const file of candidates) {
    try {
      const state = JSON.parse(readFileSync(file, 'utf8'));
      if (state && typeof state === 'object') return { file, state };
    } catch {
      /* unreadable */
    }
  }
  return null;
}

async function main() {
  const repoDir = path.resolve(path.dirname(distIndex), '..', '..', '..');
  const candidates = [
    path.join(repoDir, 'apps', 'server', '.pilot', 'supervisor.json'),
    path.join(repoDir, '.pilot', 'supervisor.json'),
    path.join(repoDir, 'apps', 'server', '.chatgpt-machine', 'supervisor.json'),
    path.join(repoDir, '.chatgpt-machine', 'supervisor.json'),
  ];
  writeReceipt({ state: 'restarting', workerPidBefore: workerPid, expectedCommit });
  await sleep(2500);
  killWorker(workerPid);
  const deadline = Date.now() + 90_000;
  let fresh = null;
  while (Date.now() < deadline) {
    await sleep(3000);
    const found = readState(candidates);
    if (
      found &&
      found.state.ready === true &&
      typeof found.state.workerPid === 'number' &&
      found.state.workerPid !== workerPid &&
      pidAlive(found.state.workerPid)
    ) {
      fresh = found.state;
      break;
    }
  }
  if (!fresh) {
    writeReceipt({ state: 'degraded', workerPidBefore: workerPid, expectedCommit, error: 'no fresh ready worker observed within 90s' });
    return;
  }
  let build = null;
  try {
    const out = execFileSync(process.execPath, [distIndex, '--check'], { encoding: 'utf8', timeout: 120_000, windowsHide: true });
    const parsed = JSON.parse(out);
    build = parsed.build ?? null;
  } catch (error) {
    writeReceipt({ state: 'degraded', workerPidBefore: workerPid, workerPidAfter: fresh.workerPid, error: `post-restart --check failed: ${String(error).slice(0, 500)}` });
    return;
  }
  const match = expectedCommit === null || (build && build.commit === expectedCommit);
  writeReceipt({
    state: match ? 'ready' : 'degraded',
    workerPidBefore: workerPid,
    workerPidAfter: fresh.workerPid,
    expectedCommit,
    build,
    ...(match ? {} : { error: `worker serves ${build?.commit ?? 'unknown'}, expected ${expectedCommit}` }),
  });
}

await main();

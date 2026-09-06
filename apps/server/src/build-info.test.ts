import assert from 'node:assert/strict';
import test from 'node:test';
import { hasBuildInfo, headCommit, loadBuildInfo } from './build-info.js';

test('build info loader returns a well-shaped record', () => {
  const info = loadBuildInfo();
  assert.ok(info && typeof info === 'object');
  assert.ok(info.commit === null || /^[0-9a-f]{40}$/.test(info.commit), `unexpected commit: ${info.commit}`);
  assert.ok(info.builtAt === null || !Number.isNaN(Date.parse(info.builtAt)), `unexpected builtAt: ${info.builtAt}`);
  assert.ok(info.dirty === null || typeof info.dirty === 'boolean');
  assert.ok(typeof info.packageVersion === 'string' && info.packageVersion.length > 0);
});

test('build info file exists after a real build', () => {
  assert.equal(hasBuildInfo(), true, 'dist/build-info.json should be written by prebuild');
  const info = loadBuildInfo();
  assert.ok(info.commit !== null, 'commit should be known inside a git checkout');
});

test('head commit resolves inside a git checkout', () => {
  const head = headCommit();
  assert.ok(head === null || /^[0-9a-f]{40}$/.test(head), `unexpected HEAD: ${head}`);
});

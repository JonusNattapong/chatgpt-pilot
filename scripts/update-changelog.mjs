#!/usr/bin/env node

import { execSync } from 'node:child_process';
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import path from 'node:path';

function getGitCommits() {
  try {
    // Get tags sorted by date
    let lastTag = '';
    try {
      lastTag = execSync('git describe --tags --abbrev=0', { encoding: 'utf8' }).trim();
    } catch {
      // No tags yet
    }

    const range = lastTag ? `${lastTag}..HEAD` : 'HEAD';
    const logOutput = execSync(`git log ${range} --pretty=format:"%H|%s|%an|%ad" --date=short`, {
      encoding: 'utf8',
    }).trim();

    if (!logOutput) return [];

    return logOutput.split('\n').map((line) => {
      const [hash, subject, author, date] = line.split('|');
      return { hash: hash?.trim(), subject: subject?.trim(), author: author?.trim(), date: date?.trim() };
    });
  } catch (error) {
    console.error('Failed to get git log:', error);
    return [];
  }
}

function parseCommit(subject = '') {
  const match = subject.match(/^([a-zA-Z0-9_-]+)(?:\(([^)]+)\))?:\s*(.+)$/);
  if (!match) {
    return { type: 'other', scope: '', message: subject };
  }
  return {
    type: match[1].toLowerCase(),
    scope: match[2] || '',
    message: match[3],
  };
}

const CATEGORY_ORDER = ['feat', 'fix', 'docs', 'refactor', 'test', 'ci', 'chore', 'other'];

function emptyCategories() {
  return {
    feat: { title: '✨ Features', items: [] },
    fix: { title: '🐛 Bug Fixes', items: [] },
    docs: { title: '📚 Documentation', items: [] },
    refactor: { title: '♻️ Refactoring & Performance', items: [] },
    test: { title: '🧪 Testing & Verification', items: [] },
    ci: { title: '⚙️ CI/CD & Tooling', items: [] },
    chore: { title: '🧹 Chores & Maintenance', items: [] },
    other: { title: '🔨 Other Changes', items: [] },
  };
}

function shortHashOf(commit) {
  return commit.hash ? commit.hash.slice(0, 7) : '';
}

function formatEntry(commit) {
  const parsed = parseCommit(commit.subject);
  const scopePrefix = parsed.scope ? `**${parsed.scope}**: ` : '';
  const shortHash = shortHashOf(commit) ? ` (\`${shortHashOf(commit)}\`)` : '';
  return { key: parsed.type in emptyCategories() ? parsed.type : 'other', line: `- ${scopePrefix}${parsed.message}${shortHash}` };
}

function categorize(commits) {
  const categories = emptyCategories();
  for (const c of commits) {
    const entry = formatEntry(c);
    categories[entry.key].items.push(entry.line);
  }
  return CATEGORY_ORDER.map((key) => ({ key, ...categories[key] })).filter((cat) => cat.items.length > 0);
}

function generateChangelogSection(version, date, commits) {
  const categories = categorize(commits);

  let section = `## [${version}] - ${date}\n\n`;

  if (categories.length === 0) {
    section += `- Maintenance and internal stability updates.\n\n`;
    return section;
  }

  for (const cat of categories) {
    section += `### ${cat.title}\n\n${cat.items.join('\n')}\n\n`;
  }

  return section;
}

// Merge fresh entries into an existing `## [version]` section instead of
// prepending a duplicate section. Returns the updated content, or null when
// no matching version section exists (caller then prepends a new section).
function mergeIntoVersionSection(content, version, commits) {
  const groups = categorize(commits);
  if (groups.length === 0) return content;
  const head = `## [${version}]`;
  const start = content.indexOf(head);
  if (start === -1) return null;
  const nextSection = content.indexOf('\n## [', start + head.length);
  const end = nextSection === -1 ? content.length : nextSection + 1;
  let section = content.slice(start, end);
  for (const group of groups) {
    const catHead = `### ${group.title}`;
    const at = section.indexOf(catHead);
    if (at === -1) {
      section = section.replace(/\s*$/, '') + `\n\n${catHead}\n\n${group.items.join('\n')}\n`;
    } else {
      const lineEnd = section.indexOf('\n', at) + 1;
      const blankEnd = section.indexOf('\n\n', lineEnd);
      const catEnd = section.indexOf('\n### ', lineEnd);
      const insertAt = blankEnd !== -1 && (catEnd === -1 || blankEnd < catEnd) ? blankEnd : (catEnd === -1 ? section.length : catEnd);
      section = section.slice(0, insertAt) + `\n${group.items.join('\n')}` + section.slice(insertAt);
    }
  }
  return content.slice(0, start) + section + content.slice(end);
}

export function updateChangelog(newVersion) {
  const pkgPath = path.resolve('package.json');
  const pkg = JSON.parse(readFileSync(pkgPath, 'utf8'));
  const version = newVersion || pkg.version || '1.0.0';
  const today = new Date().toISOString().split('T')[0];

  const commits = getGitCommits();
  if (commits.length === 0) {
    console.log('No new commits found to generate changelog.');
    return;
  }

  const changelogPath = path.resolve('CHANGELOG.md');
  const currentContent = existsSync(changelogPath) ? readFileSync(changelogPath, 'utf8') : '';

  // Idempotency: `git log` covers the whole untagged history, so skip
  // commits whose short hash is already recorded. Re-running the script
  // must never duplicate sections or entries.
  const fresh = commits.filter((c) => {
    const short = shortHashOf(c);
    return short !== '' && !currentContent.includes(`\`${short}\``);
  });
  if (fresh.length === 0) {
    console.log('[Changelog] Already up to date; no new commits to record.');
    return;
  }

  const merged = mergeIntoVersionSection(currentContent, version, fresh);
  if (merged !== null && merged !== currentContent) {
    writeFileSync(changelogPath, merged, 'utf8');
    console.log(`[Changelog] Merged ${fresh.length} new commit(s) into existing ## [${version}] section.`);
    return;
  }

  const newSection = generateChangelogSection(version, today, fresh);

  // If header exists, inject after header
  let updatedContent = '';
  const headerMarker = '# Changelog\n\nAll notable changes to `chatgpt-pilot` are documented in this file.\n\nThe format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),\nand this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).\n\n---\n\n';

  if (currentContent.startsWith('# Changelog')) {
    const afterHeader = currentContent.replace(/^# Changelog[\s\S]*?---\n\n/, '');
    updatedContent = headerMarker + newSection + afterHeader;
  } else {
    updatedContent = headerMarker + newSection + currentContent;
  }

  writeFileSync(changelogPath, updatedContent, 'utf8');
  console.log(`[Changelog] Successfully updated CHANGELOG.md for version ${version} (${today}) with ${commits.length} commits.`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'))) {
  const versionArg = process.argv[2];
  updateChangelog(versionArg);
}

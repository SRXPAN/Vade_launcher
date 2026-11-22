import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { JobHistoryEntry, JobState } from '@vade/protocol';
import { findProblemPcs, HistoryStore, pruneHistory } from '../src/main/history';
import { AdminStore } from '../src/main/store';

const dirs: string[] = [];
const tmpDir = () => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'vade-history-'));
  dirs.push(d);
  return d;
};
afterEach(() => {
  for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
});

function makeJob(id: string, finishedAt: string, result: 'ok' | 'errors' | 'cancelled' = 'ok', errors = 0): JobState {
  const startMs = Date.parse(finishedAt) - 120_000;
  return {
    id,
    mode: 'scheduled',
    startedAt: new Date(startMs).toISOString(),
    finishedAt,
    steps: [],
    apps: [
      { appId: 730, name: 'Counter-Strike 2', library: 'C:\\Steam', status: 'ok' },
      ...(result === 'errors' ? [{ appId: 570, name: 'Dota 2', library: 'C:\\Steam', status: 'error' as const, message: 'Disk full' }] : []),
    ],
    progress: null,
    errors,
    result,
  };
}

describe('Job history store (history.json)', () => {
  it('prunes entries older than retentionDays (14 days default) and keeps newest first', () => {
    const now = Date.parse('2026-11-22T12:00:00Z');
    const oldEntry: JobHistoryEntry = {
      id: 'old',
      pcId: 1,
      startedAt: '2026-11-01T02:00:00Z',
      finishedAt: '2026-11-01T02:05:00Z',
      durationSec: 300,
      mode: 'scheduled',
      result: 'ok',
      updatedApps: 2,
      errorApps: [],
      errors: 0,
    };
    const recentEntry: JobHistoryEntry = {
      id: 'new',
      pcId: 2,
      startedAt: '2026-11-20T02:00:00Z',
      finishedAt: '2026-11-20T02:04:00Z',
      durationSec: 240,
      mode: 'scheduled',
      result: 'errors',
      updatedApps: 1,
      errorApps: [{ appId: 570, name: 'Dota 2', status: 'error', message: 'Disk full' }],
      errors: 1,
    };
    expect(pruneHistory([oldEntry, recentEntry], 14, now).map((e) => e.id)).toEqual(['new']);
    expect(pruneHistory([oldEntry, recentEntry], 30, now).map((e) => e.id)).toEqual(['new', 'old']);
  });

  it('persists atomically, deduplicates by pcId+jobId, reloads, and flags problem PCs (2+ errors in 7 days)', () => {
    const dir = tmpDir();
    const store = new AdminStore(dir);
    const now = Date.now();
    const dayAgo = new Date(now - 86_400_000).toISOString();
    const twoDaysAgo = new Date(now - 2 * 86_400_000).toISOString();
    const tenDaysAgo = new Date(now - 10 * 86_400_000).toISOString();
    const twentyDaysAgo = new Date(now - 20 * 86_400_000).toISOString();

    expect(store.recordJobHistory(5, makeJob('j1', dayAgo, 'errors', 1))).toBe(true);
    // Duplicate job ignored
    expect(store.recordJobHistory(5, makeJob('j1', dayAgo, 'errors', 1))).toBe(false);
    expect(store.recordJobHistory(5, makeJob('j2', twoDaysAgo, 'errors', 1))).toBe(true);
    // PC 6 has only 1 recent error + 1 older than 7 days -> not flagged as problem PC
    expect(store.recordJobHistory(6, makeJob('j3', dayAgo, 'errors', 1))).toBe(true);
    expect(store.recordJobHistory(6, makeJob('j4', tenDaysAgo, 'errors', 1))).toBe(true);
    // Entry older than 14 days is pruned immediately
    expect(store.recordJobHistory(7, makeJob('j5', twentyDaysAgo, 'ok', 0))).toBe(true);

    expect(fs.existsSync(path.join(dir, 'history.json'))).toBe(true);
    const reloaded = new HistoryStore(path.join(dir, 'history.json'), 14);
    expect(reloaded.entries.some((e) => e.id === 'j5')).toBe(false);
    expect(reloaded.entries).toHaveLength(4);

    const problems = findProblemPcs(reloaded.entries, 7, 2, now);
    expect(problems).toHaveLength(1);
    expect(problems[0]).toMatchObject({ pcId: 5, errorCount: 2, failedApps: ['Dota 2 (570)'] });
  });
});

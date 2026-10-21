import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { mergeFixtures, parseEvent, parseTv, seasonFor, updateFixtures } from '../scripts/update-fixtures.mjs';

test('season follows the UK football season boundary', () => {
  assert.equal(seasonFor(new Date('2026-07-31T12:00:00Z')), '2025-2026');
  assert.equal(seasonFor(new Date('2026-08-01T00:00:00Z')), '2026-2027');
});

test('parses event UTC time and provider identifiers without inventing data', () => {
  const fixture = parseEvent({ idEvent: '42', idHomeTeam: '1', idAwayTeam: '2', strTimestamp: '2026-10-23T19:00:00', strHomeTeam: 'A', strAwayTeam: 'B', strLeague: 'League' }, '2026-10-21');
  assert.equal(fixture.startsAt, Date.parse('2026-10-23T19:00:00Z'));
  assert.equal(fixture.id, 'thesportsdb-42');
  assert.deepEqual(fixture.providerTeamIds, ['1', '2']);
  assert.equal(fixture.tvCoverage, 'partial');
  assert.equal(parseEvent({ idEvent: 43, strTimestamp: '2026-10-23T00:00:00', strHomeTeam: 'A', strAwayTeam: 'B', strStatus: 'Time to be defined' }, '2026-10-21'), null);
  assert.equal(parseEvent({ idEvent: 44, strTimestamp: 'not a date', strHomeTeam: 'A', strAwayTeam: 'B' }, '2026-10-21'), null);
});

test('TV parser trims and deduplicates by country and channel', () => {
  assert.deepEqual(parseTv([
    { strCountry: ' United Kingdom ', strChannel: ' Sky Sports ', idChannel: '5' },
    { strCountry: 'United Kingdom', strChannel: 'Sky Sports', idChannel: '5' },
    { strCountry: 'US', strChannel: 'Peacock' },
    { strCountry: 'France', strChannel: '' },
  ]), [
    { country: 'United Kingdom', channel: 'Sky Sports', providerChannelId: '5' },
    { country: 'US', channel: 'Peacock' },
  ]);
});

test('merge preserves manual fixtures and stale good data for teams whose lookup failed', () => {
  const future = Date.now() + 86_400_000;
  const old = [
    { id: 'manual', startsAt: future + 10, provider: undefined },
    { id: 'thesportsdb-1', startsAt: future, provider: 'TheSportsDB', providerTeamIds: ['1', '2'] },
    { id: 'thesportsdb-2', startsAt: future + 20, provider: 'TheSportsDB', providerTeamIds: ['3', '4'] },
  ];
  const result = mergeFixtures(old, [{ id: 'thesportsdb-3', startsAt: future + 30, provider: 'TheSportsDB', providerTeamIds: ['1', '5'] }], ['2']);
  assert.deepEqual(result.map(f => f.id), ['thesportsdb-1', 'manual', 'thesportsdb-3']);
});

test('failed/incomplete live refresh never overwrites prior data', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'same-end-fixtures-'));
  const path = join(dir, 'fixtures.json');
  const prior = { checkedAt: '2026-10-20', fixtures: [{ id: 'manual', title: 'Keep me' }] };
  try {
    await import('node:fs/promises').then(fs => fs.writeFile(path, JSON.stringify(prior)));
    const fetchImpl = async () => ({ ok: true, json: async () => ({ events: [] }) });
    await assert.rejects(updateFixtures({ output: path, now: new Date('2026-10-21T12:00:00Z'), pauseMs: 0, fetchImpl }), /previous data was preserved/);
    assert.deepEqual(JSON.parse(await readFile(path, 'utf8')), prior);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

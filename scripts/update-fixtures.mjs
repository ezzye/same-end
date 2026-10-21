#!/usr/bin/env node
/**
 * Refresh a small, explicitly partial Premier League fixture/channel feed.
 *
 * Source: TheSportsDB v1 documented free key (123), replaceable through
 * THESPORTSDB_API_KEY. The provider documents one event per free schedule
 * team/league call and two TV records per free lookup. We use a bounded
 * 20-team snapshot discovered from the first 15 current-season events, then
 * query each team's next event and those events' TV records sequentially.
 * This is not a full fixture or broadcaster-availability service. Keep the
 * provider attribution and source links. The provider's free terms describe
 * lookup for development projects and prohibit app-store publication without
 * a paid subscription; this script does not grant commercial/app-store rights.
 * API documentation: https://www.thesportsdb.com/docs_api_guide.php
 * Terms: https://www.thesportsdb.com/docs_terms_of_use.php
 */

import { readFile, writeFile, rename } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const DEFAULT_OUTPUT = resolve(ROOT, 'fixtures.json');
const BASE = 'https://www.thesportsdb.com/api/v1/json';
const LEAGUE_ID = '4328';
const MAX_TEAMS = 20;
const MAX_TV_LOOKUPS = 20;
// Stay below the provider's observed public-key throttle (rapid bursts returned
// HTTP 429); slow down further whenever Retry-After is supplied.
const PAUSE_MS = 6_500;
const TIMEOUT_MS = 12_000;
const MIN_FIXTURES_TO_REPLACE = 5;

export function seasonFor(date = new Date()) {
  const year = date.getUTCFullYear();
  const start = date.getUTCMonth() >= 7 ? year : year - 1;
  return `${start}-${start + 1}`;
}

// TheSportsDB's public schedule is served in UTC (its documentation site
// declares UTC); its timestamp strings omit the zone, so make it explicit.
function utcMillis(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d\d-\d\d[T ]\d\d:\d\d(?::\d\d)?$/.test(value)) return NaN;
  const normalized = value.replace(' ', 'T');
  return Date.parse(`${normalized}Z`);
}

export function parseEvent(event, checkedAt) {
  if (!event || !/^\d+$/.test(String(event.idEvent || ''))) return null;
  const startsAt = utcMillis(event.strTimestamp || event.strTimeStamp || '');
  const home = String(event.strHomeTeam || '').trim();
  const away = String(event.strAwayTeam || '').trim();
  if (!Number.isFinite(startsAt) || !home || !away) return null;
  if (/time to be defined|postponed|cancelled|canceled/i.test(String(event.strStatus || ''))) return null;
  const eventId = String(event.idEvent);
  const teamIds = [event.idHomeTeam, event.idAwayTeam].filter(id => /^\d+$/.test(String(id || ''))).map(String);
  return {
    id: `thesportsdb-${eventId}`,
    provider: 'TheSportsDB',
    providerEventId: eventId,
    providerTeamIds: teamIds,
    home,
    away,
    title: `${home} v ${away}`,
    competition: String(event.strLeague || 'Football').trim(),
    startsAt,
    sourceUrl: `https://www.thesportsdb.com/event/${eventId}`,
    checkedAt,
    status: /postponed/i.test(String(event.strPostponed || '')) ? 'postponed' : 'scheduled',
    tv: [],
    tvCoverage: 'partial',
  };
}

export function parseTv(rows) {
  const channels = new Map();
  for (const row of Array.isArray(rows) ? rows : []) {
    const channel = String(row?.strChannel || '').trim();
    const country = String(row?.strCountry || '').trim();
    if (!channel || !country) continue;
    const id = String(row.idChannel || '');
    const key = `${country.toLowerCase()}\u0000${(id || channel).toLowerCase()}`;
    if (!channels.has(key)) channels.set(key, { country, channel, ...(id ? { providerChannelId: id } : {}) });
  }
  return [...channels.values()];
}

export function mergeFixtures(previous, updates, failedTeamIds = []) {
  const failed = new Set(failedTeamIds.map(String));
  const nextById = new Map(updates.map(f => [f.id, f]));
  for (const item of previous) {
    if (item?.provider !== 'TheSportsDB' || !item.id || nextById.has(item.id)) continue;
    const teamIds = (item.providerTeamIds || []).map(String);
    if (teamIds.some(id => failed.has(id)) && (!item.startsAt || item.startsAt > Date.now())) nextById.set(item.id, item);
  }
  const manual = previous.filter(item => item?.provider !== 'TheSportsDB');
  return [...manual, ...nextById.values()].sort((a, b) => Number(a.startsAt) - Number(b.startsAt));
}

function sleep(ms) { return new Promise(resolveSleep => setTimeout(resolveSleep, ms)); }

function semanticHash(fixtures) {
  const normalized = fixtures.map(({ checkedAt, ...fixture }) => fixture);
  return createHash('sha256').update(JSON.stringify(normalized)).digest('hex');
}

function endpoint(apiKey, path, params = {}) {
  const url = new URL(`${BASE}/${encodeURIComponent(apiKey)}/${path}`);
  for (const [key, value] of Object.entries(params)) url.searchParams.set(key, String(value));
  return url.toString();
}

async function readCurrent(path) {
  try {
    const data = JSON.parse(await readFile(path, 'utf8'));
    return data && Array.isArray(data.fixtures) ? data : null;
  } catch (error) {
    if (error.code === 'ENOENT') return { fixtures: [] };
    throw error;
  }
}

async function atomicWrite(path, data) {
  const temp = `${path}.${process.pid}.tmp`;
  await writeFile(temp, `${JSON.stringify(data, null, 2)}\n`, { mode: 0o644 });
  await rename(temp, path);
}

export async function updateFixtures({ output = DEFAULT_OUTPUT, apiKey = process.env.THESPORTSDB_API_KEY || '123', now = new Date(), pauseMs = PAUSE_MS, fetchImpl = fetch } = {}) {
  if (!/^\d+$/.test(String(apiKey))) throw new Error('THESPORTSDB_API_KEY must be numeric.');
  const target = resolve(output);
  const previous = await readCurrent(target);
  if (!previous) throw new Error(`Refusing to replace invalid fixture JSON at ${target}.`);
  const checkedAt = now.toISOString().slice(0, 10);
  const season = seasonFor(now);
  const get = async (path, params) => {
    const url = endpoint(apiKey, path, params);
    for (let attempt = 0; ; attempt++) {
      const response = await fetchImpl(url, { signal: AbortSignal.timeout(TIMEOUT_MS), headers: { 'user-agent': 'SameEnd-FixtureUpdater/1.0', accept: 'application/json' } });
      if (response.status === 429 && attempt < 3) {
        const retryAfter = response.headers?.get?.('retry-after');
        const seconds = Number(retryAfter);
        const dateDelay = retryAfter && !Number.isFinite(seconds) ? Date.parse(retryAfter) - Date.now() : NaN;
        const delay = Math.max(PAUSE_MS, Number.isFinite(seconds) ? seconds * 1000 : Number.isFinite(dateDelay) ? dateDelay : 15_000 * (2 ** attempt));
        console.warn(`TheSportsDB rate limit reached for ${path}; retrying after ${Math.ceil(delay / 1000)}s.`);
        await sleep(delay);
        continue;
      }
      if (!response.ok) throw new Error(`TheSportsDB HTTP ${response.status} for ${path}`);
      const data = await response.json();
      if (!data || typeof data !== 'object' || Array.isArray(data)) throw new Error(`TheSportsDB returned invalid ${path} JSON.`);
      return data;
    }
  };
  const rosterData = await get('eventsseason.php', { id: LEAGUE_ID, s: season });
  const rosterEvents = Array.isArray(rosterData.events) ? rosterData.events : [];
  const teamMap = new Map();
  for (const event of rosterEvents) {
    for (const [id, name] of [[event.idHomeTeam, event.strHomeTeam], [event.idAwayTeam, event.strAwayTeam]]) {
      if (/^\d+$/.test(String(id || '')) && name) teamMap.set(String(id), String(name).trim());
    }
  }
  if (teamMap.size < MAX_TEAMS) throw new Error(`Only ${teamMap.size} teams were returned for Premier League season ${season}; previous data was preserved.`);

  const events = new Map();
  const failedTeamIds = [];
  for (const teamId of [...teamMap.keys()].slice(0, MAX_TEAMS)) {
    try {
      const data = await get('eventsnext.php', { id: teamId });
      for (const event of Array.isArray(data.events) ? data.events : []) {
        const parsed = parseEvent(event, checkedAt);
        if (parsed && parsed.startsAt > now.getTime() && parsed.startsAt < now.getTime() + 365 * 86_400_000) events.set(parsed.id, parsed);
      }
    } catch (error) {
      failedTeamIds.push(teamId);
      console.warn(`Keeping prior schedule for ${teamMap.get(teamId)} (${teamId}): ${error.message}`);
    }
    if (pauseMs) await sleep(pauseMs);
  }

  const fixtures = [...events.values()].sort((a, b) => a.startsAt - b.startsAt);
  if (fixtures.length < MIN_FIXTURES_TO_REPLACE) throw new Error(`Only ${fixtures.length} current fixtures returned; previous data was preserved.`);
  for (const fixture of fixtures.slice(0, MAX_TV_LOOKUPS)) {
    try {
      const data = await get('lookuptv.php', { id: fixture.providerEventId });
      fixture.tv = parseTv(data.tvevent);
    } catch (error) {
      const old=previous.fixtures.find(f=>f.id===fixture.id);if(old?.tv?.length){fixture.tv=old.tv;fixture.tvCheckedAt=old.tvCheckedAt||old.checkedAt;fixture.tvStale=true;}console.warn(`TV lookup unavailable for ${fixture.title}: ${error.message}`);
    }
    if (pauseMs) await sleep(pauseMs);
  }

  const merged = mergeFixtures(previous.fixtures, fixtures, failedTeamIds);
  const dataHash = semanticHash(merged);
  const unchanged = previous.dataHash === dataHash;
  const outputData = {
    checkedAt,
    fetchedAt: now.toISOString(),
    dataHash,
    timezone: 'UTC',
    provider: 'TheSportsDB',
    providerApi: 'v1',
    attribution: 'Fixture and broadcast metadata from TheSportsDB; coverage is partial and may be incomplete. Confirm each match and channel with the broadcaster before relying on it.',
    coverage: 'partial',
    note: 'Automatically refreshed starter suggestions; not comprehensive. TV channel data can be missing or stale and does not confirm rights, package requirements, or household availability. Verify with the linked source or broadcaster. Add matches manually when absent.',
    fixtures: merged,
  };
  await atomicWrite(target, outputData);
  return { output: target, fetched: fixtures.length, merged: merged.length, failedTeams: failedTeamIds.length, tvListed: fixtures.filter(f => f.tv.length).length };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const arg = process.argv.indexOf('--output');
  const output = arg >= 0 ? resolve(process.argv[arg + 1]) : DEFAULT_OUTPUT;
  updateFixtures({ output }).then(result => {
    console.log(`Fetched ${result.fetched} partial fixtures; ${result.tvListed} have TV listings; ${result.failedTeams} team lookups failed.`);
    console.log(`Wrote ${result.output}`);
  }).catch(error => {
    console.error(`Fixture refresh failed; previous data was preserved. ${error.message}`);
    process.exitCode = 1;
  });
}

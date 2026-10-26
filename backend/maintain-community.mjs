#!/usr/bin/env node
// Explicit operator maintenance only. This file is never bundled into Lambda.
import {createHash} from 'node:crypto';
import {mkdir, writeFile, chmod} from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {DynamoDBStore} from './store.mjs';
import {createCommunityApi, COMMUNITY_LIMITS} from './community-api.mjs';

const PK = 'COMMUNITY#PILOT';
const sha = value => createHash('sha256').update(value).digest('hex');
function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === 'object') return Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])]));
  return value;
}
async function snapshot(store) {
  const rows = await store.query(PK, {from: 'THREAD#', to: 'THREAD#\uffff', limit: COMMUNITY_LIMITS.threads + 1});
  if (rows.length > COMMUNITY_LIMITS.threads) throw new Error('SnapshotBoundExceeded');
  return rows.map(row => ({id: row.id, version: row.version ?? null, sha256: sha(JSON.stringify(canonical(row)))})).sort((a, b) => a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
}
const sameSnapshot = (a, b) => JSON.stringify(a) === JSON.stringify(b);

// Injected stores exist solely for deterministic local verification. Production
// CLI pacing is fixed at two seconds per source; there is no zero-pace flag.
export async function runMaintenance({store, apply = false, now = Date.now, paceMs = 2000} = {}) {
  if (!store) throw new Error('ExplicitStoreRequired');
  if (typeof apply !== 'boolean') throw new Error('ExplicitApplyBooleanRequired');
  const report = {schema: 1, mode: apply ? 'apply' : 'dry-run', startedAt: new Date(now()).toISOString(), snapshots: {}};
  try {
    const api = createCommunityApi({store, now});
    report.snapshots.before = await snapshot(store);
    report.capacityPlan = await api.reconcileCapacity();
    report.indexPlan = await api.backfillListings();
    if (apply) {
      report.capacityResult = await api.reconcileCapacity({dryRun: false});
      report.snapshots.afterCapacity = await snapshot(store);
      if (!sameSnapshot(report.snapshots.before, report.snapshots.afterCapacity)) throw new Error('ConcurrentSourceChangeReviewRequired');
      report.indexResult = await api.backfillListings({dryRun: false, paceMs});
    }
    report.snapshots.after = await snapshot(store);
    report.sourceUnchanged = sameSnapshot(report.snapshots.before, report.snapshots.after);
    if (!report.sourceUnchanged) throw new Error('ConcurrentSourceChangeReviewRequired');
    report.completed = true;
  } catch (error) {
    // Do not print provider messages/stacks: they can contain identifiers or data.
    report.completed = false;
    report.errorCode = /^[A-Za-z0-9_]{1,100}$/.test(error.name || '') && error.name !== 'Error' ? error.name : /^[A-Za-z0-9_]{1,100}$/.test(error.message || '') ? error.message : 'MaintenanceFailed';
    try { report.snapshots.afterFailure = await snapshot(store); } catch { report.afterFailureSnapshotUnavailable = true; }
    report.sourceUnchanged = report.snapshots.before && report.snapshots.afterFailure ? sameSnapshot(report.snapshots.before, report.snapshots.afterFailure) : null;
  }
  report.finishedAt = new Date(now()).toISOString();
  return report;
}

async function main() {
  const args = process.argv.slice(2);
  if (args.length === 1 && args[0] === '--help') {
    process.stdout.write('Usage: TABLE_NAME=<exact-existing-table> AWS_REGION=<region> node backend/maintain-community.mjs --table <same-exact-table> [--apply] [--output <new-private-json-file>]\nDry-run is the default. --apply explicitly reconciles capacity and backfills/validates indexes. Source snapshots contain only thread IDs, versions and hashes. Production backfill pacing is fixed at 2000ms/source.\n');
    return;
  }
  let apply = false, chosenTable, output;
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--apply' && !apply) apply = true;
    else if (args[i] === '--table' && !chosenTable && args[i + 1] && !args[i + 1].startsWith('--')) chosenTable = args[++i];
    else if (args[i] === '--output' && !output && args[i + 1] && !args[i + 1].startsWith('--')) output = args[++i];
    else throw new Error('InvalidArguments');
  }
  const configuredTable = process.env.TABLE_NAME;
  if (!configuredTable || !/^[A-Za-z0-9_.-]{3,255}$/.test(configuredTable) || chosenTable !== configuredTable) throw new Error('ExactTableConfirmationRequired');
  if (!process.env.AWS_REGION && !process.env.AWS_DEFAULT_REGION) throw new Error('ExplicitRegionRequired');
  const base = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../privatework/community-maintenance');
  const reportFile = output ? path.resolve(output) : path.join(base, `maintenance-${new Date().toISOString().replace(/[:.]/g, '-')}-${apply ? 'apply' : 'dry-run'}.json`);
  // Reserve a private report before any mutation. Existing reports cannot be overwritten.
  await mkdir(path.dirname(reportFile), {recursive: true, mode: 0o700});
  await writeFile(reportFile, JSON.stringify({schema: 1, mode: apply ? 'apply' : 'dry-run', completed: false, status: 'started'}) + '\n', {mode: 0o600, flag: 'wx'});
  await chmod(reportFile, 0o600);
  const report = await runMaintenance({store: new DynamoDBStore(configuredTable), apply});
  report.tableNameSha256 = sha(configuredTable);
  await writeFile(reportFile, JSON.stringify(report, null, 2) + '\n', {mode: 0o600});
  // No source rows, identities, feedback, credentials or source IDs reach stdout.
  process.stdout.write(JSON.stringify({mode: report.mode, completed: report.completed, sourceUnchanged: report.sourceUnchanged, beforeThreadCount: report.snapshots.before?.length ?? null, afterThreadCount: report.snapshots.after?.length ?? report.snapshots.afterFailure?.length ?? null, capacity: report.capacityResult?.proposed || report.capacityPlan?.proposed || null, indexedThreadCount: report.indexResult?.verified ?? null, ...(report.errorCode && {errorCode: report.errorCode}), reportFile}) + '\n');
  if (!report.completed) process.exitCode = 1;
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main().catch(error => {
  process.stderr.write(JSON.stringify({completed: false, errorCode: /^[A-Za-z0-9_]{1,100}$/.test(error.message || '') ? error.message : 'MaintenanceFailed'}) + '\n');
  process.exitCode = 1;
});

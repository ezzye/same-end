import {realpathSync} from 'node:fs';
import {readFile} from 'node:fs/promises';
import {cpus, totalmem} from 'node:os';
import {createServer} from 'node:http';
import {pathToFileURL} from 'node:url';
import {assessEdgeCapacity, parseCoturnMetrics} from '../backend/edge-turn.mjs';
import {readMacMemoryPressure, sampleMacNetworkCounter} from './macos-sampler.mjs';

const now = () => Date.now();
const cpuTotals = list => list.reduce((out, cpu) => {
  for (const [key, value] of Object.entries(cpu.times)) out[key] += value;
  return out;
}, {user: 0, nice: 0, sys: 0, idle: 0, irq: 0});
const cpuRatio = (before, after) => {
  if (!before || !after) return null;
  const delta = Object.keys(after).reduce((o, k) => (o[k] = after[k] - before[k], o), {});
  const total = Object.values(delta).reduce((a, b) => a + b, 0);
  return total > 0 ? Math.max(0, Math.min(1, 1 - delta.idle / total)) : null;
};

async function linuxTxBytes() {
  if (process.platform !== 'linux') return null;
  try {
    const text = await readFile('/proc/net/dev', 'utf8');
    const values = text.split('\n').slice(2).map(line => line.trim()).filter(Boolean).map(line => {
      const [iface, stats] = line.split(':');
      if (!iface || iface.trim() === 'lo') return 0;
      const columns = stats.trim().split(/\s+/).map(Number);
      return Number.isFinite(columns[8]) ? columns[8] : 0;
    });
    return values.reduce((sum, bytes) => sum + bytes, 0);
  } catch { return null; }
}

async function memoryRatio() {
  if (process.platform === 'darwin') return readMacMemoryPressure();
  if (process.platform !== 'linux') return null;
  try {
    const text = await readFile('/proc/meminfo', 'utf8');
    const match = /^MemAvailable:\s+(\d+) kB$/m.exec(text);
    return match && totalmem() > 0 ? Math.max(0, Math.min(1, Number(match[1]) * 1024 / totalmem())) : null;
  } catch { return null; }
}


function isLoopbackMetricsUrl(value) {
  if (typeof value !== 'string' || !value) return false;
  try {
    const url = new URL(value);
    return ['http:', 'https:'].includes(url.protocol) && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname) &&
      !url.username && !url.password && !url.hash;
  } catch { return false; }
}

function validateReportAck(data, sample) {
  if (!data || typeof data !== 'object' || !['healthy', 'constrained', 'unknown', 'stale'].includes(data.state) ||
      typeof data.allowNew !== 'boolean' || data.allowNew !== (data.state === 'healthy') ||
      data.sampledAtMs !== sample.sampledAtMs || !Number.isFinite(data.expiresAtMs) || data.expiresAtMs <= now() ||
      !Array.isArray(data.reasons) || data.reasons.length > 20 || data.reasons.some(x => typeof x !== 'string' || x.length > 80)) {
    throw new Error('Coordinator returned an invalid capacity health acknowledgement');
  }
  return {state: data.state, allowNew: data.allowNew, sampledAtMs: data.sampledAtMs, expiresAtMs: data.expiresAtMs, reasons: data.reasons, metrics: data.metrics || null};
}

function validateRemoteConfig(config, args) {
  if (config.reportUrl === undefined || config.reportUrl === '') return;
  let reportUrl;
  try { reportUrl = new URL(config.reportUrl); } catch { throw new Error('reportUrl must be the deployed coordinator HTTPS health endpoint'); }
  if (reportUrl.protocol !== 'https:' || reportUrl.username || reportUrl.password || reportUrl.hash || reportUrl.search) throw new Error('reportUrl must use HTTPS without embedded credentials or fragments');
  if (!isLoopbackMetricsUrl(config.metricsUrl)) throw new Error('metricsUrl must point to a local coturn exporter on loopback');
  if (config.networkInterface !== undefined && !/^en\d+$/.test(config.networkInterface)) throw new Error('networkInterface must be a physical macOS en interface name');
  const p = config.policy, secret = process.env.EDGE_TURN_HEALTH_SECRET;
  if (!args.dryRun && (typeof secret !== 'string' || secret.length < 24)) throw new Error('EDGE_TURN_HEALTH_SECRET must contain at least 24 characters when reportUrl is configured');
  if (!args.dryRun && (!(Number.isFinite(p.uplinkBudgetMbps) && p.uplinkBudgetMbps > 0) || !Number.isSafeInteger(p.allocationLimit) || p.allocationLimit <= 0)) throw new Error('Remote health reporting requires a positive uplinkBudgetMbps and positive safe-integer allocationLimit');
  for (const [name, value] of [['cpuBusyLimit', p.cpuBusyLimit ?? 0.9], ['minimumMemoryAvailableRatio', p.minimumMemoryAvailableRatio ?? 0.1], ['uplinkHeadroomRatio', p.uplinkHeadroomRatio ?? 0.8], ['allocationHeadroomRatio', p.allocationHeadroomRatio ?? 0.9]]) {
    if (!Number.isFinite(value) || value < 0 || value > 1 || (name.endsWith('HeadroomRatio') && value === 0)) throw new Error(`Invalid capacity policy setting: ${name}`);
  }
}

async function scrapeAllocations(url) {
  if (!url) return {allocations: null, metricError: true};
  try {
    const response = await fetch(url, {redirect: 'error', signal: AbortSignal.timeout(1200)});
    if (!response.ok) return {allocations: null, metricError: true};
    const result = parseCoturnMetrics(await response.text());
    return {...result, metricError: result.allocations === null};
  } catch { return {allocations: null, metricError: true}; }
}

export async function supervisorHealthy(file, time = now()) {
  if (file === undefined) return true;
  try {
    if (typeof file !== 'string' || !file) return false;
    const s = JSON.parse(await readFile(file, 'utf8'));
    return s.ok === true && Number.isFinite(s.checkedAtMs) && s.checkedAtMs <= time && Number.isFinite(s.expiresAtMs) && s.expiresAtMs > time && s.expiresAtMs - s.checkedAtMs <= 600000 && Array.isArray(s.reasons) && s.reasons.length === 0;
  } catch { return false; }
}

export async function sampleHost({metricsUrl, networkInterface, supervisorStatusPath} = {}, previous = {}) {
  const sampledAtMs = now();
  const cpu = cpuTotals(cpus());
  let txBytes = null, networkIdentity = null;
  if (process.platform === 'linux') { txBytes = await linuxTxBytes(); if (txBytes !== null) networkIdentity = 'linux:aggregate'; }
  else if (process.platform === 'darwin') { const sample = await sampleMacNetworkCounter({interfaceName: networkInterface}); txBytes = sample?.txBytes ?? null; networkIdentity = sample?.identity ?? null; }
  const memoryAvailableRatio = await memoryRatio();
  const allocation = await scrapeAllocations(metricsUrl);
  if (!await supervisorHealthy(supervisorStatusPath, sampledAtMs)) allocation.metricError = true;
  const elapsedSeconds = previous.sampledAtMs ? (sampledAtMs - previous.sampledAtMs) / 1000 : 0;
  const networkTxMbps = txBytes !== null && Number.isFinite(previous.txBytes) && networkIdentity && previous.networkIdentity === networkIdentity && elapsedSeconds > 0 && txBytes >= previous.txBytes
    ? (txBytes - previous.txBytes) * 8 / elapsedSeconds / 1_000_000 : null;
  return {
    sample: {sampledAtMs, cpuBusyRatio: cpuRatio(previous.cpu, cpu), memoryAvailableRatio, networkTxMbps, ...allocation},
    next: {sampledAtMs, cpu, txBytes, networkIdentity}
  };
}

function parseArgs(argv) {
  const args = {once: false, dryRun: false, selftest: false, serve: false, configPath: null};
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--once') args.once = true;
    else if (argv[i] === '--dry-run') args.dryRun = true;
    else if (argv[i] === '--selftest') args.selftest = true;
    else if (argv[i] === '--serve') args.serve = true;
    else if (argv[i] === '--config') args.configPath = argv[++i];
    else throw new Error(`Unknown option: ${argv[i]}`);
  }
  return args;
}

async function run(argv = process.argv.slice(2)) {
  const args = parseArgs(argv);
  if (args.selftest) {
    const report = {sampledAtMs: now(), cpuBusyRatio: 0.2, memoryAvailableRatio: 0.5, networkTxMbps: 1, allocations: 1, metricError: false};
    const policy = {reportTtlMs: 15_000, cpuBusyLimit: 0.9, minimumMemoryAvailableRatio: 0.1, uplinkBudgetMbps: 50, allocationLimit: 100};
    const result = assessEdgeCapacity({sample: report, config: policy});
    if (result.state !== 'healthy') throw new Error('Capacity policy self-test failed');
    const ack = validateReportAck({state: 'healthy', allowNew: true, sampledAtMs: report.sampledAtMs, expiresAtMs: report.sampledAtMs + policy.reportTtlMs, reasons: []}, report);
    let rejectedMismatch = false;
    try { validateReportAck({...ack, sampledAtMs: report.sampledAtMs - 1}, report); } catch { rejectedMismatch = true; }
    if (!ack.allowNew || !rejectedMismatch) throw new Error('Coordinator acknowledgement self-test failed');
    process.stdout.write(JSON.stringify({selftest: 'passed'}) + '\n');
    return;
  }
  if (!args.configPath) throw new Error('No operation without an explicit --config file. Use --selftest for a local check.');
  const config = JSON.parse(await readFile(args.configPath, 'utf8'));
  if (!config || !config.policy || !Number.isInteger(config.intervalMs) || config.intervalMs < 1000 || config.intervalMs > 60000 ||
      !Number.isFinite(config.policy.reportTtlMs) || config.policy.reportTtlMs <= config.intervalMs + 5000) throw new Error('Config requires a policy, intervalMs from 1000 to 60000, and reportTtlMs greater than intervalMs plus 5000ms');
  validateRemoteConfig(config, args);
  let previous = {}, latest = null, lastFailureMessage = null, timer = null;
  const report = async () => {
    const captured = await sampleHost(config, previous);
    previous = captured.next;
    const sample = captured.sample;
    const decision = assessEdgeCapacity({sample, config: config.policy});
    const awaitingAck = {state: 'unknown', allowNew: false, sampledAtMs: sample.sampledAtMs, expiresAtMs: sample.sampledAtMs + config.policy.reportTtlMs, reasons: ['awaiting-coordinator-ack']};
    latest = {sample, localDecision: decision, decision: config.reportUrl && !args.dryRun ? awaitingAck : decision};
    if (config.reportUrl && !args.dryRun) {
      const secret = process.env.EDGE_TURN_HEALTH_SECRET;
      if (typeof secret !== 'string' || secret.length < 24) throw new Error('EDGE_TURN_HEALTH_SECRET is required when reportUrl is configured');
      const body = JSON.stringify(sample);
      const timestamp = String(sample.sampledAtMs);
      const signature = (await import('node:crypto')).createHmac('sha256', secret).update(`${timestamp}.`).update(body).digest('hex');
      const response = await fetch(config.reportUrl, {method: 'POST', redirect: 'error', headers: {'content-type': 'application/json', 'x-edge-timestamp': timestamp, 'x-edge-signature': signature}, body, signal: AbortSignal.timeout(2000)});
      if (!response.ok) throw new Error(`Health report rejected with status ${response.status}`);
      let acknowledgement;
      try { acknowledgement = await response.json(); } catch { throw new Error('Coordinator health acknowledgement was not valid JSON'); }
      latest = {sample, localDecision: decision, decision: validateReportAck(acknowledgement, sample)};
    }
    return latest;
  };
  if (args.once || args.dryRun) { await report(); process.stdout.write(JSON.stringify(latest) + '\n'); return; }
  let server;
  if (args.serve) {
    const port = Number(config.localHealthPort ?? 9642);
    if (!Number.isInteger(port) || port < 1024 || port > 65535) throw new Error('localHealthPort must be 1024..65535');
    server = createServer((request, response) => {
      if (request.method !== 'GET' || request.url !== '/health') { response.writeHead(404).end(); return; }
      const expired=latest&&now()>=latest.decision.expiresAtMs;
      const allowlisted = !config.reportUrl ? {state:'unknown',allowNew:false,sampledAtMs:latest?.sample.sampledAtMs??null,expiresAtMs:null,reasons:['health-report-not-configured']} : expired ? {state:'stale',allowNew:false,sampledAtMs:latest.decision.sampledAtMs,expiresAtMs:latest.decision.expiresAtMs,reasons:['report-expired']} : latest ? {state: latest.decision.state, allowNew: latest.decision.allowNew, sampledAtMs: latest.decision.sampledAtMs, expiresAtMs: latest.decision.expiresAtMs, reasons: latest.decision.reasons, metrics: latest.decision.metrics} : {state: 'unknown', allowNew: false};
      response.writeHead(200, {'content-type': 'application/json', 'cache-control': 'no-store'}).end(JSON.stringify(allowlisted));
    });
    server.listen(port, '127.0.0.1');
  }
  const tick = async () => {
    try {
      await report();
      if (lastFailureMessage) process.stderr.write('Edge health reporting recovered.\n');
      lastFailureMessage = null;
    } catch (error) {
      if (latest) latest = {...latest, decision: {...latest.decision, state: 'unknown', allowNew: false, reasons: ['heartbeat-or-sample-failed']}};
      const message = error?.message || 'Edge health sampling failed';
      if (message !== lastFailureMessage) process.stderr.write(`${message}\n`);
      lastFailureMessage = message;
    } finally { timer = setTimeout(tick, config.intervalMs); }
  };
  await tick();
  process.on('SIGINT', () => { clearTimeout(timer); server?.close(); process.exit(0); });
  process.on('SIGTERM', () => { clearTimeout(timer); server?.close(); process.exit(0); });
}

if (process.argv[1] && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href) run().catch(error => { process.stderr.write(`${error.message}\n`); process.exitCode = 1; });

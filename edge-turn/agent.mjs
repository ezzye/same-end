import {readFile} from 'node:fs/promises';
import {cpus, totalmem} from 'node:os';
import {createServer} from 'node:http';
import {pathToFileURL} from 'node:url';
import {assessEdgeCapacity, parseCoturnMetrics} from '../backend/edge-turn.mjs';

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
  if (process.platform !== 'linux') return null;
  try {
    const text = await readFile('/proc/meminfo', 'utf8');
    const match = /^MemAvailable:\s+(\d+) kB$/m.exec(text);
    return match && totalmem() > 0 ? Math.max(0, Math.min(1, Number(match[1]) * 1024 / totalmem())) : null;
  } catch { return null; }
}

async function scrapeAllocations(url) {
  if (!url) return {allocations: null, metricError: true};
  try {
    const response = await fetch(url, {signal: AbortSignal.timeout(1200)});
    if (!response.ok) return {allocations: null, metricError: true};
    const result = parseCoturnMetrics(await response.text());
    return {...result, metricError: result.allocations === null};
  } catch { return {allocations: null, metricError: true}; }
}

export async function sampleHost({metricsUrl} = {}, previous = {}) {
  const sampledAtMs = now();
  const cpu = cpuTotals(cpus());
  const txBytes = await linuxTxBytes();
  const memoryAvailableRatio = await memoryRatio();
  const allocation = await scrapeAllocations(metricsUrl);
  const elapsedSeconds = previous.sampledAtMs ? (sampledAtMs - previous.sampledAtMs) / 1000 : 0;
  const networkTxMbps = txBytes !== null && Number.isFinite(previous.txBytes) && elapsedSeconds > 0 && txBytes >= previous.txBytes
    ? (txBytes - previous.txBytes) * 8 / elapsedSeconds / 1_000_000 : null;
  return {
    sample: {sampledAtMs, cpuBusyRatio: cpuRatio(previous.cpu, cpu), memoryAvailableRatio, networkTxMbps, ...allocation},
    next: {sampledAtMs, cpu, txBytes}
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
    process.stdout.write(JSON.stringify({selftest: 'passed'}) + '\n');
    return;
  }
  if (!args.configPath) throw new Error('No operation without an explicit --config file. Use --selftest for a local check.');
  const config = JSON.parse(await readFile(args.configPath, 'utf8'));
  if (!config || !config.policy || !Number.isInteger(config.intervalMs) || config.intervalMs < 1000 || config.intervalMs > 60000 ||
      !Number.isFinite(config.policy.reportTtlMs) || config.policy.reportTtlMs <= config.intervalMs + 5000) throw new Error('Config requires a policy, intervalMs from 1000 to 60000, and reportTtlMs greater than intervalMs plus 5000ms');
  let previous = {}, latest = null, lastFailureMessage = null, timer = null;
  const report = async () => {
    const captured = await sampleHost(config, previous);
    previous = captured.next;
    const sample = captured.sample;
    const decision = assessEdgeCapacity({sample, config: config.policy});
    latest = {sample, decision};
    if (config.reportUrl && !args.dryRun) {
      const secret = process.env.EDGE_TURN_HEALTH_SECRET;
      if (typeof secret !== 'string' || secret.length < 24) throw new Error('EDGE_TURN_HEALTH_SECRET is required when reportUrl is configured');
      const body = JSON.stringify(sample);
      const timestamp = String(sample.sampledAtMs);
      const signature = (await import('node:crypto')).createHmac('sha256', secret).update(`${timestamp}.`).update(body).digest('hex');
      const response = await fetch(config.reportUrl, {method: 'POST', headers: {'content-type': 'application/json', 'x-edge-timestamp': timestamp, 'x-edge-signature': signature}, body, signal: AbortSignal.timeout(2000)});
      if (!response.ok) throw new Error(`Health report rejected with status ${response.status}`);
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
      const allowlisted = expired ? {state:'stale',allowNew:false,sampledAtMs:latest.decision.sampledAtMs,expiresAtMs:latest.decision.expiresAtMs,reasons:['report-expired']} : latest ? {state: latest.decision.state, allowNew: latest.decision.allowNew, sampledAtMs: latest.decision.sampledAtMs, expiresAtMs: latest.decision.expiresAtMs, reasons: latest.decision.reasons, metrics: latest.decision.metrics} : {state: 'unknown', allowNew: false};
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

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) run().catch(error => { process.stderr.write(`${error.message}\n`); process.exitCode = 1; });

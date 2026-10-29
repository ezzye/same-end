import {execFile} from 'node:child_process';

const MAX_OUTPUT = 64 * 1024;
const COMMAND_TIMEOUT_MS = 1200;

export function parseMacMemoryPressure(text) {
  if (typeof text !== 'string') return null;
  const match = /System-wide memory free percentage:\s*(\d+(?:\.\d+)?)%/i.exec(text);
  if (!match) return null;
  const percentage = Number(match[1]);
  return Number.isFinite(percentage) && percentage >= 0 && percentage <= 100 ? percentage / 100 : null;
}

export function parseDefaultRouteInterface(text) {
  if (typeof text !== 'string') return null;
  const match = /^\s*interface:\s*(\S+)\s*$/mi.exec(text);
  return match?.[1] || null;
}

export function parseHardwareInterfaces(text) {
  if (typeof text !== 'string') return new Set();
  return new Set([...text.matchAll(/^\s*Device:\s*(\S+)\s*$/gmi)].map(match => match[1]));
}

export function parseMacLinkOutBytes(text, interfaceName) {
  if (typeof text !== 'string' || !/^en\d+$/.test(interfaceName)) return null;
  const lines = text.split(/\r?\n/).filter(Boolean);
  const headerLine = lines.find(line => /^\s*Name\s+Mtu\s+Network\s+Address\s+Ipkts\s+Ierrs\s+Ibytes\s+Opkts\s+Oerrs\s+Obytes\b/i.test(line));
  if (!headerLine) return null;
  const header = headerLine.trim().split(/\s+/).map(name => name.toLowerCase());
  const networkIndex = header.indexOf('network'), bytesIndex = header.indexOf('obytes');
  if (networkIndex < 0 || bytesIndex < 0) return null;
  const rows = lines.filter(line => {
    const columns = line.trim().split(/\s+/);
    return columns[0] === interfaceName && /^<Link#\d+>$/i.test(columns[networkIndex] || '');
  });
  if (rows.length !== 1) return null;
  const columns = rows[0].trim().split(/\s+/);
  const bytes = Number(columns[bytesIndex]);
  return Number.isSafeInteger(bytes) && bytes >= 0 ? bytes : null;
}

function runFile(file, args) {
  return new Promise((resolve, reject) => {
    execFile(file, args, {encoding: 'utf8', timeout: COMMAND_TIMEOUT_MS, maxBuffer: MAX_OUTPUT}, (error, stdout) => {
      if (error) reject(error);
      else resolve(stdout);
    });
  });
}

export async function readMacMemoryPressure({run = runFile} = {}) {
  try { return parseMacMemoryPressure(await run('/usr/bin/memory_pressure', ['-Q'])); }
  catch { return null; }
}

export async function sampleMacNetworkCounter({interfaceName, run = runFile} = {}) {
  try {
    const [routeText, hardwareText] = await Promise.all([
      run('/sbin/route', ['-n', 'get', 'default']),
      run('/usr/sbin/networksetup', ['-listallhardwareports'])
    ]);
    const routeInterface = parseDefaultRouteInterface(routeText);
    // A utun, bridge, Wi-Fi peer or loopback route is virtual/ambiguous here.
    // Never substitute a different interface when the default route is unknown.
    if (!routeInterface || !/^en\d+$/.test(routeInterface) || !parseHardwareInterfaces(hardwareText).has(routeInterface) ||
      (interfaceName && interfaceName !== routeInterface)) return null;
    const stats = await run('/usr/sbin/netstat', ['-ibn', '-I', routeInterface, '-f', 'link']);
    const txBytes = parseMacLinkOutBytes(stats, routeInterface);
    return txBytes === null ? null : {txBytes, interfaceName: routeInterface, identity: `mac:${routeInterface}`};
  } catch { return null; }
}

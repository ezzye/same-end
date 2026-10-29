import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {parseDefaultRouteInterface, parseHardwareInterfaces, parseMacLinkOutBytes, parseMacMemoryPressure, sampleMacNetworkCounter} from './macos-sampler.mjs';

const fixture = await readFile(new URL('./fixtures/macos-sampler.txt', import.meta.url), 'utf8');
const section = name => fixture.split(`=== ${name} ===\n`)[1].split('\n=== ')[0];

test('macOS memory pressure parser returns a bounded available estimate', () => {
  assert.equal(parseMacMemoryPressure(section('memory_pressure -Q')), 0.48);
  assert.equal(parseMacMemoryPressure('System-wide memory free percentage: 101%'), null);
  assert.equal(parseMacMemoryPressure('memory pressure unavailable'), null);
});

test('macOS default route and hardware parser identify the selected physical interface', () => {
  assert.equal(parseDefaultRouteInterface(section('route -n get default')), 'en0');
  assert.deepEqual([...parseHardwareInterfaces(section('networksetup -listallhardwareports'))], ['en0']);
  assert.equal(parseDefaultRouteInterface('interface: utun4'), 'utun4');
});

test('macOS netstat parser chooses only the link-layer row, not duplicated address rows', () => {
  const text = section('netstat -ibn -I en0 -f link');
  assert.equal(parseMacLinkOutBytes(text, 'en0'), 136367554294);
  assert.equal(parseMacLinkOutBytes(text, 'utun4'), null);
  assert.equal(parseMacLinkOutBytes(text.replace('<Link#14>', '<Link#14>\nen0 1500 <Link#15> aa 1 0 2 1 0 3 0'), 'en0'), null);
});

test('macOS sampler fails closed for virtual or mismatched interfaces', async () => {
  const commands = new Map([
    ['/sbin/route', section('route -n get default')],
    ['/usr/sbin/networksetup', section('networksetup -listallhardwareports')],
    ['/usr/sbin/netstat', section('netstat -ibn -I en0 -f link')]
  ]);
  const run = async file => commands.get(file);
  assert.deepEqual(await sampleMacNetworkCounter({run}), {txBytes: 136367554294, interfaceName: 'en0', identity: 'mac:en0'});
  assert.equal(await sampleMacNetworkCounter({interfaceName: 'en1', run}), null);
  commands.set('/sbin/route', 'interface: utun4');
  assert.equal(await sampleMacNetworkCounter({run}), null);
});

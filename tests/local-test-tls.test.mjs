import test from 'node:test';
import assert from 'node:assert/strict';
import { createPrivateKey, X509Certificate } from 'node:crypto';
import https from 'node:https';
import { once } from 'node:events';
import { createLocalTestTLS } from './helpers/local-test-tls.mjs';

test('ephemeral test certificate has a valid self-signature, matching key, SANs and short validity', () => {
  const { key, cert } = createLocalTestTLS(), certificate = new X509Certificate(cert);
  assert.equal(certificate.verify(certificate.publicKey), true);
  assert.equal(certificate.checkPrivateKey(createPrivateKey(key)), true);
  assert.equal(certificate.publicKey.asymmetricKeyType, 'rsa');
  assert.equal(certificate.publicKey.asymmetricKeyDetails.modulusLength, 2048);
  assert.equal(certificate.checkHost('localhost'), 'localhost');
  assert.equal(certificate.checkIP('127.0.0.1'), '127.0.0.1');
  assert.equal(certificate.checkHost('unrelated.invalid'), undefined);
  assert.match(certificate.subjectAltName, /DNS:localhost/);
  assert.match(certificate.subjectAltName, /IP Address:127\.0\.0\.1/);
  assert.equal(certificate.ca, false);
  const from = Date.parse(certificate.validFrom), until = Date.parse(certificate.validTo);
  assert(from <= Date.now() && Date.now() < until);
  assert(until - from >= 86_400_000 && until - from <= 86_700_000);
});

test('Node HTTPS accepts the generated certificate for both localhost and loopback IP', async () => {
  const tls = createLocalTestTLS(), server = https.createServer(tls, (_req, res) => res.end('local TLS works'));
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  try {
    for (const hostname of ['localhost', '127.0.0.1']) {
      const body = await new Promise((resolve, reject) => {
        const request = https.get({ hostname, port: server.address().port, ca: tls.cert,
          // Make the DNS case deterministic on hosts preferring IPv6 loopback.
          lookup: (_host, options, callback) => callback(null,
            options.all ? [{ address: '127.0.0.1', family: 4 }] : '127.0.0.1', 4)
        }, response => {
          assert.equal(response.socket.authorized, true);
          assert.equal(response.statusCode, 200);
          let value = ''; response.setEncoding('utf8');
          response.on('data', chunk => { value += chunk; });
          response.on('end', () => resolve(value));
          response.on('error', reject);
        });
        request.on('error', reject);
      });
      assert.equal(body, 'local TLS works');
    }
  } finally { await new Promise(resolve => server.close(resolve)); }
});

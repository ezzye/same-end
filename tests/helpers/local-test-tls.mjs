// Ephemeral localhost TLS for isolated browser tests. No external executable or
// dependency is needed, and the private key never leaves the returned object.
import { createHash, generateKeyPairSync, randomBytes, sign, X509Certificate } from 'node:crypto';

const der = (tag, ...parts) => {
  const body = Buffer.concat(parts);
  let size = body.length, length;
  if (size < 128) length = Buffer.from([size]);
  else {
    const bytes = [];
    while (size) { bytes.unshift(size & 255); size = Math.floor(size / 256); }
    length = Buffer.from([128 | bytes.length, ...bytes]);
  }
  return Buffer.concat([Buffer.from([tag]), length, body]);
};
const seq = (...parts) => der(0x30, ...parts);
const oid = hex => der(0x06, Buffer.from(hex, 'hex'));
const octets = value => der(0x04, value);
const integer = bytes => {
  while (bytes.length > 1 && bytes[0] === 0) bytes = bytes.subarray(1);
  return der(0x02, bytes[0] & 128 ? Buffer.concat([Buffer.from([0]), bytes]) : bytes);
};
const pem = (label, bytes) => `-----BEGIN ${label}-----\n${bytes.toString('base64').match(/.{1,64}/g).join('\n')}\n-----END ${label}-----\n`;
const time = date => {
  const iso = date.toISOString().replace(/[-:T]/g, '').replace(/\.\d{3}Z$/, 'Z');
  return der(date.getUTCFullYear() < 2050 ? 0x17 : 0x18,
    Buffer.from(date.getUTCFullYear() < 2050 ? iso.slice(2) : iso, 'ascii'));
};

export function createLocalTestTLS() {
  const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
  // sha256WithRSAEncryption, including the algorithm's required NULL parameters.
  const algorithm = seq(oid('2a864886f70d01010b'), der(0x05));
  const name = seq(der(0x31, seq(oid('550403'), der(0x0c, Buffer.from('localhost')))));
  const now = Date.now();
  const extension = (id, value, critical = false) => seq(oid(id),
    ...(critical ? [der(0x01, Buffer.from([255]))] : []), octets(value));
  const extensions = seq(
    extension('551d13', seq(), true), // basicConstraints: end entity, CA=false
    extension('551d0f', der(0x03, Buffer.from([5, 0xa0])), true), // sign + key encipherment
    extension('551d25', seq(oid('2b06010505070301'))), // TLS server authentication
    extension('551d11', seq(der(0x82, Buffer.from('localhost', 'ascii')),
      der(0x87, Buffer.from([127, 0, 0, 1]))))
  );
  const certificateBody = seq(
    der(0xa0, integer(Buffer.from([2]))), integer(randomBytes(16)), algorithm,
    name, seq(time(new Date(now - 300_000)), time(new Date(now + 86_400_000))), name,
    publicKey.export({ type: 'spki', format: 'der' }), der(0xa3, extensions)
  );
  const certificate = seq(certificateBody, algorithm,
    der(0x03, Buffer.from([0]), sign('RSA-SHA256', certificateBody, privateKey)));
  return {
    key: privateKey.export({ type: 'pkcs8', format: 'pem' }),
    cert: pem('CERTIFICATE', certificate)
  };
}

// Chromium's --ignore-certificate-errors-spki-list accepts base64-encoded
// SHA-256 hashes of SubjectPublicKeyInfo DER, one per permitted certificate.
export function localTestTLSSPKIPin(cert) {
  return createHash('sha256')
    .update(new X509Certificate(cert).publicKey.export({ type: 'spki', format: 'der' }))
    .digest('base64');
}

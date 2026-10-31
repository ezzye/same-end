import {test} from 'node:test';
import assert from 'node:assert/strict';
import {haproxyStaticConfig} from './haproxy-static-config.mjs';
test('static proxy confines trusted PROXY listeners to loopback and sends ACME directly',()=>{
 const config=haproxyStaticConfig('/private/test dir/turn.pem');
 assert.match(config,/bind 0\.0\.0\.0:5349/);
 assert.match(config,/use_backend acme if \{ req\.ssl_alpn acme-tls\/1 \}/);
 assert.match(config,/server lego 127\.0\.0\.1:8443\n/);
 assert.match(config,/server inner 127\.0\.0\.1:15449 send-proxy-v2/);
 assert.match(config,/bind 127\.0\.0\.1:15449 accept-proxy ssl crt "\/private\/test dir\/turn.pem"/);
 assert.match(config,/server coturn 127\.0\.0\.1:13478 send-proxy-v2/);
 assert.throws(()=>haproxyStaticConfig('/tmp/evil\nconfig'));
 assert.throws(()=>haproxyStaticConfig('/tmp/${VARIABLE}'));
});

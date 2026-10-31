/* Generate the explicit operator-reviewed, loopback-isolated static TURN proxy. */
import path from 'node:path';
import {pathToFileURL} from 'node:url';
import {realpathSync} from 'node:fs';
export function haproxyStaticConfig(pemPath){
 if(typeof pemPath!=='string'||!path.isAbsolute(pemPath)||/[\x00-\x1f\x7f$]/.test(pemPath))throw Error('An absolute PEM path without control characters or $ is required');
 const pem='"'+pemPath.replace(/[\\"]/g,'\\$&')+'"';
 return `global
  master-worker
  maxconn 256

defaults
  mode tcp
  timeout connect 5s
  timeout client 2h
  timeout server 2h

frontend public_tls
  bind 0.0.0.0:5349
  tcp-request inspect-delay 5s
  tcp-request content accept if { req.ssl_hello_type 1 }
  use_backend acme if { req.ssl_alpn acme-tls/1 }
  default_backend turns_tls

backend acme
  server lego 127.0.0.1:8443

backend turns_tls
  server inner 127.0.0.1:15449 send-proxy-v2

frontend private_tls
  bind 127.0.0.1:15449 accept-proxy ssl crt ${pem}
  default_backend turns_clear

backend turns_clear
  server coturn 127.0.0.1:13478 send-proxy-v2
`;
}
if(process.argv[1]&&import.meta.url===pathToFileURL(realpathSync(process.argv[1])).href){try{if(process.argv.length!==3)throw Error('Usage: node haproxy-static-config.mjs ABSOLUTE_PEM_PATH');process.stdout.write(haproxyStaticConfig(process.argv[2]));}catch(e){console.error(e.message);process.exitCode=1;}}

// Test-only local API gateway. It models API Gateway's already-verified JWT
// claims for a tiny allowlist of dummy browser tokens; production has no such
// token mapping or bypass.
import http from 'node:http';
import {MemoryStore} from '../../backend/store.mjs';
import {createApi, LIMITS} from '../../backend/api.mjs';
import {createPushTransport} from '../../backend/push.mjs';
import {createCommunityApi} from '../../backend/community-api.mjs';
import {LocalFileStore} from '../../backend/local-file-store.mjs';

const port=Number(process.env.PORT||8795), webPort=Number(process.env.SAME_END_LOCAL_WEB_PORT||8792);
const issuer='https://cognito-idp.eu-west-2.amazonaws.com/eu-west-2_SameEndFixture', clientId='SameEndBrowserFixture123', scope='sameend-community/use';
const fanAuth={issuer,clientId,domain:'https://sameend-fan.auth.eu-west-2.amazoncognito.com',redirectUri:`http://127.0.0.1:${webPort}/fan-signin.html`,scope};
const tokenAccounts=new Map([['fixture-account-alice','alice-subject'],['fixture-account-bob','bob-subject']]);
const store=process.env.SAME_END_LOCAL_STATE_FILE?await LocalFileStore.open(process.env.SAME_END_LOCAL_STATE_FILE):new MemoryStore();
const push=createPushTransport({publicKey:process.env.VAPID_PUBLIC_KEY,privateKey:process.env.VAPID_PRIVATE_KEY});
const allowedOrigins=[`http://localhost:${webPort}`,`http://127.0.0.1:${webPort}`];
const api=createApi({store,push,allowedOrigins});
const community=createCommunityApi({store,allowedOrigins,fanAuth,localAdminTokenHash:process.env.SAME_END_LOCAL_ADMIN_TOKEN_HASH||''});
const server=http.createServer(async(req,res)=>{
 let size=0;const chunks=[];for await(const chunk of req){size+=chunk.length;if(size>LIMITS.requestBytes){res.writeHead(413,{'content-type':'application/json'}).end(JSON.stringify({code:'payload_too_large'}));return;}chunks.push(chunk);}
 const url=new URL(req.url,'http://localhost'),target=url.pathname.startsWith('/v1/community/')?community:api;
 const claims=tokenAccounts.has(req.headers.authorization?.replace(/^Bearer\s+/i,''))?{iss:issuer,client_id:clientId,token_use:'access',sub:tokenAccounts.get(req.headers.authorization.replace(/^Bearer\s+/i,'')),exp:Math.floor(Date.now()/1000)+3600,scope}:undefined;
 const event={rawPath:url.pathname,headers:req.headers,queryStringParameters:Object.fromEntries(url.searchParams),body:Buffer.concat(chunks).toString(),requestContext:{http:{method:req.method,sourceIp:req.socket.remoteAddress},...(claims&&{authorizer:{jwt:{claims}}})}};
 try{const result=await target.handler(event);res.writeHead(result.statusCode,result.headers).end(result.body);}catch(error){res.writeHead(500,{'content-type':'application/json'}).end(JSON.stringify({error:'fixture_gateway_error'}));}
});
server.listen(port,'127.0.0.1');
async function close(){server.close();await store.close?.();process.exit(0);}
process.once('SIGTERM',close);process.once('SIGINT',close);

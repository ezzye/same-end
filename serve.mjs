import http from 'node:http';
import {readFile,access} from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
const root=path.join(path.dirname(fileURLToPath(import.meta.url)),'dist');
try{await access(path.join(root,'index.html'));}catch{await import('./build-pwa.mjs');}
const allowed=new Map([['/','index.html'],['/index.html','index.html'],['/watch.html','watch.html'],['/manifest.webmanifest','manifest.webmanifest'],['/sw.js','sw.js'],['/test-guide.html','test-guide.html'],['/device-check.html','device-check.html'],['/icon-192.png','icon-192.png'],['/icon-512.png','icon-512.png'],['/manage.html','manage.html'],['/manage.js','manage.js'],['/manage.css','manage.css'],['/community-starters.json','community-starters.json'],['/staff-mfa.js','staff-mfa.js'],['/staff-mfa.css','staff-mfa.css']]);
allowed.set('/same-end-intro.m4a','same-end-intro.m4a');
const mime={'.html':'text/html; charset=utf-8','.js':'text/javascript; charset=utf-8','.css':'text/css; charset=utf-8','.webmanifest':'application/manifest+json','.png':'image/png','.json':'application/json','.m4a':'audio/mp4'};
const port=Number(process.env.PORT||8792);
http.createServer(async(req,res)=>{const requestUrl=new URL(req.url,'http://localhost');
if(requestUrl.pathname.startsWith('/api/v1/')){
  if(!['GET','POST','PUT','DELETE','OPTIONS'].includes(req.method)){res.writeHead(405).end();return;}
  let chunks=[],length=0;for await(const chunk of req){length+=chunk.length;if(length>65536){res.writeHead(413).end();return;}chunks.push(chunk);}
  try{const origin=req.headers.origin;if(origin&&!['http://localhost:'+port,'http://127.0.0.1:'+port].includes(origin)){res.writeHead(403).end();return;}
  const headers={'content-type':'application/json'};if(req.headers.authorization)headers.authorization=req.headers.authorization;
  const upstream=await fetch('http://127.0.0.1:'+Number(process.env.SAME_END_LOCAL_API_PORT||8795)+requestUrl.pathname.slice(4)+requestUrl.search,{method:req.method,headers,body:chunks.length?Buffer.concat(chunks):undefined,signal:AbortSignal.timeout(14000)});
  res.writeHead(upstream.status,{'Content-Type':'application/json','Cache-Control':'no-store','X-Content-Type-Options':'nosniff'});res.end(await upstream.text());}
  catch{res.writeHead(503,{'Content-Type':'application/json'});res.end(JSON.stringify({error:'Start the local club service to use private clubs.'}));}return;
}
const file=allowed.get(requestUrl.pathname);if(req.method!=='GET'||!file){res.writeHead(404);res.end('Not found');return;}try{const b=await readFile(path.join(root,file));res.writeHead(200,{'Content-Type':mime[path.extname(file)],'Cache-Control':'no-cache','X-Content-Type-Options':'nosniff','Referrer-Policy':'no-referrer','Content-Security-Policy':"default-src 'self'; script-src 'self' 'unsafe-inline' blob:; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; media-src 'self' blob:; connect-src 'self' https: wss://tracker.openwebtorrent.com; worker-src 'self' blob:; object-src 'none'; frame-ancestors 'none'; base-uri 'none'"});res.end(b);}catch{res.writeHead(404);res.end('Not found');}}).listen(port,'127.0.0.1',()=>console.log(`Same End: http://localhost:${port} (this computer only)`));

import http from 'node:http';
import {readFile,access} from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
const root=path.join(path.dirname(fileURLToPath(import.meta.url)),'dist');
try{await access(path.join(root,'index.html'));}catch{await import('./build-pwa.mjs');}
const allowed=new Map([['/','index.html'],['/index.html','index.html'],['/manifest.webmanifest','manifest.webmanifest'],['/sw.js','sw.js'],['/test-guide.html','test-guide.html'],['/icon-192.png','icon-192.png'],['/icon-512.png','icon-512.png']]);
const mime={'.html':'text/html; charset=utf-8','.js':'text/javascript; charset=utf-8','.webmanifest':'application/manifest+json','.png':'image/png'};
const port=Number(process.env.PORT||8792);
http.createServer(async(req,res)=>{const file=allowed.get(new URL(req.url,'http://localhost').pathname);if(req.method!=='GET'||!file){res.writeHead(404);res.end('Not found');return;}try{const b=await readFile(path.join(root,file));res.writeHead(200,{'Content-Type':mime[path.extname(file)],'Cache-Control':'no-cache','X-Content-Type-Options':'nosniff','Referrer-Policy':'no-referrer','Content-Security-Policy':"default-src 'self'; script-src 'self' 'unsafe-inline' blob:; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; media-src 'self' blob:; connect-src 'self' wss://tracker.openwebtorrent.com; worker-src 'self' blob:; object-src 'none'; frame-ancestors 'none'; base-uri 'none'"});res.end(b);}catch{res.writeHead(404);res.end('Not found');}}).listen(port,'127.0.0.1',()=>console.log(`Same End: http://localhost:${port} (this computer only)`));

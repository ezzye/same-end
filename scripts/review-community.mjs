// Starts an isolated loopback-only review. Does not touch the deployed service.
import {spawn,execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {mkdir,readFile,writeFile,chmod} from 'node:fs/promises';
import {randomBytes,createHash} from 'node:crypto';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const privateDir=path.join(root,'privatework/community-review');
await mkdir(privateDir,{recursive:true,mode:0o700});await chmod(privateDir,0o700);
const accessFile=path.join(privateDir,'access.json');let access;
try{access=JSON.parse(await readFile(accessFile,'utf8'));}catch(error){if(error.code!=='ENOENT')throw error;access={reviewCredential:randomBytes(32).toString('base64url')};await writeFile(accessFile,JSON.stringify(access,null,2),{mode:0o600});}
if(!/^[A-Za-z0-9_-]{43}$/.test(access.reviewCredential))throw Error('Review access file is invalid; preserve it for inspection.');
await chmod(accessFile,0o600);
const webPort=Number(process.env.SAME_END_REVIEW_WEB_PORT||8972),apiPort=Number(process.env.SAME_END_REVIEW_API_PORT||8975);
if(!process.argv.includes('--no-build'))await promisify(execFile)(process.execPath,['build-pwa.mjs'],{cwd:root,env:{...process.env,SAME_END_LOCAL:'1'}});
const env={...process.env,SAME_END_LOCAL_WEB_PORT:String(webPort),SAME_END_LOCAL_API_PORT:String(apiPort),SAME_END_LOCAL_STATE_FILE:path.join(privateDir,'state.json'),SAME_END_LOCAL_ADMIN_TOKEN_HASH:createHash('sha256').update(access.reviewCredential).digest('hex')};
const children=[spawn(process.execPath,['backend/local.mjs'],{cwd:root,env:{...env,PORT:String(apiPort)},stdio:['ignore','inherit','inherit']}),spawn(process.execPath,['serve.mjs'],{cwd:root,env:{...env,PORT:String(webPort)},stdio:['ignore','inherit','inherit']})];
let stopping=false;
function stop(){if(stopping)return;stopping=true;for(const child of children)child.kill('SIGTERM');}
process.once('SIGINT',stop);process.once('SIGTERM',stop);
for(const child of children)child.once('exit',code=>{if(!stopping){process.exitCode=code||0;stop();}});
console.log('Private review: http://127.0.0.1:'+webPort+'/');
console.log('Management: http://127.0.0.1:'+webPort+'/manage.html');
console.log('Local review access file: '+accessFile+' (keep private; no production authority).');

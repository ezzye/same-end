import {realpathSync} from 'node:fs';
/* Loopback-only, short-lived TURN REST allocation preflight. Never logs credentials. */
import {createSocket} from 'node:dgram';
import {createHash, createHmac, randomBytes, timingSafeEqual} from 'node:crypto';
import {readFile, stat} from 'node:fs/promises';
import {fileURLToPath} from 'node:url';
import path from 'node:path';
const COOKIE=0x2112a442, MAX_PACKET=4096;
export function attr(type,value){const b=Buffer.from(value),out=Buffer.alloc(4+b.length+((4-b.length%4)%4));out.writeUInt16BE(type);out.writeUInt16BE(b.length,2);b.copy(out,4);return out;}
export function packet(type,tx,attributes,key){const body=Buffer.concat(attributes),header=Buffer.alloc(20);header.writeUInt16BE(type);header.writeUInt16BE(body.length+(key?24:0),2);header.writeUInt32BE(COOKIE,4);tx.copy(header,8);const prefix=Buffer.concat([header,body]);return key?Buffer.concat([prefix,attr(8,createHmac('sha1',key).update(prefix).digest())]):prefix;}
export function decode(data,tx,key){
 if(!Buffer.isBuffer(data)||data.length<20||data.length>MAX_PACKET||data.readUInt32BE(4)!==COOKIE||!data.subarray(8,20).equals(tx)||data.readUInt16BE(2)!==data.length-20)return null;
 const attrs=new Map();let integrity=null;
 for(let at=20;at<data.length;){if(at+4>data.length)return null;const type=data.readUInt16BE(at),size=data.readUInt16BE(at+2),end=at+4+size;if(end>data.length)return null;if(type===8){if(size!==20||integrity)return null;integrity={offset:at,value:data.subarray(at+4,end)};}else if(integrity && type!==0x8028)return null;if(attrs.has(type))return null;attrs.set(type,data.subarray(at+4,end));at=end+((4-size%4)%4);if(at>data.length)return null;}
 if(key){if(!integrity)return null;const prefix=Buffer.from(data.subarray(0,integrity.offset));prefix.writeUInt16BE(integrity.offset+24-20,2);const actual=createHmac('sha1',key).update(prefix).digest();if(!timingSafeEqual(actual,integrity.value))return null;}
 return {type:data.readUInt16BE(0),attrs};
}
export async function checkLocalTurn({port,secret,timeoutMs=2500,now=Date.now}={}){
 if(!Number.isInteger(port)||port<1024||port>65535||typeof secret!=='string'||secret.length<16||secret.length>512||!Number.isInteger(timeoutMs)||timeoutMs<100||timeoutMs>10000)throw Error('Invalid local TURN preflight configuration');
 const socket=createSocket('udp4');
 const exchange=(type,attrs,key,expected)=>new Promise((resolve,reject)=>{
  const tx=randomBytes(12),message=packet(type,tx,attrs,key);let timer;
  const done=(error,result)=>{clearTimeout(timer);socket.off('message',onMessage);socket.off('error',onError);error?reject(error):resolve(result);};
  const onError=()=>done(Error('Local TURN preflight unavailable'));
  const onMessage=(data,rinfo)=>{if(rinfo.address!=='127.0.0.1'||rinfo.port!==port)return;const parsed=decode(data,tx,key);if(!parsed)return;if(parsed.type!==expected)return done(Error('Local TURN preflight rejected'));done(null,parsed);};
  socket.on('message',onMessage);socket.once('error',onError);timer=setTimeout(()=>done(Error('Local TURN preflight timed out')),timeoutMs);socket.send(message,port,'127.0.0.1',error=>{if(error)done(Error('Local TURN preflight unavailable'));});
 });
 try{
  await exchange(1,[],null,0x0101);
  const challenge=await exchange(3,[attr(0x19,Buffer.from([17,0,0,0]))],null,0x0113);
  const code=challenge.attrs.get(9),realm=challenge.attrs.get(0x14),nonce=challenge.attrs.get(0x15);
  if(!code||code.length<4||code[2]!==4||code[3]!==1||!realm?.length||realm.length>256||!nonce?.length||nonce.length>512)throw Error('Local TURN challenge invalid');
  const user=Buffer.from(`${Math.floor(now()/1000)+60}:${randomBytes(12).toString('base64url')}`);
  const password=createHmac('sha1',secret).update(user).digest('base64');
  const key=createHash('md5').update(Buffer.concat([user,Buffer.from(':'),realm,Buffer.from(':'+password)])).digest();
  const auth=[attr(6,user),attr(0x14,realm),attr(0x15,nonce)];
  await exchange(3,[attr(0x19,Buffer.from([17,0,0,0])),...auth],key,0x0103);
  await exchange(4,[attr(0x0d,Buffer.alloc(4)),...auth],key,0x0104);
  return {binding:true,allocation:true,deallocation:true};
 }finally{socket.close();}
}
async function main(){
 if(process.argv.length!==4||process.argv[2]!=='--config')throw Error('A protected TURN config path is required');
 const file=process.argv[3],meta=await stat(file);if(!meta.isFile()||(meta.mode&0o077)!==0)throw Error('TURN config must be private');
 const lines=(await readFile(file,'utf8')).split(/\r?\n/),values={};for(const line of lines){const match=/^\s*(static-auth-secret|listening-port)\s*=\s*([^\s#]+)\s*$/.exec(line);if(match){if(values[match[1]])throw Error('Duplicate TURN setting');values[match[1]]=match[2];}}
 const result=await checkLocalTurn({port:Number(values['listening-port']),secret:values['static-auth-secret']});console.log(JSON.stringify(result));
}
if(process.argv[1]&&realpathSync(process.argv[1])===fileURLToPath(import.meta.url))main().catch(()=>{console.error('Local TURN preflight failed.');process.exitCode=1;});

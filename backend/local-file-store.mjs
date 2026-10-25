// Durable local review storage. Production continues to use DynamoDBStore.
import {MemoryStore} from './store.mjs';
import {mkdir,readFile,writeFile,rename,unlink,open,chmod} from 'node:fs/promises';
import path from 'node:path';
import {randomUUID} from 'node:crypto';

export class LocalFileStore extends MemoryStore {
  static async open(file){
    if(process.env.AWS_LAMBDA_FUNCTION_NAME)throw new Error('Local review storage is unavailable in Lambda.');
    const store=new LocalFileStore(path.resolve(file));
    await mkdir(path.dirname(store.file),{recursive:true,mode:0o700});
    const lock=store.file+'.lock';
    try{store.lock=await open(lock,'wx',0o600);}
    catch(error){
      if(error.code!=='EEXIST')throw error;
      let prior;try{prior=JSON.parse(await readFile(lock,'utf8'));}catch{throw new Error('Inspect the existing local storage lock before starting another server.');}
      let alive=true;try{process.kill(prior.pid,0);}catch(e){if(e.code==='ESRCH')alive=false;}
      if(alive)throw new Error('This review data file already has a running API server.');
      await unlink(lock);store.lock=await open(lock,'wx',0o600);
    }
    await store.lock.writeFile(JSON.stringify({pid:process.pid}));
    try{
      let raw;try{raw=await readFile(store.file,'utf8');}catch(error){if(error.code!=='ENOENT')throw error;}
      if(raw){
        if(Buffer.byteLength(raw)>32*1024*1024)throw new Error('Local review data is too large.');
        const data=JSON.parse(raw);if(data.version!==1||!Array.isArray(data.items))throw new Error('Local review data cannot be read; preserve it for repair.');
        for(const item of data.items){if(!item||typeof item.pk!=='string'||typeof item.sk!=='string')throw new Error('Invalid review record.');store.items.set(item.pk+'\0'+item.sk,item);}
        await chmod(store.file,0o600);
      }
      return store;
    }catch(error){await store.close();throw error;}
  }
  constructor(file){super();this.file=file;this.pending=Promise.resolve();this.closing=false;}
  async persist(){
    const temporary=this.file+'.'+randomUUID()+'.tmp';
    try{await writeFile(temporary,JSON.stringify({version:1,items:[...this.items.values()]}),{mode:0o600});await rename(temporary,this.file);}
    finally{await unlink(temporary).catch(error=>{if(error.code!=='ENOENT')throw error;});}
  }
  write(operation){
    if(this.closing)return Promise.reject(new Error('Local review storage is closing.'));
    const next=this.pending.then(async()=>{const previous=structuredClone(this.items);try{const result=await operation();await this.persist();return result;}catch(error){this.items=previous;throw error;}});
    this.pending=next.catch(()=>{});return next;
  }
  transact(ops){return this.write(()=>super.transact(ops));}
  increment(pk,sk,expiresAt){return this.write(()=>super.increment(pk,sk,expiresAt));}
  async get(pk,sk){await this.pending;return super.get(pk,sk);}
  async query(pk,options){await this.pending;return super.query(pk,options);}
  async close(){if(this.closing)return;this.closing=true;await this.pending;if(this.lock){await this.lock.close();this.lock=null;await unlink(this.file+'.lock');}}
}

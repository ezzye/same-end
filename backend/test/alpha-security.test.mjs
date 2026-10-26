import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash, createECDH, randomBytes, randomUUID} from 'node:crypto';
import {MemoryStore} from '../store.mjs';
import {createApi} from '../api.mjs';
import {createCommunityApi, COMMUNITY_LIMITS} from '../community-api.mjs';

const hash = x => createHash('sha256').update(x).digest('hex');
const time = Date.UTC(2026,9,26,12);
const PK = 'COMMUNITY#PILOT';
function event(method, path, body, token, claims) {
  return {rawPath:path,headers:{'content-type':'application/json',...(token&&{authorization:`Bearer ${token}`})},requestContext:{http:{method,sourceIp:'192.0.2.1'},...(claims&&{authorizer:{jwt:{claims}}})},...(body!==undefined&&{body:JSON.stringify(body)})};
}

test('security: updating a subscription concurrently with removal preserves the device-cap counter', async()=>{
  const store = new MemoryStore(), id=randomUUID(), token=randomBytes(32).toString('base64url');
  await store.put({pk:`CLUB#${id}`,sk:'META',id,readTokenHash:hash(token),writeTokenHash:hash('owner'),expiresAt:time/1000+86400});
  const api=createApi({store,now:()=>time,push:{enabled:false}}), dh=createECDH('prime256v1');
  const subscription={endpoint:`https://fcm.googleapis.com/fcm/send/${randomUUID()}`,keys:{p256dh:dh.generateKeys().toString('base64url'),auth:randomBytes(16).toString('base64url')}};
  const body={clientId:randomUUID(),subscription,eventIds:[]};
  const first=await api.handler(event('POST',`/v1/clubs/${id}/subscriptions`,body,token));
  assert.equal(first.statusCode,200);
  const subId=JSON.parse(first.body).id, originalPut=store.put.bind(store);
  let interleaved=false;
  store.put=async(item,condition)=>{
    if(!interleaved && item.sk===`SUB#${subId}`){
      interleaved=true;
      await api.deleteSubscription(id,subId);
    }
    return originalPut(item,condition);
  };
  const update=await api.handler(event('POST',`/v1/clubs/${id}/subscriptions`,body,token));
  assert.equal(update.statusCode,200);
  const rows=await store.query(`CLUB#${id}`,{from:'SUB#',to:'SUB#\uffff',limit:100});
  const count=await store.get(`CLUB#${id}`,'SUBCOUNT');
  assert.equal(rows.length,count.count,'A successfully revived row must count against the enforced subscription limit');
});

test('security: a public page reads only a bounded page of thread bodies',async()=>{
  const store=new MemoryStore();
  await store.put({pk:PK,sk:'SETTINGS',forumEnabled:true,joinCodeHash:hash('a-pilot-code'),version:1,rev:randomUUID()});
  for(let n=0;n<COMMUNITY_LIMITS.threads;n++){
    const id=randomUUID();
    await store.put({pk:PK,sk:`THREAD#${id}`,id,title:'Title',text:'x'.repeat(4000),category:'general',authorId:randomUUID(),authorName:'Fan',createdAt:time,updatedAt:time,expiresAt:time/1000+86400,version:1});
  }
  const api=createCommunityApi({store,now:()=>time});
  await api.backfillListings({dryRun:false,paceMs:0});
  const query=store.query.bind(store), reads=[];
  store.query=async(pk,options)=>{const rows=await query(pk,options);reads.push({prefix:options.from,rows:rows.length,bytes:Buffer.byteLength(JSON.stringify(rows))});return rows;};
  const response=await api.handler(event('GET','/v1/community/threads'));
  assert.equal(response.statusCode,200);
  assert.equal(JSON.parse(response.body).items.length,20);
  const bodiesRead=reads.filter(x=>x.prefix==='THREAD#').reduce((n,x)=>n+x.rows,0);
  assert.equal(bodiesRead,0,'Public listing must never read a thread body');
  assert.ok(reads.reduce((n,x)=>n+x.rows,0)<=40,'Index reads have a fixed bound');
  assert.ok(reads.reduce((n,x)=>n+x.bytes,0)<10000,'Index rows contain pointers, not copies of full post bodies');
});

test('security: unauthenticated legacy identities cannot consume the last capacity reserved for verified fan accounts',async()=>{
  const store=new MemoryStore();
  await store.put({pk:PK,sk:'COUNT#identities',count:COMMUNITY_LIMITS.identities-1});
  const fanAuth={issuer:'https://issuer.example.test',clientId:'fanclient',scope:'sameend-community/use'};
  const api=createCommunityApi({store,now:()=>time,fanAuth});
  const anonymous=await api.handler(event('POST','/v1/community/identities',{id:randomUUID(),name:'anonymous',tokenHash:hash(randomBytes(32))}));
  assert.equal(anonymous.statusCode,200);
  const claims={iss:fanAuth.issuer,client_id:fanAuth.clientId,token_use:'access',sub:randomUUID(),exp:time/1000+3600,scope:fanAuth.scope};
  const verified=await api.handler(event('POST','/v1/community/member/identity',{name:'Verified fan'},undefined,claims));
  assert.equal(verified.statusCode,200,`Unsigned registration prevented verified setup: ${verified.body}`);
});

test('security: legacy migration is explicit, read-only by default, idempotent, and preserves hidden text and versions',async()=>{
  const store=new MemoryStore(), id=randomUUID(), hiddenId=randomUUID();
  await store.put({pk:PK,sk:'SETTINGS',forumEnabled:true,joinCodeHash:hash('pilot-code'),rev:randomUUID()});
  for(const [threadId,hidden] of [[id,false],[hiddenId,true]]) await store.put({pk:PK,sk:`THREAD#${threadId}`,id:threadId,title:'Old discussion',text:hidden?'Original private/moderated text':'Public old discussion text',category:'club',authorId:randomUUID(),authorName:'Legacy fan',hidden,version:7,rev:randomUUID(),createdAt:time-1000,updatedAt:time-1000,expiresAt:time/1000+86400});
  const before=structuredClone([...store.items]);
  const api=createCommunityApi({store,now:()=>time});
  const unavailable=await api.handler(event('GET','/v1/community/threads'));
  assert.equal(unavailable.statusCode,503);assert.equal(JSON.parse(unavailable.body).code,'forum_index_not_ready');
  const afterRequest=structuredClone([...store.items]);
  assert.deepEqual(await api.backfillListings(),{checked:2,visible:1,dryRun:true});
  assert.deepEqual([...store.items],afterRequest,'Dry-run must not alter even the readiness marker');
  assert.equal((await api.backfillListings({dryRun:false,paceMs:0})).verified,2);
  await api.backfillListings({dryRun:false,paceMs:0});
  for(const [key,row] of before) assert.deepEqual(store.items.get(key),row,'Migration must not change source threads, settings, or retention');
  const response=await api.handler(event('GET','/v1/community/threads',undefined));
  const page=JSON.parse(response.body);assert.equal(page.total,1);assert.equal(page.items.length,1);assert.equal(page.items[0].id,id);assert.equal(page.items[0].version,7);
  assert.doesNotMatch(response.body,/sourceRev|indexKeys|Original private\/moderated text/);
  assert.equal((await store.get(PK,`THREAD#${hiddenId}`)).text,'Original private/moderated text');
});

test('security: capacity recovery accounts for old verified profiles, preserves data, and rejects concurrent allocation',async()=>{
  const store=new MemoryStore(), id=randomUUID(), legacyId=randomUUID();
  await store.put({pk:PK,sk:'COUNT#identities',count:999});
  await store.put({pk:PK,sk:'COUNT#feedback',count:999});
  await store.put({pk:PK,sk:`FAN#${id}`,id,accountKey:hash('verified'),name:'Existing verified',status:'suspended',rev:randomUUID()});
  await store.put({pk:PK,sk:`FAN#${legacyId}`,id:legacyId,name:'Legacy',expiresAt:time/1000+1000,rev:randomUUID()});
  await store.put({pk:PK,sk:`FEEDBACK#${id}#${randomUUID()}`,ownerId:id,text:'Private receipt',expiresAt:time/1000+1000,rev:randomUUID()});
  const api=createCommunityApi({store,now:()=>time}), before=structuredClone([...store.items]);
  const dry=await api.reconcileCapacity();
  assert.deepEqual(dry.proposed,{identities:1,'identities-verified':1,feedback:0,'feedback-verified':1});
  assert.deepEqual([...store.items],before);
  const transact=store.transact.bind(store);let raced=false;
  store.transact=async ops=>{
    if(!raced&&ops.length===4){raced=true;await transact([{key:{pk:PK,sk:'COUNT#identities'},add:{count:1}}]);}
    return transact(ops);
  };
  await assert.rejects(api.reconcileCapacity({dryRun:false}),{name:'Conflict'});
  store.transact=transact;
  await api.reconcileCapacity({dryRun:false});
  assert.equal((await store.get(PK,'COUNT#identities-verified')).count,1);
  assert.equal((await store.get(PK,`FAN#${id}`)).status,'suspended');
  assert.equal((await store.query(PK,{from:'FEEDBACK#',to:'FEEDBACK#\uffff'}))[0].text,'Private receipt');
});

test('security: legacy feedback exhaustion leaves verified feedback capacity available',async()=>{
  const store=new MemoryStore();
  await store.put({pk:PK,sk:'COUNT#feedback',count:COMMUNITY_LIMITS.feedback});
  const fanAuth={issuer:'https://issuer.example.test',clientId:'fanclient',scope:'sameend-community/use'};
  const api=createCommunityApi({store,now:()=>time,fanAuth});
  const claims={iss:fanAuth.issuer,client_id:fanAuth.clientId,token_use:'access',sub:randomUUID(),exp:time/1000+3600,scope:fanAuth.scope};
  assert.equal((await api.handler(event('POST','/v1/community/member/identity',{name:'Verified'},undefined,claims))).statusCode,200);
  const response=await api.handler(event('POST','/v1/community/member/feedback',{id:randomUUID(),kind:'problem',title:'Issue',text:'Test feedback'},undefined,claims));
  assert.equal(response.statusCode,200);
  assert.equal((await store.get(PK,'COUNT#feedback-verified')).count,1);
  assert.equal((await store.get(PK,'COUNT#feedback')).count,COMMUNITY_LIMITS.feedback);
});

test('security: every public ranking/category uses bounded pointer reads and blocked batches advance without exposing authors',async()=>{
  const store=new MemoryStore(), blocked=randomUUID(), visible=randomUUID();
  await store.put({pk:PK,sk:'SETTINGS',forumEnabled:true,joinCodeHash:hash('pilot-code'),rev:randomUUID()});
  for(let n=0;n<55;n++){
    const id=randomUUID();await store.put({pk:PK,sk:`THREAD#${id}`,id,title:`Thread ${n}`,text:'Public text',category:'club',authorId:n<50?blocked:visible,authorName:n<50?'Blocked name':'Visible name',version:1,rev:randomUUID(),createdAt:time-n*1000,updatedAt:time-n*1000,expiresAt:time/1000+1000});
  }
  const fanAuth={issuer:'https://issuer.example.test',clientId:'fanclient',scope:'sameend-community/use'}, sub=randomUUID(), fanId=randomUUID(), accountKey=hash(`${fanAuth.issuer}/${sub}`);
  await store.put({pk:PK,sk:`ACCOUNT#${accountKey}`,fanId});
  await store.put({pk:PK,sk:`FAN#${fanId}`,id:fanId,accountKey,blockedMemberIds:[blocked],name:'Reader'});
  const api=createCommunityApi({store,now:()=>time,fanAuth});await api.backfillListings({dryRun:false,paceMs:0});
  const claims={iss:fanAuth.issuer,client_id:fanAuth.clientId,token_use:'access',sub,exp:time/1000+3600,scope:fanAuth.scope};
  const query=store.query.bind(store);let rowsRead=0;
  store.query=async(pk,options)=>{assert.notEqual(options.from,'THREAD#','Public listings cannot fall back to source bodies');const rows=await query(pk,options);rowsRead+=rows.length;return rows;};
  for(const sort of ['new','top','hot'])for(const category of ['all','club']){
    rowsRead=0;
    const request=event('GET','/v1/community/member/threads',undefined,undefined,claims);request.queryStringParameters={sort,category};
    const first=await api.handler(request), page=JSON.parse(first.body);
    assert.equal(first.statusCode,200);assert.equal(page.items.length,0);assert.ok(page.cursor);assert.equal(rowsRead,40);assert.doesNotMatch(first.body,/Blocked name/);
    request.queryStringParameters.cursor=page.cursor;const second=await api.handler(request), rest=JSON.parse(second.body);
    assert.equal(rest.items.length,5);assert.ok(rest.items.every(x=>x.authorId===visible));assert.equal(rest.cursor,null);assert.equal(rowsRead,55);
  }
});

test('security: backfill retries a moderation race and never republishes hidden source content',async()=>{
  const store=new MemoryStore(), id=randomUUID(), sk=`THREAD#${id}`;
  await store.put({pk:PK,sk,id,title:'Existing',text:'Keep hidden',category:'general',authorId:randomUUID(),authorName:'Fan',version:1,rev:randomUUID(),createdAt:time,updatedAt:time,expiresAt:time/1000+1000});
  const api=createCommunityApi({store,now:()=>time}), transact=store.transact.bind(store);let raced=false;
  store.transact=async ops=>{
    if(!raced&&ops.some(x=>x.put?.sk===`TSUM#${id}`)){
      raced=true;const current=await store.get(PK,sk);await transact([{put:{...current,hidden:true,version:2,rev:randomUUID()}}]);
    }
    return transact(ops);
  };
  assert.equal((await api.backfillListings({dryRun:false,paceMs:0})).ready,true);
  assert.equal((await store.get(PK,sk)).hidden,true);
  assert.equal((await store.get(PK,sk)).text,'Keep hidden');
  assert.equal((await store.get(PK,`TSUM#${id}`)).version,2);
  assert.deepEqual(await store.query(PK,{from:'TLIST#',to:'TLIST#\uffff',limit:40}),[]);
});

test('security: first update of a revisionless legacy subscription is conditional on row existence',async()=>{
  const store=new MemoryStore(), id=randomUUID(), token=randomBytes(32).toString('base64url');
  await store.put({pk:`CLUB#${id}`,sk:'META',readTokenHash:hash(token),writeTokenHash:hash('owner'),expiresAt:time/1000+1000});
  const api=createApi({store,now:()=>time,push:{enabled:false}}), dh=createECDH('prime256v1');
  const subscription={endpoint:`https://fcm.googleapis.com/fcm/send/${randomUUID()}`,keys:{p256dh:dh.generateKeys().toString('base64url'),auth:randomBytes(16).toString('base64url')}};
  const subId=hash(`${id}/${subscription.endpoint}`), body={clientId:randomUUID(),subscription,eventIds:[]};
  await store.put({pk:`CLUB#${id}`,sk:`SUB#${subId}`,id:subId,clientId:body.clientId,subscription,eventIds:[],expiresAt:time/1000+1000});
  await store.put({pk:`CLUB#${id}`,sk:'SUBCOUNT',count:1,rev:1});
  const put=store.put.bind(store);let raced=false;
  store.put=async(item,condition)=>{if(!raced&&item.sk===`SUB#${subId}`){raced=true;assert.deepEqual(condition,{attribute:'rev',missing:true});await api.deleteSubscription(id,subId);}return put(item,condition);};
  assert.equal((await api.handler(event('POST',`/v1/clubs/${id}/subscriptions`,body,token))).statusCode,200);
  assert.equal((await store.get(`CLUB#${id}`,'SUBCOUNT')).count,1);
  assert.equal((await store.query(`CLUB#${id}`,{from:'SUB#',to:'SUB#\uffff'})).length,1);
});

test('security: 500-reply threads page bounded source rows, retain ancestry privately, and keep every reply reachable',async()=>{
  const store=new MemoryStore(), threadId=randomUUID(), authorId=randomUUID();
  const replyId=n=>`00000000-0000-4000-8000-${n.toString(16).padStart(12,'0')}`;
  await store.put({pk:PK,sk:'SETTINGS',forumEnabled:true,joinCodeHash:hash('pilot-code'),rev:randomUUID()});
  await store.put({pk:PK,sk:`THREAD#${threadId}`,id:threadId,title:'Full discussion',text:'Thread text',category:'general',authorId,authorName:'Host',version:1,rev:randomUUID(),replyCount:500,createdAt:time,updatedAt:time,expiresAt:time/1000+1000});
  for(let n=0;n<500;n++){
    const parent=n<20?n+200:n>=200&&n<220?n+100:n>=300&&n<320?n+100:null;
    const depth=n<20?4:n>=200&&n<220?3:n>=300&&n<320?2:1;
    const id=replyId(n), hidden=n===201||n===450;
    await store.put({pk:PK,sk:`REPLY#${threadId}#${id}`,id,threadId,parentId:parent===null?null:replyId(parent),depth,text:hidden?'HIDDEN PRIVATE TEXT':'x'.repeat(4000),authorId,authorName:hidden?'HIDDEN PRIVATE NAME':'Visible author',hidden,version:1,rev:randomUUID(),createdAt:time+n,expiresAt:time/1000+1000,...(n<20&&{replyToId:replyId(450),replyToName:'HIDDEN PRIVATE NAME'})});
    await store.put({pk:PK,sk:`RSCORE#${threadId}#${id}`,postId:id,score:2,expiresAt:time/1000+1000});
  }
  const query=store.query.bind(store), get=store.get.bind(store);let sourceRows=0, sourceGets=0, scoreGets=0;
  store.query=async(pk,options)=>{assert.ok(options.from.startsWith(`REPLY#${threadId}#`),'No bulk score/vote scan is allowed');assert.equal(options.limit,20);const rows=await query(pk,options);sourceRows+=rows.length;return rows;};
  store.get=async(pk,sk)=>{if(sk.startsWith('REPLY#'))sourceGets++;if(sk.startsWith('RSCORE#'))scoreGets++;return get(pk,sk);};
  const api=createCommunityApi({store,now:()=>time}), first=await api.handler(event('GET',`/v1/community/threads/${threadId}`)), page=JSON.parse(first.body);
  assert.equal(first.statusCode,200);assert.equal(sourceRows,20);assert.ok(sourceGets<=80);assert.equal(scoreGets,20);
  assert.equal(page.pageReplyIds.length,20);assert.equal(page.replyCount,500);assert.equal(page.replies.length,80);assert.ok(page.cursor);
  assert.doesNotMatch(first.body,/HIDDEN PRIVATE/);
  assert.ok(page.replies.filter(x=>x.context).every(x=>x.text===''&&x.authorId===null&&x.authorName===''));
  assert.ok(page.replies.some(x=>x.id===replyId(201)&&x.context&&x.hidden));
  const allIds=new Set(page.pageReplyIds), visibleIds=new Set(page.replies.filter(x=>!x.context).map(x=>x.id));let cursor=page.cursor, calls=1;
  while(cursor){
    sourceRows=0;sourceGets=0;scoreGets=0;
    const request=event('GET',`/v1/community/threads/${threadId}`);request.queryStringParameters={cursor};
    const response=await api.handler(request), next=JSON.parse(response.body);assert.equal(response.statusCode,200);
    assert.ok(sourceRows<=20);assert.ok(sourceGets<=80);assert.ok(scoreGets<=20);
    next.pageReplyIds.forEach(id=>allIds.add(id));next.replies.filter(x=>!x.context).forEach(x=>visibleIds.add(x.id));cursor=next.cursor;calls++;
    assert.ok(calls<=26,'All500 source rows are reachable in bounded pages');
  }
  assert.equal(allIds.size,500);assert.equal(visibleIds.size,498);
  const differentThread=event('GET',`/v1/community/threads/${randomUUID()}`);differentThread.queryStringParameters={cursor:page.cursor};
  // A real different thread must not accept another conversation's cursor.
  const otherId=randomUUID();await store.put({pk:PK,sk:`THREAD#${otherId}`,id:otherId,title:'Other',text:'Other',authorId,category:'general',expiresAt:time/1000+1000});
  differentThread.rawPath=`/v1/community/threads/${otherId}`;
  assert.equal((await api.handler(differentThread)).statusCode,400);
});

test('security: member reply cursors bind to the account and ancestor block labels contain no author text',async()=>{
  const store=new MemoryStore(), threadId=randomUUID(), blocked=randomUUID(), visible=randomUUID();
  await store.put({pk:PK,sk:'SETTINGS',forumEnabled:true,joinCodeHash:hash('pilot-code'),rev:randomUUID()});
  await store.put({pk:PK,sk:`THREAD#${threadId}`,id:threadId,title:'Thread',text:'Public',authorId:visible,category:'general',replyCount:21,expiresAt:time/1000+1000});
  const parentId='ffffffff-ffff-4fff-8fff-ffffffffffff';
  await store.put({pk:PK,sk:`REPLY#${threadId}#${parentId}`,id:parentId,threadId,text:'BLOCKED PRIVATE TEXT',authorName:'BLOCKED PRIVATE NAME',authorId:blocked,parentId:null,depth:1,createdAt:time,expiresAt:time/1000+1000});
  for(let n=0;n<20;n++){const id=`00000000-0000-4000-8000-${n.toString(16).padStart(12,'0')}`;await store.put({pk:PK,sk:`REPLY#${threadId}#${id}`,id,threadId,text:'Child',authorId:visible,authorName:'Visible',parentId,depth:2,createdAt:time+n+1,expiresAt:time/1000+1000});}
  const fanAuth={issuer:'https://issuer.example.test',clientId:'fanclient',scope:'sameend-community/use'}, api=createCommunityApi({store,now:()=>time,fanAuth});
  const claims=[];
  for(let n=0;n<2;n++){
    const sub=randomUUID(), id=randomUUID(), accountKey=hash(`${fanAuth.issuer}/${sub}`);
    await store.put({pk:PK,sk:`ACCOUNT#${accountKey}`,fanId:id});await store.put({pk:PK,sk:`FAN#${id}`,id,accountKey,blockedMemberIds:[blocked]});
    claims.push({iss:fanAuth.issuer,client_id:fanAuth.clientId,token_use:'access',sub,exp:time/1000+3600,scope:fanAuth.scope});
  }
  const first=await api.handler(event('GET',`/v1/community/member/threads/${threadId}`,undefined,undefined,claims[0])), page=JSON.parse(first.body);
  assert.equal(first.statusCode,200);assert.ok(page.cursor);assert.doesNotMatch(first.body,/BLOCKED PRIVATE/);
  const parent=page.replies.find(x=>x.id===parentId);assert.ok(parent.context&&parent.blocked);assert.equal(parent.authorId,null);
  const other=event('GET',`/v1/community/member/threads/${threadId}`,undefined,undefined,claims[1]);other.queryStringParameters={cursor:page.cursor};
  assert.equal((await api.handler(other)).statusCode,400);
});

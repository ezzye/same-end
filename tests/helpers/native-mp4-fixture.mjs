const u32=(b,p,n)=>b.writeUInt32BE(n,p);const box=(type,...parts)=>{const body=Buffer.concat(parts),b=Buffer.alloc(body.length+8);u32(b,0,b.length);b.write(type,4);body.copy(b,8);return b;};
function full(type,size,flags=0){const b=Buffer.alloc(size);u32(b,0,flags);return{b,done:()=>box(type,b)};}
export function make({swap=false,config=0,tfdt=0,composition=false}={}){
 const ids={vide:swap?2:1,soun:swap?1:2},sps=Buffer.from([0x67,66,0,31,config]),pps=Buffer.from([0x68,1]);
 const avc=Buffer.concat([Buffer.from([1,66,0,31,255,225,0,sps.length]),sps,Buffer.from([1,0,pps.length]),pps]);
 const sample=Buffer.concat([sps,pps,Buffer.from([0x65,1])].map(n=>{const b=Buffer.alloc(4);u32(b,0,n.length);return Buffer.concat([b,n]);})),audio=Buffer.from([1,2,3,4]);
 const mvhd=full('mvhd',100);u32(mvhd.b,12,1000);u32(mvhd.b,16,2000);
 function trak(type){const tkhd=full('tkhd',84);u32(tkhd.b,12,ids[type]);u32(tkhd.b,20,2000);const mdhd=full('mdhd',24);u32(mdhd.b,12,1000);u32(mdhd.b,16,2000);const hdlr=full('hdlr',25);hdlr.b.write(type,8);const stsd=full('stsd',8);u32(stsd.b,4,1);const entry=type==='vide'?box('avc3',Buffer.alloc(78),box('avcC',avc)):box('mp4a',Buffer.alloc(28));const tables=['stts','stsc','stco'].map(x=>full(x,8).done());return box('trak',tkhd.done(),box('mdia',mdhd.done(),hdlr.done(),box('minf',box('stbl',...tables,box('stsd',stsd.b,entry)))));}
 const trex=type=>{const x=full('trex',24);u32(x.b,4,ids[type]);u32(x.b,8,1);return x.done();};
 const moov=box('moov',mvhd.done(),trak('vide'),trak('soun'),box('mvex',trex('vide'),trex('soun')));
 const mfhd=full('mfhd',8);u32(mfhd.b,4,1);
 function traf(type,offset){const tfhd=full('tfhd',12,0x020020);u32(tfhd.b,4,ids[type]);const time=full('tfdt',12,0x01000000);u32(time.b,8,tfdt);const run=full('trun',composition?24:20,composition?0xb01:0x301);u32(run.b,4,1);u32(run.b,8,offset);u32(run.b,12,2000);u32(run.b,16,type==='vide'?sample.length:audio.length);return box('traf',tfhd.done(),time.done(),run.done());}
 let moof=box('moof',mfhd.done(),traf('vide',0),traf('soun',0));moof=box('moof',mfhd.done(),traf('vide',moof.length+8),traf('soun',moof.length+8+sample.length));return Buffer.concat([box('ftyp',Buffer.from('isom0000isom')),moov,moof,box('mdat',sample,audio)]);
}

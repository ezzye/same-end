/* Optional on-device BBC refresh. No account, cookies or Same End server involved. */
(()=>{'use strict';
const origin='https://www.bbc.co.uk';
async function page(team,month){
 if(!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(team)||team.length>70||!/^\d{4}-(0[1-9]|1[0-2])$/.test(month))throw Error('Choose a valid BBC football team.');
 if(!await chrome.permissions.contains({origins:[origin+'/*']}))throw Error('Allow BBC access in the helper to enable updates.');
 const url=`${origin}/sport/football/teams/${team}/scores-fixtures/${month}?filter=fixtures`;
 const control=new AbortController(),timer=setTimeout(()=>control.abort(),8000);
 try{const response=await fetch(url,{credentials:'omit',redirect:'error',signal:control.signal,headers:{Accept:'text/html'}});
  if(!response.ok||response.url!==url)throw Error('BBC fixtures could not be refreshed. Your saved matches are unchanged.');
  const reader=response.body.getReader(),chunks=[];let size=0;
  while(true){const {done,value}=await reader.read();if(done)break;size+=value.byteLength;if(size>1200000){await reader.cancel();throw Error('BBC fixture page is too large to read.');}chunks.push(value);}
  const bytes=new Uint8Array(size);let offset=0;for(const chunk of chunks){bytes.set(chunk,offset);offset+=chunk.length;}
  return {html:new TextDecoder().decode(bytes),url};
 }finally{clearTimeout(timer);}
}
async function refresh(team,now=Date.now()){
 const parts=Object.fromEntries(new Intl.DateTimeFormat('en-GB',{timeZone:'Europe/London',year:'numeric',month:'2-digit'}).formatToParts(now).map(p=>[p.type,p.value]));
 const start=new Date(Date.UTC(Number(parts.year),Number(parts.month)-1,1));let matches=[];
 for(let i=0;i<2;i++){const month=new Date(Date.UTC(start.getUTCFullYear(),start.getUTCMonth()+i,1)).toISOString().slice(0,7),response=await page(team,month);
  // Distinguish a changed/unreadable page from a legitimate month with no fixtures.
  if(!/window\.__INITIAL_DATA__\s*=/.test(response.html)||!response.html.includes('eventGroups'))throw Error('The BBC page format changed. Your saved fixtures are unchanged.');
  const parsed=SameEndReaderCore.readPage({...response,now});matches.push(...parsed.matches);
 }
 return SameEndReaderCore.normalize(matches,{now});
}
self.SameEndBBCFollow={page,refresh};
})();

const monthCodes='FGHJKMNQUVXZ';
const homeVenues=new Set(['NYSE','NYSEAMERICAN','NASDAQ','ISLAND','ARCA','AMEX','BATS','CBOE','IEX']);
const venue=hit=>hit.primaryExchange||hit.exchange||'';

export function tickerLabel(hit){
 if(!hit)return '';
 if(hit.secType!=='FUT')return hit.ticker||hit.symbol;
 const month=(hit.contractMonth||'').slice(0,6),code=monthCodes[Number(month.slice(4,6))-1];
 if(/^\d{6}$/.test(month)&&code)return '/'+(hit.ticker||hit.symbol)+code+month.slice(2,4);
 return '/'+(hit.localSymbol||hit.ticker||hit.symbol);
}

function issuerName(s){
 if(!s||s!==s.toUpperCase())return s;
 return s.toLowerCase().replace(/\b[a-z][a-z0-9]*\b/g,word=>
  ['etf','etn','plc','adr','reit','usd','ucits','usa','ii','iii','iv'].includes(word)?word.toUpperCase():word[0].toUpperCase()+word.slice(1));
}

function directoryRows(hits,term,futuresOnly){
 const rows=[];
 for(const hit of hits){
  const name=issuerName(hit.label||hit.symbol);
  const family=hit.secType==='IND'&&hit.derivatives?.includes('FUT')&&venue(hit);
  const exact=hit.symbol.toUpperCase()===term,domestic=hit.currency==='USD'&&homeVenues.has(venue(hit));
  const score=(exact?100:hit.symbol.toUpperCase().startsWith(term)?35:0)+(domestic?20:0)+(hit.derivatives?.includes('OPT')?12:0)+(hit.secType==='STK'?4:0)+(domestic&&term.length>=3&&name.toUpperCase().startsWith(term)?18:0);
  if(!futuresOnly&&hit.conId>0)rows.push({...hit,display:tickerLabel(hit),name,score});
  if(family)rows.push({...hit,display:'/'+hit.symbol,name:/futures?\b/i.test(name)?name:name+' Futures',family:hit.symbol+'@'+venue(hit),score:exact?85:24});
 }
 rows.sort((a,b)=>b.score-a.score);
 const first=new Map(),alternates=[];
 for(const row of rows){
  const primary=first.get(row.display);
  if(primary){alternates.push(row);row.qualifier=[venue(row),row.currency].filter(Boolean).join(' · ');if(primary.name===row.name)primary.qualifier=[venue(primary),primary.currency].filter(Boolean).join(' · ')}
  else first.set(row.display,row);
 }
 if(futuresOnly||term.length>1)return rows;
 const primary=[...first.values()],contracts=primary.filter(row=>!row.family),families=primary.filter(row=>row.family);
 return [...contracts.slice(0,6),...families.slice(0,4),...contracts.slice(6),...families.slice(4),...alternates];
}

function marked(el,value,query){
 const term=query.replace(/^\//,'').trim();
 const lower=value.toLowerCase(),needle=term.toLowerCase();let start=0;
 if(needle)for(let at=lower.indexOf(needle);at!==-1;at=lower.indexOf(needle,start)){
  el.append(value.slice(start,at));const mark=document.createElement('mark');mark.textContent=value.slice(at,at+term.length);el.append(mark);start=at+term.length;
 }
 el.append(value.slice(start));
}

export function connectTicker({search,select,current,onError}){
 const input=document.getElementById('symbol'),menu=document.getElementById('tickerMenu'),list=document.getElementById('tickerList');
 const status=document.getElementById('tickerStatus'),heading=document.getElementById('tickerFamily');
 let query='',family=null,rows=[],active=-1,revision=0,timer,queued=null,busy=false,enter=false;
 const cache=new Map();
 async function lookup(key){
  const cached=cache.get(key);if(cached&&Date.now()-cached.at<60000)return cached.hits;
  const hits=await search(key);
  if(cache.size>=48)cache.delete(cache.keys().next().value);
  cache.set(key,{at:Date.now(),hits});return hits;
 }
 function display(text=''){
  menu.hidden=false;input.setAttribute('aria-expanded','true');
  status.textContent=text;status.hidden=!text;heading.hidden=!family;heading.textContent=family?family.display+' '+family.name:'';
 }
 function clear(){
  rows=[];active=-1;list.replaceChildren();input.removeAttribute('aria-activedescendant');
 }
 function close(){
  ++revision;clearTimeout(timer);queued=null;enter=false;family=null;clear();
  menu.hidden=true;input.setAttribute('aria-expanded','false');
 }
 function highlight(i,keyboard=false){
  if(i<0||i>=rows.length)return;
  if(active>=0)list.children[active]?.setAttribute('aria-selected','false');
  active=i;const item=list.children[i];item.setAttribute('aria-selected','true');input.setAttribute('aria-activedescendant',item.id);
  if(keyboard){input.value=rows[i].display;item.scrollIntoView({block:'nearest',inline:'nearest'})}
 }
 function draw(results,needle){
  clear();rows=results;
  if(!rows.length){display(family?'No listed contract months.':'No matching TWS contracts.');return}
  const items=rows.map((r,i)=>{
   const item=document.createElement('li');item.id='ticker-option-'+i;item.dataset.index=i;item.setAttribute('role','option');item.setAttribute('aria-selected','false');
   item.title=[r.label,venue(r),r.currency,r.secType,r.conId>0?'IBKR '+r.conId:''].filter(Boolean).join(' · ');
   const symbol=document.createElement('span'),name=document.createElement('span');
   symbol.className='ticker-symbol';name.className='ticker-name';marked(symbol,r.display,needle);marked(name,r.name,needle);item.append(symbol,name);
   if(r.qualifier){const detail=document.createElement('small');detail.className='ticker-venue';detail.textContent=r.qualifier;item.append(detail)}
   if(r.family){const arrow=document.createElement('span');arrow.className='ticker-arrow';arrow.setAttribute('aria-hidden','true');arrow.textContent='▸';item.append(arrow)}
   return item;
  });
  list.replaceChildren(...items);list.scrollTop=0;display();highlight(0);
 }
 async function months(key,match=''){
  const hits=await lookup(key);
  return hits.map(hit=>{
   const code=tickerLabel(hit),date=(hit.contractMonth||hit.maturity||'').slice(0,6);
   const name=/^\d{6}$/.test(date)?new Intl.DateTimeFormat('en-US',{month:'short',year:'2-digit',timeZone:'UTC'}).format(new Date(date.slice(0,4)+'-'+date.slice(4)+'-01T12:00:00Z')).replace(' ','-'):hit.localSymbol;
   return {...hit,display:code,name,qualifier:hits.some(other=>other!==hit&&tickerLabel(other)===code)?hit.localSymbol+' · '+hit.maturity:''};
  }).filter(r=>!match||[r.display,'/'+r.localSymbol].some(v=>v.toUpperCase()===match));
 }
 async function matches(job){
  const term=job.term.toUpperCase();
  if(job.family||term.includes('@')&&!term.includes('#'))return months(job.family?.family||term.replace(/^\//,''));
  const slash=term.startsWith('/'),plain=slash?term.slice(1):term;
  if(!plain)return [];
  const specific=slash&&/^(.+?)([FGHJKMNQUVXZ])(\d{1,2})$/.exec(plain);
  const root=specific?specific[1]:plain;
  const families=directoryRows(await lookup(root),root,slash);
  if(!specific)return families;
  const exact=families.filter(f=>f.symbol===root&&f.family);
  return (await Promise.all(exact.map(f=>months(f.family,term)))).flat();
 }
 async function drain(){
  if(busy||!queued)return;
  const job=queued;queued=null;busy=true;
  try{
   const results=await matches(job);
   if(job.id===revision){draw(results,job.family?'':job.term);if(enter&&results.length)choose(0);else enter=false}
  }catch(error){if(job.id===revision){clear();display(error.message);enter=false}}
  finally{busy=false;if(queued)drain()}
 }
 function schedule(immediate=false){
  const id=++revision;clearTimeout(timer);queued=null;enter=false;clear();
  if(!query.trim()&&!family){close();return}
  const job={id,term:query.trim(),family};
  display('Searching TWS…');
  const run=()=>{queued=job;drain()};
  if(immediate)run();else timer=setTimeout(run,180);
 }
 function choose(index){
  const hit=rows[index];if(!hit)return;
  if(hit.family){family=hit;query=hit.display;input.value=query;schedule(true);return}
  close();input.blur();input.value=hit.display;
  Promise.resolve(select(hit)).catch(onError).finally(()=>{if(document.activeElement!==input)input.value=current()});
 }
 input.addEventListener('focus',()=>{input.select();family=null;query=input.value;schedule()});
 input.addEventListener('input',event=>{family=null;query=input.value;if(!event.isComposing)schedule()});
 input.addEventListener('compositionend',()=>{query=input.value;schedule()});
 input.addEventListener('blur',()=>{close();input.value=current()});
 input.addEventListener('keydown',event=>{
  if(event.isComposing)return;
  if(event.key==='Escape'){event.preventDefault();event.stopPropagation();input.value=menu.hidden?current():query;close();return}
  if(event.key==='ArrowDown'||event.key==='ArrowUp'){
   event.preventDefault();
   if(menu.hidden){query=input.value;schedule(true);return}
   if(rows.length)highlight((active+(event.key==='ArrowDown'?1:-1)+rows.length)%rows.length,true);
  }
  if(event.key==='ArrowLeft'&&family){event.preventDefault();family=null;schedule(true)}
 });
 document.getElementById('symbolForm').addEventListener('submit',e=>{
  e.preventDefault();
  if(rows.length){choose(active<0?0:active);return}
  if(menu.hidden&&input.value.trim()){query=input.value;schedule(true)}
  if(!menu.hidden)enter=true;
 });
 list.addEventListener('pointermove',e=>{const item=e.target.closest('[data-index]');if(item)highlight(Number(item.dataset.index))});
 menu.addEventListener('mousedown',e=>e.preventDefault());
 list.addEventListener('click',e=>{const item=e.target.closest('[data-index]');if(item)choose(Number(item.dataset.index))});
}

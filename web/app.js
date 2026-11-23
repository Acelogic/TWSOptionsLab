import {closedQuantity,remainingQty,realizedPnl,optionFee,projectPositions,analyze,drawRisk,drawInspection,estimateImpliedVolatility,expiryMs,formatGreek,greekModes,modelRho,payoff,positionMark,scenarioEvaluator,scenarioGreekEvaluator,scenarioPriceBounds} from './risk.js';
import {presets,makePreset,strategyShape} from './strategies.js';
import {bindSavedTrades} from './saved.js';
import {bindOptionsHistory} from './options-history.js';
import {connectTicker,tickerLabel} from './ticker.js';
import {screenSpreads,screenTemplates} from './optimizer.js';

const $=id=>document.getElementById(id);
const esc=v=>String(v??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const fmt=(v,d=2)=>v==null||!Number.isFinite(v)?'—':v.toLocaleString('en-US',{maximumFractionDigits:d,minimumFractionDigits:0});
const money=v=>v===Infinity?'Unlimited':v==null||!Number.isFinite(v)?'—':new Intl.NumberFormat('en-US',{style:'currency',currency:state.info?.currency||'USD',maximumFractionDigits:2,minimumFractionDigits:0}).format(v);
const valid=v=>typeof v==='number'&&Number.isFinite(v);
const dateStr=(s,year=false)=>s?new Date(s.slice(0,4)+'-'+s.slice(4,6)+'-'+s.slice(6,8)+'T12:00:00Z').toLocaleDateString('en-US',{month:'short',day:'numeric',...(year?{year:'numeric'}:{}),timeZone:'UTC'}):'—';
const et=t=>new Date(t).toLocaleTimeString('en-US',{timeZone:'America/New_York',hour:'2-digit',minute:'2-digit',second:'2-digit',hour12:false});
const etDate=t=>new Date(t).toLocaleDateString('en-US',{timeZone:'America/New_York',month:'short',day:'numeric'});
function message(v=''){$('message').textContent=v;$('message').hidden=!v}
async function api(path,data){
 const response=await fetch('/api/'+path,data===undefined?{cache:'no-store'}:{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(data)});
 if(!response.ok){let msg=await response.text();try{msg=JSON.parse(msg).error||msg}catch{}throw Error(msg)}
 return response.json();
}
const qs=obj=>new URLSearchParams(obj).toString();
const state={info:null,root:'',expiry:'',book:null,legs:[],active:0,quotes:{},mode:1,center:0,name:'Long call',page:'build',view:'graph',hoverY:null,historyHover:null,heatHover:null,act:'updates',savedId:null,version:null,screen:[],points:[],spot:null,spotLabel:'',seq:0,ready:false,hover:null,activitySeq:0,historySeq:0,unit:'usd',reloadedAt:0};
let positionsClosed=false;
state.commissionPerContract=0;
const books=new Map();
let observed={key:'',points:[]};
const cleanLeg=l=>({...Object.fromEntries(['kind','symbol','secType','currency','root','right','strike','expiry','qty','entry','multiplier','style','settlement','expiresAt','conId','entryFeed'].map(k=>[k,l[k]??null])),...(l.excluded?{excluded:true}:{}),...(l.closes?.length?{closes:l.closes}:{})});
function doc(){return {schema:1,symbol:state.info.symbol,root:state.root,expiry:state.expiry,name:state.name,pricing:state.pricing,commissionPerContract:state.commissionPerContract,legs:state.legs.map(cleanLeg)}}
function draft(){
 if(!state.ready||!state.info)return;
 const document=doc();
 if(state.savedId)document.savedTrade={id:state.savedId,version:state.version};
 try{localStorage.setItem('optionslab.draft.v1',JSON.stringify(document))}catch{}
}
function attachSaved(item,legs=[],commission=item?.document?.commissionPerContract??0){
 const baseline=item?structuredClone(legs.map(cleanLeg)):null;
 Object.assign(state,{savedId:item?.id??null,version:item?.version??null,savedLegs:baseline,
  savedSignature:baseline?JSON.stringify(baseline):null,savedCommission:commission,comparison:'current'});
}
function hasSavedChanges(){
 return !!state.savedLegs&&(state.commissionPerContract!==state.savedCommission||state.savedSignature!==JSON.stringify(state.legs.map(cleanLeg)));
}
function displayLegs(){
 return state.comparison==='previous'&&state.page==='build'&&state.view!=='history'&&state.savedLegs?state.savedLegs:state.legs;
}
function excludedText(source){
 return source===state.legs?'All legs excluded. Select Include to restore a leg.':'All saved legs are excluded.';
}
const compareControls=document.createElement('div');
compareControls.className='seg';compareControls.hidden=true;compareControls.setAttribute('role','group');
compareControls.setAttribute('aria-label','Compare saved and edited strategy');
for(const [key,label,title] of [['previous','Previous','View the last saved positions'],['current','Current','View the positions being edited']]){
 const button=document.createElement('button');button.type='button';button.dataset.comparison=key;
 const arrow=document.createElement('span');arrow.setAttribute('aria-hidden','true');arrow.textContent=key==='previous'?'← ':'→ ';
 button.append(arrow,label);button.title=title;button.onclick=()=>{state.comparison=key;state.heatHover=null;state.hover=null;render()};
 compareControls.append(button);
}
document.querySelector('.chart-controls').append(compareControls);
function syncComparison(){
 const available=state.page==='build'&&state.view!=='history'&&hasSavedChanges();
 compareControls.hidden=!available;
 if(!available){state.comparison='current';return}
 for(const button of compareControls.children){
  const selected=button.dataset.comparison===state.comparison;
  button.classList.toggle('active',selected);button.setAttribute('aria-pressed',String(selected));
 }
}
function selectOptions(el,values,selected,fn=x=>x){el.innerHTML=values.map(v=>'<option value="'+esc(v)+'"'+(v===selected?' selected':'')+'>'+esc(fn(v))+'</option>').join('')}
function laterExp(exp=state.expiry){const es=state.info.roots[state.root].expiries;return es[es.indexOf(exp)+1]}
async function bookFor(symbol,root,expiry){
 const k=[symbol,root,expiry].join('|');
 if(!books.has(k))books.set(k,api('book?'+qs({symbol,root,expiry})).catch(e=>{books.delete(k);throw e}));
 return books.get(k);
}
async function qualify(raw,info=state.info){
 checkCloses(raw);
 if(raw.kind==='option'&&raw.closes?.length&&!remainingQty(raw)&&raw.multiplier>0&&
  ((Number.isInteger(raw.conId)&&raw.conId>0)||archivedOption(raw)))return {...raw,symbol:info.symbol};
 if(raw.kind==='stock'){
  if(info.secType!=='STK')throw Error('Share legs require a stock or ETF.');
  return {...raw,conId:info.conId,multiplier:1,symbol:info.symbol,currency:info.currency,secType:info.secType};
 }
 const b=await bookFor(info.symbol,raw.root,raw.expiry),s=b.strikes.find(v=>v.strike===raw.strike),conId=s?.[raw.right];
 if(!conId)throw Error('TWS did not list '+raw.root+' '+raw.expiry+' '+raw.strike+raw.right+'.');
 return {...raw,conId,symbol:info.symbol,currency:info.currency,secType:info.secType==='FUT'?'FOP':'OPT',style:info.style,multiplier:info.roots[raw.root].multiplier,settlement:b.settlement,expiresAt:b.expiresAt??null};
}
function nearest(book,price,right){let rows=right?book.strikes.filter(r=>r[right]):book.strikes;if(!rows.length)throw Error('No listed strikes available.');if(!valid(price))return rows[Math.floor(rows.length/2)];return rows.reduce((a,b)=>Math.abs(a.strike-price)<=Math.abs(b.strike-price)?a:b)}
function feeRate(source){return source===state.savedLegs?state.savedCommission:state.commissionPerContract}
function openLegs(source=state.legs){
 return projectPositions(source,state.quotes,feeRate(source));
}
function checkCloses(leg){
 if(!leg.closes?.length)return;
 const badTime=f=>f.at!=null?f.confirmedClosedBy!=null||!Number.isSafeInteger(f.at)||f.at<1:
  !Number.isSafeInteger(f.confirmedClosedBy)||f.confirmedClosedBy<1||f.confirmedClosedBy>Date.now();
 if(!Array.isArray(leg.closes)||!valid(leg.entry)||leg.closes.some(f=>!f||!Number.isSafeInteger(f.qty)||f.qty<1||!valid(f.price)||f.price<0||badTime(f))||closedQuantity(leg)>Math.abs(leg.qty))
  throw Error('This position has an invalid closing fill.');
}
const archiveDay=new Intl.DateTimeFormat('sv-SE',{timeZone:'America/New_York',year:'numeric',month:'2-digit',day:'2-digit'});
function archivedOption(l,now=Date.now()){
 if(l.kind!=='option'||l.conId!=null||!l.qty||!Array.isArray(l.closes)||!l.closes.length||remainingQty(l)!==0||!l.closes.every(f=>(f.at??f.confirmedClosedBy)<=now))return false;
 const today=archiveDay.format(now).replaceAll('-','');
 return /^\d{8}$/.test(l.expiry)&&(l.expiresAt==null?l.expiry<today:l.expiry<=today&&l.expiresAt>0&&l.expiresAt<=now);
}
function archivedStrategy(doc){
 return Array.isArray(doc?.legs)&&doc.legs.some(l=>archivedOption(l))&&doc.legs.every(l=>Array.isArray(l.closes)&&!remainingQty(l)&&l.closes.every(f=>(f.at??f.confirmedClosedBy)<=Date.now()));
}
async function initialSpot(info,book){
 const middle=book.strikes[Math.floor(book.strikes.length/2)];
 const ids=[info.conId,middle?.C??middle?.P].filter(Number.isInteger);
 for(let i=0;i<6;i++){
  const d=await api('quotes',{ids,mode:state.mode}),u=d.quotes[info.conId]??{},option=d.quotes[ids[1]];
  const spot=u.mid??option?.modelUnderlying??u.last??u.close;
  if(valid(spot))return spot;
  if(i<5)await new Promise(resolve=>setTimeout(resolve,250));
 }
 return null;
}
function expirationMap(dates,listed){
 const when=s=>Date.UTC(+s.slice(0,4),+s.slice(4,6)-1,+s.slice(6,8));
 const ordered=[...new Set(dates.filter(Boolean))].sort(),chosen=new Map();
 let previous=-1;
 for(const [i,date] of ordered.entries()){
  const unique=listed.length>=ordered.length;
  const candidates=unique?listed.slice(previous+1,listed.length-ordered.length+i+1):listed;
  const expiry=candidates.reduce((a,b)=>Math.abs(when(a)-when(date))<=Math.abs(when(b)-when(date))?a:b);
  chosen.set(date,expiry);previous=listed.indexOf(expiry);
 }
 return chosen;
}
async function rebuildLegs(old,info,root,dates,reference){
 const legs=old.filter(l=>remainingQty(l)&&(l.kind==='option'||info.secType==='STK'));
 const options=legs.filter(l=>l.kind==='option'),converted=new Map();
 await Promise.all([...new Set(options.map(l=>dates.get(l.expiry)))].map(async expiry=>{
  const book=await bookFor(info.symbol,root,expiry),group=options.filter(l=>dates.get(l.expiry)===expiry);
  const distinct=[...new Set(group.map(l=>l.strike))].sort((a,b)=>a-b);
  const anchor=state.spot??state.center,spot=reference??book.strikes[Math.floor(book.strikes.length/2)].strike;
  let previous=-Infinity;
  for(const [i,strike] of distinct.entries()){
   const at=group.filter(l=>l.strike===strike),rights=[...new Set(at.map(l=>l.right))];
   const eligible=book.strikes.filter(row=>rights.every(right=>row[right]));
   const higher=eligible.filter(row=>row.strike>previous);
   const spaced=higher.slice(0,Math.max(1,higher.length-(distinct.length-i-1)));
   const target=anchor>0?strike*spot/anchor:spot+(strike-anchor);
   const next=nearest({strikes:spaced.length?spaced:eligible},target).strike;previous=next;
   for(const leg of at)converted.set(leg,{root,expiry,strike:next,right:leg.right});
  }
 }));
 return Promise.all(legs.map(l=>qualify({kind:l.kind,qty:remainingQty(l),entry:null,...converted.get(l),...(l.excluded?{excluded:true}:{})},info)));
}
function syncTicker(){
 if(document.activeElement!==$('symbol'))$('symbol').value=tickerLabel(state.info);
}
async function load(symbol,wanted=null,carry=false,savedItem=null){
 if(archivedStrategy(wanted)){
  wanted.legs.forEach(checkCloses);page('saved');showArchive(savedItem||{name:wanted.name,document:wanted});return;
 }
 const seq=++state.seq;state.ready=false;message('Loading the listed option series from TWS…');
 try{
  const info=await api('instrument?'+qs({symbol}));if(seq!==state.seq)return;
  const fee=carry&&state.info?.currency===info.currency?state.commissionPerContract:wanted?.commissionPerContract??0;
  if(!valid(fee)||fee<0||fee>Number.MAX_SAFE_INTEGER)throw Error('Enter a valid nonnegative commission per contract.');
  const root=wanted?.root&&info.roots[wanted.root]?wanted.root:info.defaultRoot;
  if(!root || !info.roots[root]){
   if(wanted?.legs?.length)throw Error('This saved strategy needs an available option series to reopen its live positions.');
   Object.assign(state,{info,root:null,expiry:null,book:null,legs:[],quotes:{},ready:true,spot:null,name:info.ticker+' underlying',savedId:null,version:null,screen:[],points:[]});
   state.commissionPerContract=fee;attachSaved(null);syncTicker();structure();message();draft();await tick();return;
  }
  const listed=info.roots[root].expiries;
  const dates=carry?expirationMap([state.expiry,...state.legs.filter(l=>remainingQty(l)).map(l=>l.expiry)],listed):null;
  const exp=dates?.get(state.expiry)??(listed.includes(wanted?.expiry)?wanted.expiry:listed[0]);
  const b=await bookFor(info.symbol,root,exp);if(seq!==state.seq)return;
  let legs,name;
  if(Array.isArray(wanted?.legs)){
   legs=await Promise.all(wanted.legs.map(l=>qualify(l,info)));name=wanted.name||'Custom strategy';
  }else{
   const reference=await initialSpot(info,b);if(seq!==state.seq)return;
   legs=carry?await rebuildLegs(state.legs,info,root,dates,reference):[];
   if(legs.length){
    name=legs.length===state.legs.length?state.name:'Custom strategy';
   }else{
    const right=b.strikes.some(row=>row.C)?'C':'P',at=nearest(b,reference,right).strike;
    legs=[await qualify({kind:'option',root,right,expiry:exp,strike:at,qty:1,entry:null,entryFeed:null},info)];
    name=right==='C'?'Long call':'Long put';
   }
  }
  let baseline=legs;
  if(savedItem&&savedItem.document!==wanted){
   baseline=await Promise.all(savedItem.document.legs.map(async l=>{
    try{return await qualify(l,info)}catch(e){if(Number.isInteger(l.conId)&&l.multiplier>0)return l;throw e}
   }));
  }
  if(seq!==state.seq)return;
  Object.assign(state,{info,root,expiry:exp,book:b,legs,name,pricing:carry?state.pricing:(wanted?.pricing==='natural'?'natural':'mid'),active:0,ready:true,quotes:{},spot:null,center:legs.find(l=>l.kind==='option')?.strike??b.strikes[0].strike,points:[],screen:[]});
  state.commissionPerContract=fee;attachSaved(savedItem,baseline);
  syncTicker();if(!carry){pickedDate=null;$('horizon').value=greekModes[state.unit]?'0':'100';$('iv').value='1'}$('optTarget').value='';$('targetPrice').value='';
  structure();message();draft();await tick();
 }catch(e){if(seq!==state.seq)return;message(e.message);state.ready=!!state.info;syncTicker();structure();throw e}
}
function windowRows(limit){
 if(!state.book)return [];
 const all=state.book.strikes,count=Math.min(limit??(state.page==='optimize'?21:13),all.length);
 const i=all.indexOf(nearest(state.book,state.center));
 const left=Math.max(0,Math.min(all.length-count,i-Math.floor(count/2)));
 return all.slice(left,left+count);
}
function structure(){
 if(!state.info)return;
 const noBook=!state.book;
 $('optionRails').hidden=noBook;$('classControl').hidden=noBook;$('quoteOnly').hidden=!noBook||state.page==='saved';
 $('build').hidden=state.page!=='build'||noBook;$('optimize').hidden=state.page!=='optimize'||noBook;
 for(const id of ['template','addLeg','save','share','topHistory','positions'])$(id).hidden=state.page!=='build'||noBook;
 $('calendarOptions').hidden=state.info.secType!=='STK'||state.view!=='table';
 $('listingLabel').textContent=[state.info.primaryExchange||state.info.exchange,state.info.currency].filter(Boolean).join(' · ');
 $('currencyNote').textContent=state.info.currency?'Contract currency · '+state.info.currency:'Contract currency';
 $('marketLabel').textContent=[state.info.ticker,state.info.secType,state.info.primaryExchange||state.info.exchange,state.info.currency].filter(Boolean).join(' · ');
 if(noBook){$('noOptions').textContent=state.info.chainError?'TWS chain unavailable · '+state.info.chainError:'TWS returned no listed option series for this contract.';$('underlyingQuote').textContent='Waiting for TWS quotes.';}
 $('h1').textContent=presets.some(p=>p.name.toLowerCase()===state.name.toLowerCase())?state.name.replace(/\b[a-z]/g,ch=>ch.toUpperCase()):state.name;$('positions').textContent='Positions ('+state.legs.length+')';
 selectOptions($('root'),Object.keys(state.info.roots),state.root);
 if(!state.book)return;
 if(state.page==='optimize')optimizerDates();
 const groupNames=[...new Set(presets.map(p=>p.group))],selected=presets.find(p=>p.name.toLowerCase()===state.name.toLowerCase())?.id||'';
 $('template').innerHTML='<option value="">Strategy templates</option>'+groupNames.map(g=>'<optgroup label="'+esc(g)+'">'+presets.filter(p=>p.group===g).map(p=>'<option value="'+esc(p.id)+'"'+(p.id===selected?' selected':'')+(p.usesStock&&state.info.secType!=='STK'||p.usesNextExpiry&&!laterExp()?' disabled':'')+'>'+esc(p.name)+'</option>').join('')+'</optgroup>').join('');
 const expiries=state.info.roots[state.root].expiries;
 const months=Map.groupBy?Map.groupBy(expiries,e=>e.slice(0,6)):expiries.reduce((m,e)=>{const k=e.slice(0,6);if(!m.has(k))m.set(k,[]);m.get(k).push(e);return m},new Map());
 $('expiries').innerHTML=[...months].map(([month,dates])=>'<div class="month-group"><div class="month-name">'+esc(dateStr(dates[0]).split(' ')[0]+(month.slice(0,4)!==expiries[0].slice(0,4)?" ’"+month.slice(2,4):''))+'</div><div class="days">'+dates.map(e=>'<button data-exp="'+e+'" class="'+(e===state.expiry?'active':'')+'" title="'+esc(dateStr(e,true))+'">'+Number(e.slice(6))+'</button>').join('')+'</div></div>').join('');
 $('strikePan').max=state.book.strikes.length-1;$('strikePan').value=state.book.strikes.indexOf(nearest(state.book,state.center));
 $('expiryText').textContent=dateStr(state.expiry,true)+' · '+state.book.strikes.length+' listed strikes';
 const seriesLegs=state.legs.map((leg,index)=>({leg,index})).filter(({leg})=>leg.kind==='option'&&leg.root===state.root&&leg.expiry===state.expiry);
 const legIndices=seriesLegs.map(({leg})=>state.book.strikes.findIndex(row=>row.strike===leg.strike)).filter(i=>i>=0);
 const distinct=[...new Set(legIndices)].sort((a,b)=>a-b);
 const closest=distinct.slice(1).reduce((gap,n,i)=>Math.min(gap,n-distinct[i]),Infinity);
 const railWidth=$('strikes').clientWidth||850;
 const markerWidth=Math.max(70,...seriesLegs.map(({leg})=>{
  const qty=Math.abs(remainingQty(leg));
  const chars=String(leg.strike).length+1+(qty>1?String(qty).length+2:0);
  return 18+chars*9+legStates(leg).length*15;
 }));
 const railCount=Math.max(3,Math.min(53,Math.floor(railWidth/markerWidth*closest)));
 const rows=windowRows(railCount);
 state.railRows=rows;state.railWidth=railWidth;
 const stacks=new Map();
 for(const item of seriesLegs){
  const key=item.leg.strike,lanes=stacks.get(key)??{long:[],short:[]};
  lanes[item.leg.qty>0?'long':'short'].push(item);stacks.set(key,lanes);
 }
 const visibleStacks=rows.map(row=>stacks.get(row.strike)).filter(Boolean);
 for(const side of ['long','short'])$('strikes').style.setProperty('--'+side+'-height',Math.max(0,...visibleStacks.map(stack=>stack[side].length))*23+'px');
 const majorEvery=Math.max(1,Math.ceil(rows.length/Math.max(5,Math.floor($('strikes').clientWidth/80))));
 const centerIndex=rows.indexOf(nearest({strikes:rows},state.center));
 $('strikes').style.setProperty('--cols',rows.length);
 $('strikes').innerHTML=rows.map((s,i)=>{
  const major=(i-centerIndex)%majorEvery===0;
  const stack=stacks.get(s.strike);
  const tags=['long','short'].map(side=>{
   if(!stack?.[side].length)return '';
   return '<span class="markers '+side+'-markers">'+stack[side].map(({leg,index})=>{
    const qty=remainingQty(leg),states=legStates(leg);
    const label=[side+' '+positionContract(leg),'quantity '+Math.abs(qty),...states.map(s=>s[2])].join(', ');
    return '<span data-movable="'+(!leg.closes?.length)+'" class="marker '+(side==='short'?'short ':'')+(leg.right==='P'?'put ':'call ')+(leg.excluded?'excluded ':'')+(!qty?'closed ':'')+(index===state.active?'selected':'')+'" data-leg="'+index+'" title="'+esc(label)+'"><span class="marker-text">'+esc(leg.strike)+leg.right+(Math.abs(qty)>1?' ×'+Math.abs(qty):'')+'</span>'+stateIcons(states)+'</span>';
   }).join('')+'</span>';
  }).join('');
  return '<button class="strike '+(major?'major':'')+'" data-strike="'+s.strike+'" aria-label="Strike '+s.strike+'" title="'+esc(fmt(s.strike))+'">'+tags+(major?'<span class="tick-label">'+esc(fmt(s.strike))+'</span>':'')+'</button>';
 }).join('')+'<span id="railSpot" hidden></span>';
 const volumes=$('strikeVolumes');
 volumes.style.setProperty('--cols',rows.length);
 volumes.innerHTML=rows.map(()=>'<span class="volume-cell"><i class="call-volume"></i><i class="put-volume"></i></span>').join('');
 $('chainCount').textContent=windowRows().length+' strikes in view';
 legsPanel();render();
 if(state.ready&&state.page==='build'&&state.view==='history'&&historySeries!==state.seq)loadHistory();
}
function entryQuote(leg,quote,mode=state.pricing){
 return mode==='natural'?(leg.qty>0?quote?.ask:quote?.bid):quote?.mid;
}
function customEntry(leg){
 return valid(leg.entry)&&!['Live','Frozen','Delayed','Delayed frozen'].some(feed=>feed.toLowerCase()===String(leg.entryFeed).toLowerCase());
}
function legStates(leg){
 const states=[];
 if(customEntry(leg))states.push(['entry','$','Custom entry']);
 if(leg.excluded)states.push(['excluded','<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M3 3l18 18M9 5.8c1-.3 2-.5 3-.5 5 0 8.7 4.5 10 6.7-.6 1.1-1.6 2.5-2.9 3.7M15.5 18c-1.1.5-2.3.7-3.5.7-5 0-8.7-4.5-10-6.7a18 18 0 0 1 4.7-5.1M9.6 9.6a3.4 3.4 0 0 0 4.8 4.8"/></svg>','Excluded from calculations']);
 if(closedQuantity(leg))states.push(remainingQty(leg)?['partial','◐','Partially closed']:['closed','✓','Closed']);
 return states;
}
function stateIcons(states){
 return states.map(([kind,icon,label])=>'<span class="leg-state state-'+kind+'" role="img" aria-label="'+label+'" title="'+label+'">'+icon+'</span>').join('');
}
function updateStrikeVolumes(){
 const histogram=$('strikeVolumes'),toggle=$('railVolume');
 histogram.hidden=!toggle.checked;
 if(histogram.hidden||!state.railRows)return;
 const volumes=state.railRows.map(row=>['C','P'].map(right=>{
  const value=state.quotes[row[right]]?.volume;
  return valid(value)&&value>=0?value:null;
 }));
 const peak=Math.max(0,...volumes.flat().filter(valid));
 const reported=volumes.some(pair=>pair.some(valid));
 histogram.dataset.empty=String(!reported);
 for(const [i,cell] of Array.from(histogram.children).entries()){
  const pair=volumes[i],counts=pair.map(value=>valid(value)?fmt(value):'unavailable');
  const label=state.railRows[i].strike+' · Call volume '+counts[0]+' · Put volume '+counts[1];
  cell.title=label;cell.setAttribute('aria-label',label);cell.setAttribute('role','img');
  pair.forEach((v,side)=>{cell.children[side].style.height=v>0?Math.max(1,Math.round(20*v/peak))+'px':'0'});
 }
}
function positionContract(leg){
 return leg.kind==='option'?leg.root+' '+leg.strike+leg.right+' '+shortExpiry(leg.expiry):(state.info?.ticker||leg.symbol.split('#')[0])+' shares';
}
function positionPrice(value){
 return valid(value)?(Number.isInteger(value)?fmt(value):premium(value)):'—';
}
function positionRow(leg,index){
 const qty=positionsClosed?Math.sign(leg.qty)*closedQuantity(leg):remainingQty(leg);
 const badge=code=>'<span class="action-code">'+code+'</span> ';
 const size=qty===1?'':qty+'× ';
 const fills=positionsClosed?(leg.closes??[]).map(fill=>'<span class="fill">'+badge(leg.qty>0?'STC':'BTC')+
  (leg.closes.length>1?fill.qty+'× ':'')+'at '+positionPrice(fill.price)+(fill.reason==='expiredWorthless'?' · Expired worthless':'')+
  (fill.confirmedClosedBy!=null?' · '+esc(closeDate(fill)):'')+'</span>').join(''):'';
 const contract=esc(positionContract(leg));
 return '<div class="position-row" data-legrow="'+index+'"><button class="gear" data-pick="'+index+'" aria-label="Edit position '+(index+1)+'" title="Edit '+contract+'">⚙</button>'+
  '<button data-pick="'+index+'">'+badge(leg.qty>0?'BTO':'STO')+size+contract+' at <span data-entry="'+index+'">'+positionPrice(leg.entry)+'</span>'+
  stateIcons(legStates(leg))+fills+'</button></div>';
}
function positionSummary(){
 if(!$('legsPanel').open)return;
 const rate=state.commissionPerContract;
 const all=state.legs.filter(l=>!l.excluded);
 $('commissionCurrency').textContent=state.info.currency||'USD';
 if(document.activeElement!==$('commissionRate'))$('commissionRate').value=String(rate);
 $('commissionTotal').textContent=money(all.reduce((sum,l)=>sum+optionFee(l,Math.abs(l.qty)+closedQuantity(l),rate),0));
 const summary=$('positionSummary'),list=state.legs.filter(l=>positionsClosed?closedQuantity(l):remainingQty(l));
 for(const el of $('legs').querySelectorAll('[data-entry]'))el.textContent=positionPrice(state.legs[Number(el.dataset.entry)].entry);
 if(!list.length){summary.textContent=positionsClosed?'No positions have been closed yet.':'No open positions.';return}
 const included=list.filter(l=>!l.excluded);
 const available=positionsClosed||included.every(l=>valid(l.entry)&&valid(state.quotes[l.conId]?.mid));
 const pnl=available?included.reduce((total,leg)=>total+(positionsClosed?realizedPnl(leg,rate):
  remainingQty(leg)*leg.multiplier*(state.quotes[leg.conId].mid-leg.entry)-optionFee(leg,remainingQty(leg),rate)),0):null;
 const basis=all.every(l=>valid(l.entry))?Math.abs(all.reduce((total,leg)=>total+leg.qty*leg.multiplier*leg.entry+optionFee(leg,leg.qty,rate),0)):null;
 const pct=valid(pnl)&&basis>0?' ('+fmt(pnl/basis*100,1)+'%)':'';
 const sign=pnl<0?'loss':'gain',color=pnl>0?'gain':pnl<0?'loss':'';
 summary.innerHTML='Total '+(positionsClosed?'realized ':'unrealized ')+(valid(pnl)?sign:'P&amp;L')+
  ': <span class="'+color+'"><b>'+esc(money(pnl))+'</b>'+pct+'</span>';
}
function legsPanel(){
 if(!$('legsPanel').open)return;
 const list=state.legs.map((leg,index)=>({leg,index}));
 const open=list.filter(({leg})=>remainingQty(leg)),closed=list.filter(({leg})=>closedQuantity(leg));
 $('openPositions').textContent='Open ('+open.length+')';$('closedPositions').textContent='Closed ('+closed.length+')';
 $('openPositions').setAttribute('aria-pressed',String(!positionsClosed));$('closedPositions').setAttribute('aria-pressed',String(positionsClosed));
 $('legs').innerHTML=(positionsClosed?closed:open).map(({leg,index})=>positionRow(leg,index)).join('');
 $('positionTools').hidden=positionsClosed;
 $('flipPositions').disabled=!open.length||open.some(({leg})=>closedQuantity(leg)>0);
 $('flipPositions').title=open.some(({leg})=>closedQuantity(leg)>0)?'Undo partial closes before flipping positions.':'Reverse open long and short positions';
 $('resetPrices').disabled=!open.some(({leg})=>!closedQuantity(leg)&&customEntry(leg));
 for(const button of $('positionTools').querySelectorAll('[data-position-pricing]'))button.setAttribute('aria-pressed',String(button.dataset.positionPricing===state.pricing));
 positionSummary();
}
function invalidateHistory(){
 state.points=[];state.screen=[];state.historySeq++;$('optGrid').innerHTML='';$('historyNote').textContent='Load history for the current positions.';drawHistory();
}
function commit(legs,name,active=0){
 state.comparison='current';
 state.legs=legs;state.name=name;state.active=Math.min(Math.max(0,active),Math.max(0,legs.length-1));invalidateHistory();
 const l=legs[state.active];if(l?.kind==='option')state.center=l.strike;
 structure();draft();message();
}
async function preset(id){
 if(!id)return;
 const item=presets.find(p=>p.id===id),next=laterExp(),seq=state.seq;
 const far=item.usesNextExpiry?await bookFor(state.info.symbol,state.root,next):null;
 const raw=makePreset(id,{symbol:state.info.symbol,root:state.root,expiry:state.expiry,nextExpiry:next,strikes:state.book.strikes,nextStrikes:far?.strikes,
 spot:state.spot??state.center,multiplier:state.info.roots[state.root].multiplier,style:state.info.style,secType:state.info.secType});
 const legs=await Promise.all(raw.map(l=>qualify(l)));if(seq===state.seq)commit(legs,item.name);
}
async function setExpiry(exp,root=state.root,change=true){
 const info=state.info,seq=++state.seq;state.ready=false;
 try{
  const b=await bookFor(info.symbol,root,exp);let legs=state.legs.slice();
  if(change){
   legs=await Promise.all(legs.map(l=>{
    if(l.kind!=='option'||l.root!==state.root||l.expiry!==state.expiry||l.closes?.length)return l;
    const s=nearest(b,l.strike,l.right);
    return qualify({...l,root,expiry:exp,strike:s.strike,entry:null,entryFeed:null},info);
   }));
  }
  if(seq!==state.seq)return;
  Object.assign(state,{root,expiry:exp,book:b,ready:true});
  if(change)commit(legs,state.name,state.active);else structure();
 }finally{if(seq===state.seq)state.ready=true}
}
function openOptions(){
 return state.legs.map((leg,index)=>({leg,index})).filter(({leg})=>leg.kind==='option'&&remainingQty(leg));
}
function opposingLeg(index){
 const options=openOptions();
 const first=options[0]?.leg;
 if(!first||options.some(({leg})=>leg.expiry!==first.expiry||leg.root!==first.root))return null;
 // At a shared body strike the iron butterfly's put belongs to the left wing.
 const sorted=options.sort((a,b)=>a.leg.strike-b.leg.strike || (a.leg.right===b.leg.right?0:a.leg.right==='P'?-1:1));
 const at=sorted.findIndex(v=>v.index===index),n=sorted.length;
 if(at<0||n!==3&&n!==4)return null;
 const [a,b,c,d]=sorted.map(v=>v.leg);
 const q=remainingQty(a);
 if(n===3){
  if(!(a.strike<b.strike&&b.strike<c.strike&&a.right===b.right&&b.right===c.right&&remainingQty(b)===-2*q&&remainingQty(c)===q))return null;
  if(at===1)return null;
 }else{
  const rights=a.right+b.right+c.right+d.right;
  if(!(a.strike<b.strike&&b.strike<=c.strike&&c.strike<d.strike&&
    (rights==='PPCC'||((rights==='PPPP'||rights==='CCCC')&&b.strike<c.strike))&&
    remainingQty(b)===-q&&remainingQty(c)===-q&&remainingQty(d)===q))return null;
 }
 return {index:sorted[n-1-at].index,order:sorted.map(v=>v.index)};
}
const shiftedStrike=(strike,points)=>Math.round((strike+points)*1e8)/1e8;
async function applyStrikeMoves(moves,active,preserveName,center){
 if(!state.ready||!moves.size)return;
 const original=state.legs,seq=state.seq;
 if([...moves.keys()].some(i=>original[i]?.closes?.length))
  throw Error('A leg with closing fills cannot move. Undo its closes or move the other legs individually.');
 // Qualify every proposed strike before changing any leg. Different expiries
 // and trading classes can have different ladders even for one underlying.
 const qualified=await Promise.all([...moves].map(async ([index,strike])=>{
  const leg=original[index];
  if(!leg||leg.kind!=='option')throw Error('The selected option is unavailable.');
  const next=await qualify({...leg,strike,entry:null,entryFeed:null});
  return [index,next];
 }));
 if(seq!==state.seq||original!==state.legs)return;
 const legs=original.slice();
 for(const [index,leg] of qualified)legs[index]=leg;
 commit(legs,preserveName?state.name:'Custom strategy',active);
 if(valid(center)){state.center=center;structure()}
 tick();
}
async function shiftOptions(points,center){
 if(!points)return;
 const moves=new Map(openOptions().map(({leg,index})=>[index,shiftedStrike(leg.strike,points)]));
 if(!moves.size)throw Error('There are no open option strikes to move.');
 return applyStrikeMoves(moves,state.active,true,center);
}
async function moveLeg(i,strike,shift=false){
 const old=state.legs[i];
 if(!old||old.kind!=='option'||old.strike===strike)return;
 const delta=shiftedStrike(strike,-old.strike);
 if(!shift)return applyStrikeMoves(new Map([[i,strike]]),i,false);
 const opposite=opposingLeg(i);
 if(!opposite)return shiftOptions(delta,strike);
 const moves=new Map([[i,strike],[opposite.index,shiftedStrike(state.legs[opposite.index].strike,-delta)]]);
 const proposed=opposite.order.map(index=>moves.get(index)??state.legs[index].strike);
 const inOrder=proposed.every((v,j)=>!j||v>proposed[j-1]||
  j===2&&proposed.length===4&&v===proposed[j-1]&&state.legs[opposite.order[j-1]].right!==state.legs[opposite.order[j]].right);
 if(!inOrder)throw Error('The paired strikes would cross another leg. Choose a smaller move.');
 const sameBody=opposite.order.length!==4||
  (state.legs[opposite.order[1]].strike===state.legs[opposite.order[2]].strike)===(proposed[1]===proposed[2]);
 await applyStrikeMoves(moves,i,sameBody);
}
let ticking=false;
async function tick(){
 if(ticking||!state.ready||!state.info||state.page==='saved')return;ticking=true;
 const seq=state.seq,mode=state.mode;
 try{
  const rows=windowRows();
  const atm=state.book&&valid(state.spot)?nearest(state.book,state.spot):null;
  const comparisonLegs=state.page==='build'&&state.view!=='history'&&hasSavedChanges()?
   state.savedLegs.filter(l=>!l.excluded&&remainingQty(l)&&(!l.expiry||expiryMs(l)>Date.now())):[];
  const held=[...state.legs,...comparisonLegs].filter(l=>remainingQty(l));
  const ids=[...new Set([state.info.conId,atm?.C,atm?.P,...held.map(l=>l.conId),currentPopupLeg()?.conId,...rows.flatMap(r=>[r.C,r.P])].filter(Number.isInteger))].slice(0,54);
  const res=await api('quotes',{ids,mode});if(seq!==state.seq||mode!==state.mode||state.page==='saved')return;
  if(Object.values(res.quotes).some(q=>q.error?.includes('has not been loaded')) && Date.now()-state.reloadedAt>10000){
   state.reloadedAt=Date.now();books.clear();
   await api('instrument?'+qs({symbol:state.info.symbol}));
   if(state.book)state.book=await bookFor(state.info.symbol,state.root,state.expiry);
   await Promise.all(held.filter(l=>l.kind==='option').map(l=>bookFor(state.info.symbol,l.root,l.expiry)));
   return;
  }
  state.quotes=res.quotes;recordCandle(candleContract());
  const u=state.quotes[state.info.conId]||{},optModel=state.legs.map(l=>state.quotes[l.conId]?.modelUnderlying).find(v=>v>0);
  const reference=u.mid??optModel??u.last??u.close;
  state.spot=valid(reference)?reference:null;
  state.spotLabel=u.mid!=null?'Underlying midpoint':optModel?'IBKR model underlying':u.last!=null?'Last reported trade':u.close!=null?'TWS prior close':'Waiting for reference';
  let changed=false;
  for(const leg of state.legs){
   const q=res.quotes[leg.conId],entry=entryQuote(leg,q);
   if(leg.entry==null&&valid(entry)){leg.entry=entry;leg.entryFeed=q.feed;changed=true}
  }
  if(changed)draft();if(!$('optTarget').value&&state.spot)$('optTarget').value=String(Math.round(state.spot));
  const exposure=state.legs.filter(l=>!l.excluded&&remainingQty(l));
  const modes=[...new Set(exposure.length?exposure.map(l=>res.quotes[l.conId]?.feed||'Waiting'):[u.feed||'Waiting'])];
  const stale=exposure.some(l=>{const q=res.quotes[l.conId];return q?.feed==='Live'&&q.at&&res.time-q.at>120000});
  const label=modes.length?modes.join(' / '):'TWS connected';
  $('connection').textContent=stale?label+' · quiet':label;$('connection').className='pill '+(label==='Live'&&!stale?'live':'waiting');
  const stamps=exposure.map(l=>res.quotes[l.conId]?.at).filter(valid);
  const issues=[...new Set(ids.map(i=>res.quotes[i]?.error).filter(Boolean))];
  $('footStatus').textContent=issues.length?issues[0]:('TWS · '+res.lines+' quote lines'+(stamps.length?' · Last bid/ask '+et(Math.max(...stamps))+' ET':''));
  render();
 }catch(e){
  if(seq===state.seq&&state.page!=='saved'){state.quotes={};state.spot=null;$('connection').textContent='Disconnected';$('connection').className='pill waiting';$('footStatus').textContent=e.message;render()}
 }finally{ticking=false}
}
let rangeSeries='',manualRange=null,manualCeiling=null;
let dateExpiry=null,pickedDate=null,dateFrame=null;
const easternDate=new Intl.DateTimeFormat('en-US',{
 weekday:'short',month:'short',day:'numeric',hour:'numeric',minute:'2-digit',hour12:true,timeZone:'America/New_York'
});
function durationText(ms){
 const hours=Math.max(0,ms)/3600000;
 if(hours<25)return Math.round(hours)+'h';
 const days=hours/24;
 return (days<3?Number(days.toFixed(1)):Math.round(days))+'d';
}
function dateText(ms,now){
 const d=Object.fromEntries(easternDate.formatToParts(ms).map(part=>[part.type,part.value]));
 const day=Number(d.day),suffix=day>=11&&day<=13?'th':({1:'st',2:'nd',3:'rd'}[day%10]??'th');
 return d.weekday+' '+d.month+' '+day+suffix+' '+d.hour+':'+d.minute+d.dayPeriod.toLowerCase()+' ('+durationText(ms-now)+')';
}
function readTarget(){
 const input=$('targetPrice');
 return input.value!==''&&input.validity.valid&&valid(input.valueAsNumber)?input.valueAsNumber:null;
}
// Projected legs are disposable. Keep calibration separate from the saved entry
// and the broker's IV/Greeks, and reuse the result while dragging the date.
const scenarioIvCache=new WeakMap();
function inferScenarioIv(leg,option,underlying,now,rate){
 const candidates=[];
 const paired=(a,b,tolerance)=>valid(a)&&valid(b)&&a>0&&b>0&&a<=now&&b<=now&&Math.abs(a-b)<=tolerance;
 if(option.feed==='Live'&&underlying.feed==='Live'&&paired(option.at,underlying.at,120000)
    &&now-Math.min(option.at,underlying.at)<=120000)
  candidates.push(['TWS midpoints',option.mid,underlying.mid,option.at]);
 if(paired(option.lastTradeTime,underlying.lastTradeTime,30000)
    &&now-Math.min(option.lastTradeTime,underlying.lastTradeTime)<=7*86400000)
  candidates.push(['TWS last trades',option.last,underlying.last,option.lastTradeTime]);
 if(option.closeSessionDate&&option.closeSessionDate===underlying.closeSessionDate
    &&paired(option.closeSessionEnd,underlying.closeSessionEnd,15*60000))
  candidates.push(['TWS prior closes',option.close,underlying.close,option.closeSessionEnd]);
 const signature=JSON.stringify([leg.strike,leg.right,expiryMs(leg),leg.style,leg.secType,leg.dividendYield,rate,candidates]);
 const cached=scenarioIvCache.get(option);
 if(cached?.signature===signature)return cached.value;
 let value=null;
 for(const [source,premium,spot,asOf] of candidates){
  if(!(premium>0&&spot>0))continue;
  const iv=estimateImpliedVolatility({leg,spot,premium,asOf,rate});
  if(valid(iv)){value={iv,source,asOf};break}
 }
 scenarioIvCache.set(option,{signature,value});
 return value;
}
function scenarioLegs(source,now,rate,factor){
 const legs=openLegs(source),underlying=state.quotes[state.info.conId]||{};
 for(const leg of legs){
  if(leg.kind!=='option')continue;
  const option=state.quotes[leg.conId];
  let base=option?.iv;
  if((!valid(base)||base<0)&&option){
   const estimate=inferScenarioIv(leg,option,underlying,now,rate);
   if(estimate){base=estimate.iv;leg.ivEstimate=estimate}
  }
  if(valid(base)&&base>=0){
   leg.scenarioBaseIv=base;leg.iv=base*factor;
   if(!leg.ivEstimate)leg.quotedIv=base;
  }
 }
 return legs;
}
function estimatedIvNote(legs){
 const groups=new Map();
 for(const leg of legs){
  const estimate=leg.ivEstimate;
  if(!estimate)continue;
  const group=estimate.source+' ('+dateTextForIv.format(estimate.asOf)+')';
  if(!groups.has(group))groups.set(group,[]);
  groups.get(group).push(fmt(leg.strike)+leg.right);
 }
 return [...groups].map(([source,contracts])=>'IV estimated from '+source+' for '+contracts.join(', ')+'.').join(' ');
}
const dateTextForIv=new Intl.DateTimeFormat('en-US',{timeZone:'America/New_York',month:'short',day:'numeric',year:'numeric'});
function params(){
 const source=displayLegs(),now=Date.now(),rate=Number($('rate').value)/100,factor=Number($('iv').value);
 const legs=scenarioLegs(source,now,rate,factor),options=legs.filter(l=>l.kind==='option');
 const times=options.map(expiryMs).filter(valid),first=times.length?Math.min(...times):now;
 const fraction=Number($('horizon').value)/100;
 const pinned=pickedDate?.expiry===first&&fraction>0&&fraction<1;
 const horizonMs=Math.min(first,pinned?Math.max(now,pickedDate.time):now+Math.max(0,first-now)*fraction);
 const spot=state.spot??state.center;
 let ivSum=0,weight=0;
 for(const leg of options){
  if(!valid(leg.scenarioBaseIv))continue;
  const units=Math.abs(leg.qty)*leg.multiplier;
  weight+=units;ivSum+=units*leg.scenarioBaseIv;
 }
 const baseIv=weight?ivSum/weight:null;
 const key=[state.info.conId,state.root,state.expiry].join('|');
 if(key!==rangeSeries){rangeSeries=key;manualRange=null;manualCeiling=null}
 const atm=state.book&&valid(spot)?nearest(state.book,spot):null;
 const vols=[state.quotes[atm?.C]?.iv,state.quotes[atm?.P]?.iv].filter(valid);
 const atmIv=vols.length?vols.reduce((a,b)=>a+b,0)/vols.length:baseIv;
 const move=valid(atmIv)&&times.length?100*atmIv*Math.sqrt(Math.max(0,first-now)/(365*86400000)):5;
 const strikes=options.map(l=>Math.abs(l.strike-spot)*100/(Math.abs(spot)||1));
 const suggested=Math.max(1,move,...strikes);
 const rangePct=manualRange??Math.round(suggested*100)/100,rangeMax=manualCeiling??Math.max(7,Math.ceil(suggested*700)/100);
 const target=readTarget(),priceBounds=scenarioPriceBounds(legs,spot,rangePct,horizonMs,target);
 return {source,legs,now,first,horizonMs,ivShift:0,rate,spot,baseIv,factor,rangePct,rangeMax,priceBounds,target,ivNote:estimatedIvNote(options)};
}
function syncDateControl(p){
 const input=$('horizon'),atExpiry=p.horizonMs===p.first;
 dateExpiry=p.first;
 const progress=atExpiry?100:100*(p.horizonMs-p.now)/(p.first-p.now);
 input.value=String(progress);input.disabled=p.first<=p.now;
 const label=!atExpiry&&p.horizonMs===p.now?'Now':dateText(p.horizonMs,p.now);
 const remaining=atExpiry?'At expiration':durationText(p.first-p.horizonMs)+' remaining';
 $('dateLabel').textContent=label;$('plotDateState').textContent='('+remaining+')';
 $('dateTooltip').textContent=label;
 input.setAttribute('aria-valuetext',label+' · '+remaining+' · Eastern time');
 input.style.setProperty('--fill',progress+'%');
 // Native range thumbs stop half a thumb-width inside both ends of the track.
 $('dateTrack').style.setProperty('--date-x','calc('+progress+'cqw + '+(5.5-.11*progress)+'px)');
 const comparison=p.legs.every(l=>l.kind!=='option'||expiryMs(l)===p.first);
 const greek=greekModes[state.unit],table=state.view==='table';
 document.querySelector('.plot-key').hidden=state.view==='history'||(table&&!greek);
 $('greekSelector').hidden=state.view==='history';
 document.querySelector('#modelSettings summary').textContent=greek?'More · '+greek.label:'More';
 $('chartTitle').textContent=state.view==='history'?'Strategy history':(greek?'Modeled '+greek.label:'Payoff')+(table?' table':' graph');
 $('plotLegend').textContent=greek?'Modeled '+greek.label+' · '+(state.info.currency||'USD')+' '+greek.unit:
  atExpiry?(comparison?'At expiration':'At first expiration'):
  comparison?'Scenario date · dashed line at intermediate date · dotted line at first expiry':'Scenario date';
}
function syncScenarioSliders(p){
 const zoom=$('zoom'),iv=$('iv');
 zoom.max=String(p.rangeMax);zoom.value=String(p.rangePct);
 const rangeText='±'+fmt(Number(p.rangePct.toPrecision(2)))+'%';
 $('zoomLabel').textContent=rangeText;zoom.setAttribute('aria-valuetext',rangeText);
 const actualIv=valid(p.baseIv)?p.baseIv*p.factor*100:null;
 const ivText=valid(actualIv)?fmt(actualIv,1)+'%':'—';
 $('ivLabel').textContent=ivText+(p.ivNote?' · estimated':'');
 $('ivLabel').title=p.ivNote||'Quantity-weighted implied volatility. Each option uses its own IV times the selected multiplier.';
 iv.setAttribute('aria-valuetext',fmt(p.factor,3)+' times · implied volatility '+ivText+(p.ivNote?' · estimated':''));
 const pp=valid(p.baseIv)?p.baseIv*(p.factor-1)*100:null;
 $('ivDelta').textContent=valid(pp)?(pp>0?'+':'')+fmt(pp,1)+'%':fmt(p.factor,3)+'×';
 $('resetIv').hidden=p.factor===1;
 for(const input of [zoom,iv]){
  const fill=(Number(input.value)-Number(input.min))/(Number(input.max)-Number(input.min))*100+'%';
  input.style.setProperty('--fill',fill);
  if(input===iv)input.parentElement.style.setProperty('--thumb',fill);
 }
}
function recordMark(pnl){
 const key=JSON.stringify([state.commissionPerContract,state.legs.map(l=>[l.conId,l.qty,l.multiplier,l.entry,l.excluded,l.closes])]);
 if(key!==observed.key)observed={key,points:[]};
 if(!valid(pnl)||!state.legs.length)return;
 const included=state.legs.filter(l=>!l.excluded);
 if(!included.length)return;
 const quotes=included.filter(l=>remainingQty(l)).map(l=>state.quotes[l.conId]);
 const now=Date.now();
 if(quotes.some(q=>!q||q.feed!=='Live'||!valid(q.mid)||!(q.at>0)||now-q.at>120000))return;
 const last=observed.points.at(-1),uncertain=included.some(l=>l.closes?.some(f=>f.confirmedClosedBy!=null));
 if(!quotes.length&&uncertain&&last?.[1]===pnl)return;
 const time=Math.max(...quotes.map(q=>q.at),...included.flatMap(l=>(l.closes??[]).map(f=>f.at??f.confirmedClosedBy)),!quotes.length&&uncertain?now:0);
 if(last&&time<=last[0])return;
 if(last&&time-last[0]<1000)observed.points[observed.points.length-1]=[time,pnl];
 else observed.points.push([time,pnl]);
 if(observed.points.length>20000)observed.points.shift();
}
let candleSeries={id:null,rows:[],lastAt:0};
function candleContract(){
 const included=state.legs.filter(l=>!l.excluded&&remainingQty(l));
 return included.length&&included.every(l=>l.kind==='option'&&l.conId===included[0].conId)?included[0]:null;
}
function recordCandle(contract){
 const id=contract?.conId??null;
 if(candleSeries.id!==id)candleSeries={id,rows:[],lastAt:0};
 const q=state.quotes[id];
 if(!q||q.feed!=='Live'||!valid(q.mid)||!valid(q.at)||q.at<=candleSeries.lastAt||Date.now()-q.at>120000)return;
 const time=Math.floor(q.at/60000)*60000,rows=candleSeries.rows,last=rows.at(-1);
 if(last&&last[0]===time){
  last[1]=q.mid;last[3]=Math.max(last[3],q.mid);last[4]=Math.min(last[4],q.mid);
 }else{
  rows.push([time,q.mid,q.mid,q.mid,q.mid]);
  if(rows.length>1440)rows.shift();
 }
 candleSeries.lastAt=q.at;
}
let historyFallback=null;
function showHistoryFallback(){
 if(!historyFallback||historyFallback.token!==state.historySeq||historyFallback.series!==state.seq)return;
 if($('historyType').value==='bars')showLiveCandles();
 else showObservations();
 $('historyNote').textContent=historyFallback.reason+' '+(state.points.length?'Showing this tab’s observations. ':'')+$('historyNote').textContent;
}
function showLiveCandles(){
 const contract=candleContract();state.points=contract?.conId===candleSeries.id?candleSeries.rows:[];
 $('historyNote').textContent=contract?state.points.length+' one-minute premium candle'+(state.points.length===1?'':'s')+' · Observed live bid/ask midpoints for '+contract.root+' '+fmt(contract.strike)+contract.right+' · Per quoted unit.':'Choose a single included option contract to view premium candles.';
 drawHistory();
}
function showObservations(){
 state.points=observed.points;
 $('historyNote').textContent=state.legs.every(l=>l.excluded)?'All legs excluded.':state.legs.filter(l=>!l.excluded).every(l=>!remainingQty(l))?'Realized P&L from recorded closing fills.':state.points.length+' live midpoint marks observed for included open positions in this tab.';
 drawHistory();
}
const greekDetails=[
 ['delta','Δ','Position P&L change for a one-point underlying move.'],
 ['theta','Θ','Position time decay per day.'],
 ['gamma','Γ','Position delta change for a one-point underlying move.'],
 ['vega','ν','Position sensitivity to a one-percentage-point change in implied volatility.'],
 ['rho','ρ','Modeled change in value per one-percentage-point change in the annual interest rate, using unshifted implied volatility.']
];
function statIcon(name,style=''){
 return '<svg class="stat-icon '+style+'" aria-hidden="true" focusable="false"><use href="#stat-'+name+'"/></svg>';
}
function statCell(label,icon,value,title=''){
 return {label,icon,value,title};
}
function paintStats(panel,items){
 while(panel.children.length>items.length)panel.lastElementChild.remove();
 items.forEach(({label,icon,value,title},i)=>{
  let node=panel.children[i];
  if(!node){node=document.createElement('div');node.className='stat-item';panel.append(node)}
  if(node.dataset.label!==label){
   node.innerHTML='<span class="stat-label">'+esc(label)+':</span><span class="stat-value">'+icon+'<span></span></span>';
   node.dataset.label=label;delete node.dataset.value;
  }
  if(node.title!==title)node.title=title;
  if(node.dataset.value!==value){node.lastElementChild.lastElementChild.innerHTML=value;node.dataset.value=value}
 });
}
const greekFormat=new Intl.NumberFormat('en-US',{maximumSignificantDigits:3});
function formatBreakEven(a,p){
 const roots=a.breakEvens||[],ranges=a.breakEvenRanges||[];
 const price=n=>n===Infinity?'∞':n===-Infinity?'−∞':state.info.secType==='STK'?money(n):fmt(n);
 if(roots.length!==1||ranges.length)return esc([...roots.map(price),...ranges.map(([lo,hi])=>price(lo)+'–'+price(hi))].join(' / ')||'—');
 const n=roots[0],bump=Math.max(.00001,Math.abs(n)*.00001);
 const up=payoff(p.legs,n+bump,p.first),down=payoff(p.legs,n-bump,p.first);
 const direction=up>0&&down<0?'Above ':up<0&&down>0?'Below ':'';
 const percent=state.spot>0?(n/state.spot-1)*100:null;
 const change=valid(percent)?' ('+(percent>0?'+':'')+new Intl.NumberFormat('en-US',{maximumSignificantDigits:2}).format(percent)+'%)':'';
 return '<span class="stat-qualifier">'+direction+'</span>'+esc(price(n))+'<span class="stat-qualifier">'+esc(change)+'</span>';
}
function renderStats(a,p){
 const amount=v=>v===Infinity?'Infinite':money(v);
 const included=p.source.filter(l=>!l.excluded),hasCloses=included.some(l=>l.closes?.length);
 const realized=included.reduce((sum,l)=>sum+realizedPnl(l,feeRate(p.source)),0);
 const openPnl=valid(a.markPnl)?a.markPnl-realized:null;
 const pnlCell=(type,value)=>statCell(type+' '+(!valid(value)?'P&L':value<0?'loss':'gain'),statIcon('bag',value<0?'stat-loss':'stat-profit'),esc(money(value)));
 const items=[
  statCell(a.entryDebit<0?'Net credit':'Net debit',statIcon('coins','stat-coins'),esc(money(valid(a.entryDebit)?Math.abs(a.entryDebit):null))),
  statCell('Max loss',statIcon('arrow','stat-down'),esc(amount(a.maxLoss))),
  statCell('Max profit',statIcon('arrow','stat-up'),esc(amount(a.maxProfit))),
  statCell('Chance of profit',statIcon('dice'),a.profitProbability==null||state.spot==null?'—':fmt(a.profitProbability*100,1)+'%',a.probabilityNote||'Requires a quoted implied volatility and a supported expiry payoff.'),
  statCell('Breakeven',statIcon('arrow','stat-flat'),formatBreakEven(a,p))
 ];
 if(hasCloses)items.push(pnlCell('Realized',realized));
 if((hasCloses||state.savedId||included.some(l=>l.entryFeed==='Manual'))&&included.some(l=>remainingQty(l)))items.push(pnlCell('Unrealized',openPnl));
 paintStats($('metrics'),items);
 paintStats($('greeks'),greekDetails.map(([key,glyph,help])=>statCell(key,'<span aria-hidden="true" class="stat-glyph greek-'+key+'">'+glyph+'</span>',
  valid(a.greeks[key])?greekFormat.format(a.greeks[key]):'—',help)));
 $('markSummary').textContent=(hasCloses&&!included.some(l=>remainingQty(l))?'Realized P&L ':'Mark P&L ')+money(a.markPnl);
}
function changeStatPage(){
 const greek=$('statTrack').classList.toggle('show-greeks');
 for(const [id,hidden] of [['metrics',greek],['greeks',!greek]]){
  $(id).inert=hidden;$(id).setAttribute('aria-hidden',String(hidden));
 }
}
$('statPrev').onclick=changeStatPage;$('statNext').onclick=changeStatPage;
$('metricStrip').onkeydown=e=>{if(e.key==='ArrowLeft'||e.key==='ArrowRight'){e.preventDefault();changeStatPage()}};
let statPointer;
const statViewport=$('statTrack').parentElement;
statViewport.onpointerdown=e=>{if(e.isPrimary&&e.button===0){statPointer=[e.clientX,e.clientY];statViewport.setPointerCapture(e.pointerId)}};
statViewport.onpointercancel=()=>{statPointer=null};
statViewport.onpointerup=e=>{
 if(statPointer&&Math.abs(e.clientX-statPointer[0])>35&&Math.abs(e.clientY-statPointer[1])<35)changeStatPage();
 statPointer=null;
};
function render(){
 if(!state.info)return;
 const u=state.quotes[state.info.conId]??{},showCurrency=state.info.secType==='STK';
 $('spot').textContent=showCurrency?money(state.spot):fmt(state.spot);
 $('spotSource').textContent=state.spotLabel||'Underlying reference';
 const change=$('spotChange'),diff=valid(state.spot)&&valid(u.close)&&u.close!==0&&state.spotLabel!=='TWS prior close'?state.spot-u.close:null;
 change.hidden=!valid(diff);
 if(valid(diff)){
  const sign=diff>0?'+':'';
  change.className=diff<0?'negative':diff>0?'positive':'';
  change.children[0].textContent=sign+(diff/Math.abs(u.close)*100).toFixed(2)+'%';
  change.children[1].textContent=sign+(showCurrency?money(diff):fmt(diff));
  change.title='Change from the TWS prior close of '+fmt(u.close);
 }
 if(!state.book){const u=state.quotes[state.info.conId]||{};$('underlyingQuote').textContent='Bid '+fmt(u.bid)+'  ·  Ask '+fmt(u.ask)+'  ·  Last '+fmt(u.last)+'  ·  TWS prior close '+fmt(u.close)+'  ·  '+(u.feed||'Waiting');return}
 updateStrikeVolumes();
 const railSpot=$('railSpot'),rows=state.railRows;
 if(railSpot&&rows?.length){
  const price=state.spot;
  railSpot.hidden=!valid(price)||price<rows[0].strike||price>rows.at(-1).strike;
  if(!railSpot.hidden){
   const hi=rows.findIndex(row=>row.strike>=price),lo=Math.max(0,hi-1);
   const fraction=hi===lo?0:(price-rows[lo].strike)/(rows[hi].strike-rows[lo].strike);
   railSpot.style.left=((lo+fraction+.5)/rows.length*100)+'%';
   railSpot.textContent=state.info.ticker;
   railSpot.title=state.spotLabel+' '+fmt(price);
  }
 }
 syncComparison();
 const p=params(),a=analyze(p.legs,p.spot,p.horizonMs,p.ivShift,p.rate);
 recordMark(p.source===state.legs?a.markPnl:positionMark(openLegs()).markPnl);
 if(state.view==='history'&&$('historyType').value==='session')showObservations();
 if(state.view==='history'&&$('historyType').value==='liveCandles')showLiveCandles();
 if(state.view==='history')showHistoryFallback();
 const hasOptions=p.legs.some(l=>l.kind==='option');
 document.querySelector('#scenarios .date').hidden=state.view!=='graph'||!hasOptions;
 $('ivControl').hidden=!hasOptions;
 renderStats(a,p);
 syncDateControl(p);syncScenarioSliders(p);
 if($('legBubble').matches(':popover-open'))bubbleQuote();
 renderScenarioNote(p,a);
 positionSummary();
 if(state.page==='build'){
  if(state.view==='graph')renderGraph(p);
  if(state.view==='table')renderTable(p,a);
  if($('chainPanel').open)renderChain();
 }
}
function renderScenarioNote(p,a){
 const greek=greekModes[state.unit];
 if(greek&&state.view!=='history'){
  const included=p.legs.filter(l=>l.kind==='option');
  const details=[];
  if(p.target!==null&&state.view==='graph'){
   const model=scenarioGreekEvaluator(p.legs,p.horizonMs,p.ivShift,p.rate,state.unit);
   details.push('Target '+fmt(p.target)+' · '+greek.label+' '+formatGreek(model?.(p.target))+'.');
  }
  if(!p.legs.length)details.push(p.source.length?excludedText(p.source):'Add a position to model its Greeks.');
  else if(!included.length)details.push('Shares contribute their signed quantity to delta. Closed positions have zero exposure.');
  else {
   details.push('Position sensitivity uses each included option’s implied volatility and the selected annual rate.');
   if(p.ivNote)details.push(p.ivNote);
   if(included.some(l=>!valid(l.iv)||l.iv<=0||l.strike<=0))details.push('Each open option needs a positive strike and implied volatility.');
   if(state.view==='table'||p.horizonMs>=p.first)details.push('Option Greeks are unavailable at expiration.');
   if(included.some(l=>l.style==='US'))details.push('American exercise uses a binomial approximation.');
   if(included.some(l=>l.style!=='US'&&l.style!=='EU'))details.push('Unverified exercise styles use the European approximation.');
   if(included.some(l=>l.secType==='FOP'))details.push('Futures sensitivities hold the futures price fixed when rates change.');
   if(included.some(l=>l.secType!=='FOP'&&!valid(l.dividendYield)))details.push('Dividend yield defaults to zero.');
  }
  $('scenarioNote').textContent=details.join(' ');
  return;
 }
 let target='';if($('targetPrice').value!==''){const at=Number($('targetPrice').value);if(Number.isFinite(at)&&at>=0)target='Target '+fmt(at)+' · Scenario P&L '+money(payoff(p.legs,at,p.horizonMs,p.ivShift,p.rate))+'. ';}
 const included=p.source.filter(l=>!l.excluded),closed=included.filter(l=>l.closes?.length);
 const note=closed.length?'Realized P&L '+money(closed.reduce((n,l)=>n+realizedPnl(l,feeRate(p.source)),0))+'. ':'';
 const settled=closed.length&&included.every(l=>remainingQty(l)===0);
 $('scenarioNote').textContent=!included.length&&p.source.length?excludedText(p.source):settled?note+'All included positions are closed.':[target+note+p.ivNote,a.note||'Entries are fixed. P&L uses the current two-sided midpoint.'].filter(Boolean).join(' ');
}
function renderGraph(p=params()){
 if(!$('riskCanvas').clientWidth)return;
 const previousLegs=!compareControls.hidden&&p.source===state.legs?scenarioLegs(state.savedLegs,p.now,p.rate,p.factor):[];
 const graph=drawRisk($('riskCanvas'),p.legs,{...p,previousLegs,spot:state.spot,referenceCenter:state.center,emptyMessage:p.source.length?excludedText(p.source):null,currency:state.info.currency||'USD',unit:state.unit,hoverX:state.hover,hoverY:state.hoverY,onHover:h=>{
  state.inspectedPrice=h?.underlying??null;$('hover').textContent=h?h.heading+' · '+h.value:'';
 }});
 if(graph?.expirationOnly)$('plotLegend').textContent='Expiration payoff only · IV unavailable for the selected date';
}
const dayMs=86400000;
const tableMonth=new Intl.DateTimeFormat('en-US',{month:'short',year:'numeric',timeZone:'America/New_York'});
const tableDay=new Intl.DateTimeFormat('en-US',{day:'numeric',timeZone:'America/New_York'});
const tableTime=new Intl.DateTimeFormat('en-US',{hour:'numeric',minute:'2-digit',timeZone:'America/New_York'});
const tableNumber=new Intl.NumberFormat('en-US',{maximumFractionDigits:0});
const tableCompact=new Intl.NumberFormat('en-US',{notation:'compact',minimumFractionDigits:1,maximumFractionDigits:1});
function heatColor(value,basis){
 if(!valid(value)||!basis)return 'transparent';
 const ratio=Math.abs(value)/basis;
 if(ratio<.99){
  const rgb=value>=0?'86,138,61':'116,38,34';
  return 'rgba('+rgb+','+ratio.toFixed(4)+')';
 }
 const boost=Math.min(1,Math.max(0,Math.log(ratio)/Math.log(2.4)));
 const from=value>=0?[100,162,70]:[136,46,40],to=value>=0?[110,175,76]:[164,54,44];
 return 'rgb('+from.map((c,i)=>Math.round(c+(to[i]-c)*boost)).join(',')+')';
}
const eventCalendar=new Map();
const calendarDay=new Intl.DateTimeFormat('en-CA',{year:'numeric',month:'2-digit',day:'2-digit',timeZone:'America/New_York'});
function eventDay(value){
 const match=/^(\d{4})[-/]?(\d{2})[-/]?(\d{2})(?:[ T](.+))?$/.exec(String(value).trim());
 if(!match)return null;
 const day=match.slice(1,4).join('-'),midnight=Date.parse(day+'T00:00:00Z');
 if(!valid(midnight)||new Date(midnight).toISOString().slice(0,10)!==day)return null;
 const clock=match[4];
 if(!clock||!/(?:Z|[+-]\d{2}:?\d{2})$/i.test(clock))return day;
 const stamp=Date.parse(day+'T'+clock);
 return valid(stamp)?calendarDay.format(stamp):null;
}
function chartEvents(cols){
 if(state.info.secType!=='STK'||!$('showEvents').checked)return new Map();
 const id=state.info.conId;
 let report=eventCalendar.get(id);
 if(!report||Date.now()-report.requested>300000){
  report={requested:Date.now(),rows:[],message:'Requesting the IBKR event calendar…'};
  eventCalendar.set(id,report);
  api('events?'+qs({id})).then(result=>{
   report.rows=result.rows||[];report.message=result.message;
  }).catch(error=>{report.message=error.message}).finally(()=>{
   if(state.info?.conId===id&&state.view==='table'&&state.page==='build')render();
  });
 }
 $('eventCoverage').textContent='IBKR calendar · '+report.message;
 const marks=new Map();
 if(!report.rows.length)return marks;
 const dates=cols.map(t=>Date.parse(calendarDay.format(t)+'T00:00:00Z'));
 for(const row of report.rows){
  const day=eventDay(row.date);
  const kind=/earnings/i.test(row.title)?'E':/ex[-_ ]?div/i.test(row.title)?'D':null;
  if(!day||!kind)continue;
  const t=Date.parse(day+'T00:00:00Z');
  if(!valid(t)||t<dates[0]||t>dates.at(-1))continue;
  const index=dates.reduce((best,d,i)=>Math.abs(d-t)<Math.abs(dates[best]-t)?i:best,0);
  if(!marks.has(index))marks.set(index,[]);
  marks.get(index).push({kind,label:day+' · '+row.title});
 }
 return marks;
}
$('showEvents').onchange=()=>{if(!$('showEvents').checked)$('eventCoverage').textContent='';render()};
function tableHeaders(cols,intraday){
 const groups=[],days=[],events=chartEvents(cols);
 for(const [column,instant] of cols.entries()){
  const [month,year]=tableMonth.format(instant).split(' '),key=intraday?etDate(instant):month+year;
  if(groups.at(-1)?.key===key)groups.at(-1).count++;
  else {
   const prior=groups.at(-1),text=intraday?key:month+(prior&&prior.year!==year?" ’"+year.slice(-2):'');
   groups.push({key,year,text,count:1});
  }
  const marks=events.get(column)||[],details=marks.map(e=>e.label).join(' · ');
  const badge=marks.length?'<span class="heat-event" aria-label="'+esc(details)+'">'+[...new Set(marks.map(e=>e.kind))].join('/')+'</span>':'';
  days.push('<th scope="col" title="'+esc(etDate(instant)+' '+et(instant)+' ET'+(details?' · '+details:''))+'">'+esc(intraday?tableTime.format(instant):tableDay.format(instant))+badge+'</th>');
 }
 return '<thead><tr><th class="heat-corner" rowspan="2"><span class="sr-only">Underlying price and change</span></th>'+
  groups.map(g=>'<th scope="colgroup" colspan="'+g.count+'">'+esc(g.text)+'</th>').join('')+'</tr><tr>'+days.join('')+'</tr></thead>';
}
function renderTable(p,risk){
 if(!p.legs.length){$('heatTable').textContent=p.source.length?excludedText(p.source):'Add a position to view the payoff table.';return}
 const levels=21,now=Math.min(Date.now(),p.first),duration=p.first-now,intraday=duration<9*dayMs&&duration>0;
 const width=$('heatTable').clientWidth;
 const maxDates=Math.max(4,Math.min(20,Math.floor((width-80)/(intraday?65:52))));
 const dates=duration>0?Math.min(maxDates,Math.max(2,Math.ceil(duration/(intraday?3600000:dayMs))+1)):1;
 const {min,max}=p.priceBounds;
 const rowStep=(max-min)/(levels-1);
 const targetRow=p.target!==null&&p.target>=min&&p.target<=max?Math.round((max-p.target)/rowStep):-1;
 const cols=Array.from({length:dates},(_,i)=>now+duration*i/Math.max(1,dates-1));
 const greek=greekModes[state.unit];
 const models=cols.map(t=>greek?scenarioGreekEvaluator(p.legs,t,p.ivShift,p.rate,state.unit):scenarioEvaluator(p.legs,t,p.ivShift,p.rate));
 const rows=Array.from({length:levels},(_,i)=>{
  const at=i===targetRow?p.target:max-rowStep*i;
  const price=state.info.secType==='STK'?money(at):fmt(at);
  const change=state.spot>0?fmt((at/state.spot-1)*100,1)+'%':'';
  return {price,change,values:models.map(model=>model?model(at):null)};
 });
 const peak=Math.max(0,...rows.flatMap(r=>r.values.filter(valid).map(Math.abs)));
 const basis=greek?peak:Math.abs(risk.percentBasis)||((valid(risk.maxLoss)&&risk.maxLoss>0)?risk.maxLoss:Math.max(1,peak));
 function cell(raw){
  let value=raw,percent=false;
  if(valid(raw)&&state.unit==='value')value=valid(risk.entryDebit)?raw+risk.entryDebit:null;
  if(valid(raw)&&(state.unit==='percent'||state.unit==='riskPercent')){
   percent=true;const den=state.unit==='riskPercent'?risk.maxLoss:Math.abs(risk.percentBasis);
   value=valid(den)&&den>0?100*raw/den:null;
  }
  const text=!valid(value)?'—':greek?formatGreek(value):percent?fmt(value,1)+'%':Math.abs(value)>=10000?tableCompact.format(value).toLowerCase():tableNumber.format(value);
  const detail=!valid(value)?'Unavailable':greek?greek.label+' '+text+' '+(state.info.currency||'USD')+' '+greek.unit:percent?fmt(value,2)+'%':money(value);
  return '<td title="'+esc(detail)+'" style="background-color:'+heatColor(valid(value)?raw:null,basis)+'">'+esc(text)+'</td>';
 }
 const headers=tableHeaders(cols,intraday);
 const priceWidth=Math.max(...rows.map(row=>row.price.length*9+row.change.length*6+14));
 $('heatTable').style.setProperty('--heat-price-width',priceWidth+'px');
 $('heatTable').innerHTML='<table aria-label="Scenario '+(greek?greek.label:'payoff')+' by underlying price and date"><colgroup><col class="heat-price-col"><col span="'+cols.length+'"></colgroup>'+headers+'<tbody>'+
 rows.map((r,i)=>'<tr'+(i===targetRow?' class="heat-target" title="Target price"':'')+'><th scope="row"><span class="heat-price">'+esc(r.price)+' <small>'+esc(r.change)+'</small></span></th>'+r.values.map(cell).join('')+'</tr>').join('')+'</tbody></table>';
 applyHeatHighlight();
}
function applyHeatHighlight(){
 const table=$('heatTable').querySelector('table');if(!table)return;
 table.querySelectorAll('.heat-selected,.heat-guide').forEach(el=>el.classList.remove('heat-selected','heat-guide'));
 if(!state.heatHover)return;
 const [row,col]=state.heatHover,r=table.tBodies[0].rows[row];
 r?.cells[col]?.classList.add('heat-selected');r?.cells[0]?.classList.add('heat-guide');
 table.tHead.rows[1].cells[col-1]?.classList.add('heat-guide');
}
$('heatTable').onpointermove=e=>{
 const cell=e.target.closest('tbody td');
 state.heatHover=cell?[cell.parentElement.sectionRowIndex,cell.cellIndex]:null;
 applyHeatHighlight();
};
$('heatTable').onpointerleave=()=>{state.heatHover=null;applyHeatHighlight()};
function chainRows(){
 return windowRows().flatMap(s=>['C','P'].filter(r=>s[r]).map(r=>{
  const q=state.quotes[s[r]]||{};return {...q,kind:'option',symbol:state.info.symbol,root:state.root,expiry:state.expiry,strike:s.strike,right:r,conId:s[r],currency:state.info.currency,secType:state.info.secType==='FUT'?'FOP':'OPT',multiplier:state.info.roots[state.root].multiplier,style:state.info.style,settlement:state.book.settlement,expiresAt:state.book.expiresAt,
   stale:q.feed==='Live'&&(!q.at||Date.now()-q.at>120000)};
 }));
}
function grid(headers,rows){return '<table><thead><tr>'+headers.map(h=>'<th>'+esc(h)+'</th>').join('')+'</tr></thead><tbody>'+rows.map(row=>'<tr>'+row.map(v=>'<td>'+v+'</td>').join('')+'</tr>').join('')+'</tbody></table>'}
function renderChain(){
 $('chainGrid').innerHTML=grid(['Contract','Feed','Bid','Ask','IV','Delta','Volume','OI','Add'],chainRows().map(q=>[esc(fmt(q.strike)+q.right),esc(q.feed||'Waiting'),fmt(q.bid),fmt(q.ask),q.iv!=null?fmt(q.iv*100,1)+'%':'—',fmt(q.delta,3),fmt(q.volume,0),fmt(q.oi,0),
 '<button data-chain="'+q.conId+'" data-side="1">Long</button> <button data-chain="'+q.conId+'" data-side="-1">Short</button>']));
}
function setView(view){
 state.view=view;
 $('calendarOptions').hidden=state.info?.secType!=='STK'||view!=='table';
 document.querySelector('[data-view=history]').hidden=view!=='history';
 syncComparison();
 document.querySelectorAll('[data-view]').forEach(b=>b.classList.toggle('active',b.dataset.view===view));
 $('graph').hidden=view!=='graph';$('heatTable').hidden=view!=='table';$('historyPanel').hidden=view!=='history';$('scenarios').hidden=view==='history';
 $('chartTitle').textContent={graph:'Payoff graph',table:'Payoff table',history:'Strategy history'}[view];
 document.querySelector('.plot-key').hidden=view!=='graph';
 document.querySelector('#scenarios .date').hidden=view!=='graph';
 if(view==='history')loadHistory();else render();
}
function drawHistory(){
 const c=$('histCanvas'),w=c.clientWidth,h=c.clientHeight;if(!w||!h)return;const dpr=devicePixelRatio||1;c.width=w*dpr;c.height=h*dpr;
 const g=c.getContext('2d');g.setTransform(dpr,0,0,dpr,0,0);g.clearRect(0,0,w,h);
 const rows=state.points;if(!rows.length){g.fillStyle='#b9bdd0';g.font='14px Inter, sans-serif';g.fillText('No observations in this window',18,36);c.setAttribute('aria-label','No historical observations');return}
 const candles=['liveCandles','bars'].includes($('historyType').value);
 const x0=rows[0][0],x1=Math.max(rows.at(-1)[0],x0+1);
 const min=candles?Math.min(...rows.map(r=>r[4])):Math.min(0,...rows.map(r=>r[1]));
 const max=candles?Math.max(...rows.map(r=>r[3])):Math.max(0,...rows.map(r=>r[1]));
 const padding=Math.max(candles ? .01 : 1,(max-min)*.08);
 const x=t=>rows.length===1?(65+w-17)/2:65+(t-x0)/(x1-x0)*(w-82),y=v=>14+(max+padding-v)/(max-min+padding*2)*(h-46);
 g.font='12px Inter, sans-serif';for(let i=0;i<5;i++){const v=min+(max-min)*i/4;g.strokeStyle='#34394f';g.beginPath();g.moveTo(62,y(v));g.lineTo(w-16,y(v));g.stroke();g.fillStyle='#c2c6d8';g.fillText(money(v),2,y(v)-1)}
 if(candles){
  const body=Math.max(1,Math.min(10,(w-82)/rows.length*.65));g.lineWidth=1;
  for(const [t,close,open,high,low] of rows){
   g.fillStyle=g.strokeStyle=close>=open?'#6eaf4c':'#a63a32';
   g.beginPath();g.moveTo(x(t),y(high));g.lineTo(x(t),y(low));g.stroke();
   g.fillRect(x(t)-body/2,Math.min(y(open),y(close)),body,Math.max(1.5,Math.abs(y(open)-y(close))));
  }
 }else{
 g.beginPath();g.strokeStyle='#91c779';g.lineWidth=2;rows.forEach(([t,v],i)=>i?g.lineTo(x(t),y(v)):g.moveTo(x(t),y(v)));g.stroke();
 const [lastTime,lastPnl]=rows.at(-1);g.fillStyle='#9dd583';g.beginPath();g.arc(x(lastTime),y(lastPnl),3,0,2*Math.PI);g.fill();
 }
 if(state.historyHover&&rows.length){
  const {x:mx,y:my}=state.historyHover,left=65,right=w-17,top=14,bottom=h-32;
  if(mx>=left&&mx<=right&&my>=top&&my<=bottom){
   const time=x0+(mx-left)/(right-left)*(x1-x0);
   let lo=0,hi=rows.length-1;
   while(lo<hi){const mid=Math.floor((lo+hi)/2);if(rows[mid][0]<time)lo=mid+1;else hi=mid}
   const prior=Math.max(0,lo-1);
   const [t,v,open,high,low]=Math.abs(rows[lo][0]-time)<Math.abs(rows[prior][0]-time)?rows[lo]:rows[prior];
   drawInspection(g,{x:x(t),y:y(v),left,right,top,bottom,heading:etDate(t)+' '+et(t)+' ET',value:candles?'O '+money(open)+'  H '+money(high)+'  L '+money(low)+'  C '+money(v):money(v)});
  }
 }
 g.fillStyle='#b9bdd0';g.fillText(etDate(x0)+' '+et(x0).slice(0,5),65,h-9);g.textAlign='right';g.fillText(etDate(x1)+' '+et(x1).slice(0,5)+' ET',w-16,h-9);g.textAlign='left';c.setAttribute('aria-label',(candles?'Contract premium OHLC':'Historical P&L')+', '+rows.length+' observation'+(rows.length===1?'':'s')+', latest '+money(rows.at(-1)[1]));
}
let historySeries=null;
async function loadHistory(){
 const token=++state.historySeq,series=state.seq;historyFallback=null;state.points=[];drawHistory();
 historySeries=state.ready?series:null;
 if(!state.ready){$('historyNote').textContent='Loading the selected instrument…';return}
 $('historyWindow').parentElement.hidden=!['market','bars'].includes($('historyType').value);
 if($('historyType').value==='liveCandles'){showLiveCandles();return}
 if($('historyType').value==='session'){showObservations();return}
 if(state.legs.length&&state.legs.every(l=>l.excluded)){$('historyNote').textContent='All legs excluded.';return}
 if(!state.legs.length){$('historyNote').textContent='Add a position to view strategy history.';return}
 $('historyNote').textContent='Requesting historical data…';
 try{
 if($('historyType').value==='saved'){
  if(!state.savedId){$('historyNote').textContent='Open a saved strategy to see its recorded marks.';return}
  const pts=await api('marks?'+qs({id:state.savedId}));if(token!==state.historySeq||series!==state.seq)return;
  if(hasSavedChanges()){$('historyNote').textContent='Save the current positions and commissions to view their recorded history.';return}
  state.points=pts;$('historyNote').textContent=pts.length+' observed strategy marks recorded while Options Lab was running.';
 }else if($('historyType').value==='bars'){
  const contract=candleContract();
  if(!contract){$('historyNote').textContent='Choose a single included option contract to view premium candles.';return}
  const bars=await api('bars?'+qs({id:contract.conId,window:$('historyWindow').value}));
  if(token!==state.historySeq||series!==state.seq)return;
  state.points=bars.filter(b=>Array.isArray(b.ohl)&&b.ohl.length===3).map(b=>[b.time,b.close,...b.ohl]);
  $('historyNote').textContent=state.points.length+' TWS midpoint premium candle'+(state.points.length===1?'':'s')+' · '+contract.root+' '+fmt(contract.strike)+contract.right+' · Per quoted unit.';
 }else{
  const res=await api('history',{legs:state.legs.map(cleanLeg),commissionPerContract:state.commissionPerContract,window:$('historyWindow').value});if(token!==state.historySeq||series!==state.seq)return;
  state.points=res.points;$('historyNote').textContent=(res.points.length||!res.message?res.points.length+' aligned bars · Per-leg bars '+res.coverage.join(' / ')+' · Historical midpoint P&L versus the fixed entries. ':'')+(res.message||'');
 }
 drawHistory();
 }catch(error){
  if(token!==state.historySeq||series!==state.seq)return;
  if(['bars','market'].includes($('historyType').value)){
   historyFallback={token,series,reason:error.message};
   showHistoryFallback();
  }else $('historyNote').textContent=error.message;
 }
}
let optimizerSeries='';
function localMinute(ms){
 const d=new Date(ms);
 return new Date(ms-d.getTimezoneOffset()*60000).toISOString().slice(0,16);
}
function resetOptimizer(){
 state.screen=[];$('optGrid').replaceChildren();
 $('optNote').textContent='Choose a target price and compare the quoted strikes in view.';
}
function optimizerDates(seed=false){
 if(!state.book)return;
 const input=$('optDate'),now=Date.now();
 const end=expiryMs({expiry:state.expiry,expiresAt:state.book.expiresAt,settlement:state.book.settlement});
 const series=[state.info.symbol,state.root,state.expiry,end].join('|');
 if(optimizerSeries!==series){optimizerSeries=series;input.value='';seed=true;resetOptimizer()}
 $('optDateLabel').hidden=$('optHorizon').value==='expiration';
 $('optZone').textContent='Target time ('+Intl.DateTimeFormat().resolvedOptions().timeZone+')';
 $('optRiskCurrency').textContent='Max loss ('+state.info.currency+')';
 input.min=localMinute(Math.floor(now/60000)*60000);
 input.max=end==null?'':localMinute(end);
 if(seed&&!input.value&&end>now)input.value=localMinute(Math.ceil((now+(end-now)/2)/60000)*60000);
 return end;
}
function optimize(){
 const all=chainRows(),pricing=$('optPricing').value;
 const multi=$('family').value==='templates';
 const end=optimizerDates(),dated=$('optHorizon').value==='date';
 const targetMs=dated?new Date($('optDate').value).getTime():null;
 if(dated&&(!valid(targetMs)||end==null||targetMs<Math.floor(Date.now()/60000)*60000||targetMs>end)){
  resetOptimizer();$('optNote').textContent='Choose a target in the current minute or later, up to the selected expiration.';return;
 }
 const coverage={},rate=Number($('rate').value)/100;
 const rows=(multi?screenTemplates:screenSpreads)(all,{spot:state.spot??state.center,symbol:state.info.symbol,root:state.root,expiry:state.expiry,target:$('optTarget').value,targetMs,rate,coverage,maxLoss:$('lossLimit').value,direction:$('direction').value,funding:$('funding').value,sortBy:$('rank').value,pricing,maxResults:35});
 state.screen=rows;
 const model=dated&&targetMs<end;
 const stamp=model?new Date(targetMs).toLocaleString(undefined,{dateStyle:'medium',timeStyle:'short'}):dateStr(state.expiry,true)+' expiration';
 const feed=[...new Set(all.map(q=>q.feed).filter(f=>f&&f!=='Waiting'))].join(' / ');
 const notes=[rows.length+' ranked strategies',coverage.eligible+' eligible quotes',feed,'Target '+stamp].filter(Boolean);
 if(model)notes.push('Modeled with fixed TWS IV per contract, '+fmt(rate*100)+'% annual rate, '+
  (state.info.secType==='FUT'?'futures-price carry':'0% dividend yield'));
 if(coverage.listed>coverage.quoted)notes.push((coverage.listed-coverage.quoted)+' without usable bid/ask');
 if(coverage.missingIV)notes.push(coverage.missingIV+' without TWS IV');
 if(coverage.unsupported)notes.push(coverage.unsupported+' without a verified model or settlement time');
 if(model&&!rows.length&&(coverage.unsupported||coverage.missingIV))notes.push('Select Expiration to compare intrinsic payoffs');
 $('optNote').textContent=notes.join(' · ');
 $('optGrid').innerHTML=grid(['Strategy','Strikes','Net debit','Expiry max loss','Expiry max profit','Expiry break-even','Target P&L','Target return / risk',''],rows.map((r,i)=>[esc(r.name),(multi?r.strikes.map(s=>fmt(s)).join(' / '):fmt(r.longStrike)+' / '+fmt(r.shortStrike)),fmt(r.netDebit),money(r.maxLoss),money(r.maxProfit),(r.breakevens?.map(v=>fmt(v)).join(' / ')||fmt(r.breakeven)),money(r.targetPnL),fmt(r.returnOnRisk*100,1)+'%','<button data-use="'+i+'">Open</button>']));
}
function dialog(title,body,action='Save'){
 return new Promise(resolve=>{
  $('dialogTitle').textContent=title;$('dialogBody').replaceChildren(body);$('dialogOk').textContent=action;
  const d=$('dialog');d.returnValue='cancel';d.addEventListener('close',()=>resolve(d.returnValue==='ok'),{once:true});d.showModal();
 });
}
async function save(){
 if(!state.ready||!state.legs.length)throw Error('Load a strategy first.');
 const name=document.createElement('input');name.setAttribute('aria-label','Strategy name');name.maxLength=100;name.value=state.name;
 if(!await dialog('Save strategy',name)||!name.value.trim())return;
 const seq=state.seq,docData=structuredClone({...doc(),name:name.value.trim()});
 const res=await api('save',{id:state.savedId,version:state.version,name:docData.name,document:docData});
 if(seq!==state.seq)return;
 state.name=docData.name;attachSaved(res,docData.legs,docData.commissionPerContract);structure();draft();message('Saved '+docData.name+'. Eligible live marks are recorded locally while the app is running.');
}
async function openSaved(s){
 if(archivedStrategy(s.document)){showArchive(s);return}
 await load(s.document.symbol,s.document,false,s);if(state.savedId!==s.id)return;
 state.name=s.name;page('build');structure();draft();message();
}
function closeDate(fill){
 const by=fill.confirmedClosedBy!=null,ms=by?fill.confirmedClosedBy:fill.at;
 const date=new Date(ms).toLocaleString('en-US',{timeZone:'America/New_York',dateStyle:'medium',timeStyle:'medium'})+' ET';
 return by?'Confirmed closed by '+date+' · execution time unknown':date;
}
function showArchive(item){
 const doc=item.document,rate=doc.commissionPerContract??0,totals=new Map();
 const rows=doc.legs.map(leg=>{
  checkCloses(leg);
  const currency=leg.currency||doc.currency||'';
  const format=v=>fmt(v,6)+(currency?' '+currency:'');
  const pnl=realizedPnl(leg,rate),fees=optionFee(leg,Math.abs(leg.qty)+closedQuantity(leg),rate);
  if(!leg.excluded){
   const total=totals.get(currency)||{pnl:0,fees:0};total.pnl+=pnl;total.fees+=fees;totals.set(currency,total);
  }
  const contract=leg.kind==='option'?leg.root+' '+dateStr(leg.expiry,true)+' '+leg.strike+leg.right:doc.symbol+' shares';
  const closes=leg.closes.map(fill=>{
   return esc(fill.qty+' @ '+format(fill.price)+(fill.reason==='expiredWorthless'?' · Expired worthless':''))+'<br><small>'+esc(closeDate(fill))+'</small>';
  }).join('<br>');
  return [esc(contract+(leg.excluded?' · excluded':'')),esc((leg.qty>0?'Bought ':'Sold ')+Math.abs(leg.qty)+' @ '+format(leg.entry)),esc(String(leg.multiplier)),closes,esc(leg.excluded?'Excluded':format(pnl))];
 });
 $('archiveTitle').textContent=item.name||doc.name||'Archived strategy';
 const summary=[...totals].map(([currency,total])=>fmt(total.pnl,6)+' '+(currency||'(currency unspecified)')+' realized P&L · '+fmt(total.fees,6)+' in commissions');
 if(valid(doc.source?.realizedPnl)&&totals.size===1&&Math.abs(totals.values().next().value.pnl-doc.source.realizedPnl)>.005)summary.push('Source-reported realized P&L '+fmt(doc.source.realizedPnl,6)+' '+[...totals.keys()][0]);
 $('archiveSummary').textContent=doc.symbol+' · '+(summary.join(' / ')||'All positions excluded');
 $('archiveFills').innerHTML=grid(['Position','Opening','Multiplier','Closing fills','Realized P&L'],rows);
 $('archiveTrade').showModal();
}
async function activity(){
 const token=++state.activitySeq,mode=state.act;
 const validToken=()=>state.page==='activity'&&state.act===mode&&token===state.activitySeq;
 document.querySelectorAll('[data-activity]').forEach(b=>b.classList.toggle('active',b.dataset.activity===mode));
 const tools=$('activityTools'),body=$('activityBody'),note=$('activityNote');
 if(tools.dataset.tab!==mode){
  tools.dataset.tab=mode;tools.innerHTML=mode==='scanner'?'<label>Ranking<select id="scannerCode"><option value="HOT_BY_OPT_VOLUME">Options volume activity</option><option value="HIGH_OPT_IMP_VOLAT">High implied volatility</option><option value="TOP_OPT_IMP_VOLAT_GAIN">Implied volatility gain</option></select></label><button id="refreshScan">Refresh</button>':mode==='tape'?'<label>Contract<select id="tapeContract"></select></label><button id="refreshTape">Request prints</button>':'';
  if(mode==='tape'){
   const rows=state.legs.filter(l=>l.kind==='option');$('tapeContract').innerHTML=rows.map(l=>'<option value="'+l.conId+'">'+esc(l.root+' '+dateStr(l.expiry)+' '+l.strike+l.right)+'</option>').join('');
  }
  body.innerHTML='';note.textContent='Requesting TWS data…';
 }
 try{
  if(mode==='updates'){
   const rows=await api('activity');if(!validToken())return;
   note.textContent='Last-price updates for subscribed options. Coverage follows the loaded strike window and active legs.';
   body.innerHTML=rows.length?grid(['Received (ET)','Contract','Last','Size','Bid','Ask'],rows.slice(0,55).map(r=>[esc(et(r.time)),esc(r.symbol),fmt(r.price),fmt(r.size),fmt(r.bid),fmt(r.ask)])):'<p>Waiting for a last-price update on subscribed contracts.</p>';
  }else if(mode==='scanner'){
   const rows=await api('scanner?'+qs({code:$('scannerCode').value}));if(!validToken())return;
   note.textContent='US equity rankings reported by the IBKR market scanner.';body.innerHTML=rows.length?grid(['Rank','Symbol','Primary exchange',''],rows.map(r=>[String(r.rank),esc(r.symbol),esc(r.exchange),'<button data-symbol="'+esc(r.symbol)+'">Build</button>'])):'<p>TWS returned no scanner results for this query.</p>';
  }else if(mode==='events'||mode==='tape'){
   const ident=mode==='events'?state.info.conId:$('tapeContract')?.value;
   if(!ident){note.textContent='Add an option leg to request its trade history.';return}
   const res=await api(mode+'?'+qs({id:ident}));if(!validToken())return;
   note.textContent=res.message||res.source;
   if(!res.rows.length){body.innerHTML='';return}
   body.innerHTML=mode==='tape'?grid(['Trade time (ET)','Price','Size','Exchange','Conditions'],res.rows.map(r=>[esc(etDate(r.time)+' '+et(r.time)),fmt(r.price),fmt(r.size),esc(r.exchange),esc(r.conditions)])):
    grid(['Event date','Event','Details'],res.rows.map(r=>[esc(r.date),esc(r.title),esc(r.detail)]));
  }else{
   const res=await api('news?'+qs({id:state.info.conId}));if(!validToken())return;
   note.textContent=res.providers.length?'IBKR news providers available to this session: '+res.providers.join(', '):'No entitled news provider reported by TWS.';
   body.innerHTML=res.items.length?grid(['Report time','Source','Headline'],res.items.map(r=>[esc(r.time),esc(r.provider),'<button data-article="'+esc(r.id)+'" data-provider="'+esc(r.provider)+'">'+esc(r.headline)+'</button>'])):'<p>No headlines returned for this underlying.</p>';
  }
 }catch(e){if(validToken()){note.textContent=e.message;body.innerHTML=''}}
}
function page(name){
 if(name==='saved'&&!location.hash)history.replaceState(null,'',savedListHash());
 else if(name!=='saved'&&['#saved','#saved/closed','#saved/all'].includes(location.hash))history.replaceState(null,'',location.pathname+location.search);
 state.page=name;message();$('quoteOnly').hidden=name==='saved'||!!state.book;document.querySelectorAll('.page').forEach(el=>el.hidden=el.id!==name);
 document.querySelectorAll('[data-page]').forEach(b=>b.classList.toggle('active',b.dataset.page===name));
 $('marketControls').hidden=name==='saved';if($('legsPanel').open)$('legsPanel').close();
 for(const id of ['addLeg','positions','save','share','topHistory','template'])$(id).hidden=name!=='build';
 if(name==='saved'){optionsHistory.syncVisibility();savedTrades.reload().catch(e=>message(e.message));return}
 optionsHistory.stop();savedTrades.stop();
 if(!state.info){startBuilder();return}
 if(state.ready){structure();if(name==='activity')activity().catch(e=>message(e.message));if(name==='optimize'){state.screen=[];$('optGrid').innerHTML='';tick()}}
}
let strikePopup=null, inspectRequest=0;
const strikePanel=$('legBubble');
const premium=v=>valid(v)?v.toLocaleString('en-US',{minimumFractionDigits:2,maximumFractionDigits:6}):'—';
const statistic=(v,d)=>valid(v)?v.toLocaleString('en-US',{minimumFractionDigits:d,maximumFractionDigits:d}):'—';
const shortExpiry=s=>Number(s.slice(4,6))+'/'+Number(s.slice(6,8))+'/'+s.slice(2,4);
const marketFields=['Bid','Ask','Volume','OI','IV','Delta','Theta','Gamma','Vega','Rho'];
for(const name of marketFields){
 const pair=document.createElement('div'),label=document.createElement('dt'),value=document.createElement('dd');
 label.textContent=name;value.id='legStat'+name;value.textContent='—';
 if(name==='Rho'){
  label.textContent='Rho*';pair.title='Model estimate per 1 percentage-point rate change using TWS IV, the current underlying, and the builder’s annual rate.';
 }
 pair.append(label,value);$('bubbleMarket').append(pair);
}
function currentPopupLeg(){
 if(!strikePopup)return null;
 return strikePopup.preview??state.legs[strikePopup.index];
}
function bubbleQuote(){
 const leg=currentPopupLeg();if(!leg)return;
 const q=state.quotes[leg.conId]||{};
 const rho=leg.kind==='option'?modelRho({...leg,iv:q.iv},q.modelUnderlying??state.spot,Number($('rate').value)/100):null;
 const values=[premium(q.bid),premium(q.ask),fmt(q.volume,0),fmt(q.oi,0),valid(q.iv)?fmt(q.iv*100,1)+'%':'—',
  statistic(q.delta,3),fmt(q.theta,3),statistic(q.gamma,4),fmt(q.vega,3),statistic(rho,3)];
 marketFields.forEach((name,i)=>{const el=$('legStat'+name);if(el.textContent!==values[i])el.textContent=values[i]});
 $('editQty').textContent=String(remainingQty(leg));
 $('editPrice').textContent=premium(leg.entry??(strikePopup.preview?entryQuote(leg,q):null));
 $('useMid').disabled=!valid(q.mid);
 $('beginClose').disabled=!valid(leg.entry);
 const status=[];
 if(leg.excluded)status.push('Excluded');
 if(leg.closes?.length)status.push(closedQuantity(leg)+' of '+Math.abs(leg.qty)+' closed · realized '+money(realizedPnl(leg,state.commissionPerContract)));
 if(q.error)status.push(q.error);
 else if(!q.feed||q.feed==='Waiting')status.push('Waiting for TWS');
 else if(q.feed!=='Live')status.push(q.feed+' market data');
 if(q.oi===0)status.push('Low open interest (0)');
 const statusText=status.join(' · ');
 if($('bubbleStatus').textContent!==statusText){
  $('bubbleStatus').textContent=statusText;$('bubbleStatus').hidden=!statusText;placeBubble();
 }
}
function placeBubble(){
 if(!strikePopup||!strikePanel.matches(':popover-open'))return;
 const rect=strikePopup.anchor();
 if(!rect)return;
 const w=strikePanel.offsetWidth,h=strikePanel.offsetHeight,gap=4,margin=6;
 const left=Math.max(margin,Math.min(innerWidth-w-margin,rect.left+6));
 const below=rect.bottom+gap;
 const top=below+h<=innerHeight-margin?below:rect.top-h-gap>=margin?rect.top-h-gap:Math.max(margin,innerHeight-h-margin);
 strikePanel.style.left=left+'px';strikePanel.style.top=top+'px';
}
function hideEditors(){
 for(const [input,button] of [['bubbleQty','editQty'],['bubbleEntry','editPrice']]){
  $(input).hidden=true;$(button).hidden=false;
 }
}
function showBubble(){
 const leg=currentPopupLeg();if(!leg)return;
 const preview=!!strikePopup.preview;
 $('bubbleTitle').textContent=positionContract(leg);
 $('flipRight').hidden=leg.kind!=='option';$('bubbleExpiry').parentElement.hidden=leg.kind!=='option';
 const target=leg.right==='C'?'Put':'Call';
 $('switchRightName').textContent=target;$('switchRightName').className=target.toLowerCase();
 $('switchSideName').textContent=leg.qty>0?'Switch to Short':'Switch to Long';
 const remaining=remainingQty(leg),hasCloses=!!leg.closes?.length;
 const verb=leg.qty>0?'Sell to Close':'Buy to Close';
 $('closeVerb').textContent=verb;$('confirmClose').textContent=verb;
 $('closeForm').hidden=true;$('closeError').hidden=true;
 $('beginClose').hidden=preview||!remaining;$('beginClose').disabled=!valid(leg.entry);
 $('undoClose').hidden=preview||!hasCloses;$('excludeLeg').hidden=preview;
 $('excludeLabel').textContent=leg.excluded?'Include':'Exclude';$('excludeLeg').setAttribute('aria-pressed',String(!!leg.excluded));
 $('flipSide').hidden=!preview;$('useMid').hidden=!preview;
 $('flipRight').disabled=hasCloses;$('bubbleExpiry').disabled=hasCloses;
 $('editQty').disabled=!remaining;$('qtyDown').disabled=!remaining;$('qtyUp').disabled=!remaining;
 $('bubbleRemove').hidden=preview;$('applyStrike').hidden=!preview;
 $('applyStrikeLabel').textContent=strikePopup.index==null?'Add to strategy':'Use this strike';
 if(leg.kind==='option')selectOptions($('bubbleExpiry'),state.info.roots[leg.root].expiries,leg.expiry,e=>dateStr(e,true));
 hideEditors();bubbleQuote();
 if(!strikePanel.matches(':popover-open'))strikePanel.showPopover();
 placeBubble();
}
async function inspectStrike(strike,anchor,explicitIndex){
 if(!state.ready||!state.book||state.page!=='build')return;
 const request=++inspectRequest,seq=state.seq,active=state.legs[state.active];
 const matches=l=>l.kind==='option'&&l.root===state.root&&l.expiry===state.expiry&&l.strike===strike;
 const selected=explicitIndex??(active&&matches(active)?state.active:state.legs.findIndex(matches));
 if(selected>=0){
  state.active=selected;strikePopup={index:selected,preview:null,anchor};
  structure();showBubble();return;
 }
 const row=state.book.strikes.find(s=>s.strike===strike);if(!row)return;
 const preferred=active?.kind==='option'?active.right:'C';
 const right=row[preferred]?preferred:(row.C?'C':'P');
 const leg=await qualify({kind:'option',root:state.root,expiry:state.expiry,strike,right,
  qty:active?.kind==='option'?(remainingQty(active)||Math.sign(active.qty)):1,entry:null,entryFeed:null});
 if(request!==inspectRequest||seq!==state.seq)return;
 strikePopup={index:active?.kind==='option'&&!active.closes?.length?state.active:null,preview:leg,anchor};
 showBubble();tick();
}
async function bubbleChange(field,val){
 const popup=strikePopup,old=currentPopupLeg(),seq=state.seq;
 if(!old)return;
 let leg={...old};
 if(field==='qty'){
  if(!Number.isInteger(val)||!val||Math.abs(val)>100000)throw Error('Enter a nonzero whole quantity.');
  if(old.closes?.length&&Math.sign(val)!==Math.sign(old.qty))throw Error('Undo recorded closes before changing sides.');
  leg.qty=val+Math.sign(val)*closedQuantity(old);
  if(Math.abs(leg.qty)>100000)throw Error('Opening quantity exceeds 100,000.');
 }else if(field==='entry'){
  if(!valid(val)||val<0)throw Error('Enter a nonnegative price.');
  leg.entry=val;leg.entryFeed='Manual';
 }else{
  if(leg.closes?.length)throw Error('Undo recorded closes before changing this contract.');
  leg[field]=val;leg.entry=null;leg.entryFeed=null;
  if(field==='expiry')leg.strike=nearest(await bookFor(state.info.symbol,leg.root,val),leg.strike,leg.right).strike;
  leg=await qualify(leg);
 }
 if(popup!==strikePopup||seq!==state.seq||old!==currentPopupLeg())return;
 if(popup.preview)popup.preview=leg;
 else{
  const legs=state.legs.slice();legs[popup.index]=leg;commit(legs,'Custom strategy',popup.index);
  if(field==='expiry')await setExpiry(leg.expiry,leg.root,false);
 }
 if(popup===strikePopup){showBubble();tick()}
}
function setUpEditor(buttonId,inputId,field){
 const button=$(buttonId),input=$(inputId);
 button.onclick=()=>{
  const leg=currentPopupLeg();if(!leg)return;
  const value=field==='qty'?remainingQty(leg):leg.entry??(strikePopup.preview?entryQuote(leg,state.quotes[leg.conId]):null);
  input.value=value??'';button.hidden=true;input.hidden=false;input.focus();input.select();
 };
 input.onkeydown=e=>{
  if(e.key==='Enter'){e.preventDefault();input.blur()}
  if(e.key==='Escape'){
   e.stopPropagation();e.preventDefault();input.hidden=true;button.hidden=false;button.focus();
  }
 };
 input.onblur=handled(async()=>{
  if(input.hidden||!strikePanel.matches(':popover-open'))return;
  input.hidden=true;button.hidden=false;
  const value=input.value===''?null:Number(input.value),leg=currentPopupLeg();
  if(!leg||value===(field==='qty'?remainingQty(leg):leg[field])||(field==='entry'&&strikePopup.preview&&leg.entry==null&&value===entryQuote(leg,state.quotes[leg.conId])))return;
  await bubbleChange(field,value);
 });
}
setUpEditor('editQty','bubbleQty','qty');setUpEditor('editPrice','bubbleEntry','entry');
strikePanel.addEventListener('beforetoggle',e=>{if(e.newState==='closed'){strikePopup=null;inspectRequest++;hideEditors()}});
$('bubbleClose').onclick=()=>strikePanel.hidePopover();
for(const [id,increment] of [['qtyDown',-1],['qtyUp',1]]){
 $(id).onclick=handled(()=>{const leg=currentPopupLeg(),q=leg?remainingQty(leg):0;if(q)return bubbleChange('qty',q+increment||increment)});
}
function updatePopupPosition(leg){
 const index=strikePopup.index,legs=state.legs.slice();legs[index]=leg;
 commit(legs,state.name,index);showBubble();
}
$('excludeLeg').onclick=()=>{
 if(!strikePopup||strikePopup.preview)return;
 const leg=currentPopupLeg();updatePopupPosition({...leg,excluded:!leg.excluded});
};
$('beginClose').onclick=()=>{
 const leg=currentPopupLeg(),mid=state.quotes[leg.conId]?.mid;
 $('closingPrice').value=valid(mid)?mid:'';
 $('closingQty').value='All';$('closeForm').hidden=false;$('beginClose').hidden=true;
 $('closeError').hidden=true;placeBubble();$('closingPrice').focus();$('closingPrice').select();
};
function closingQuantity(){
 const text=$('closingQty').value.trim();
 return text.toLowerCase()==='all'?Math.abs(remainingQty(currentPopupLeg())):Number(text);
}
for(const [id,step] of [['closeQtyDown',-1],['closeQtyUp',1]]){
 $(id).onclick=()=>{
  const max=Math.abs(remainingQty(currentPopupLeg())),qty=Math.max(1,Math.min(max,(closingQuantity()||1)+step));
  $('closingQty').value=qty===max?'All':String(qty);
 };
}
$('cancelClose').onclick=showBubble;
$('closeForm').onsubmit=e=>{
 e.preventDefault();
 if(!strikePopup||strikePopup.preview||$('closeForm').hidden)return;
 const leg=currentPopupLeg(),qty=closingQuantity(),raw=$('closingPrice').value.trim(),price=Number(raw);
 if(!raw||!valid(price)||price<0||!Number.isSafeInteger(qty)||qty<1||qty>Math.abs(remainingQty(leg))){
  $('closeError').textContent='Enter a nonnegative price and a whole quantity within the open position.';
  $('closeError').hidden=false;placeBubble();return;
 }
 updatePopupPosition({...leg,closes:[...(leg.closes??[]),{qty,price,at:Date.now()}]});
};
$('undoClose').onclick=()=>{
 const leg=currentPopupLeg();if(leg?.closes?.length)updatePopupPosition({...leg,closes:leg.closes.slice(0,-1)});
};
$('flipRight').onclick=handled(()=>bubbleChange('right',currentPopupLeg().right==='C'?'P':'C'));
$('flipSide').onclick=handled(()=>bubbleChange('qty',-currentPopupLeg().qty));
$('useMid').onclick=handled(()=>bubbleChange('entry',state.quotes[currentPopupLeg().conId]?.mid));
$('bubbleExpiry').onchange=handled(e=>bubbleChange('expiry',e.target.value));
$('applyStrike').onclick=handled(async()=>{
 const popup=strikePopup;if(!popup?.preview)return;
 const leg={...popup.preview},quote=state.quotes[leg.conId];
 const entry=entryQuote(leg,quote);
 if(leg.entry==null&&valid(entry)){leg.entry=entry;leg.entryFeed=quote.feed}
 const index=popup.index??state.legs.length,legs=state.legs.slice();legs[index]=leg;
 if(legs.length>16)throw Error('A strategy supports up to 16 positions.');
 commit(legs,'Custom strategy',index);
 if(leg.expiry!==state.expiry)await setExpiry(leg.expiry,leg.root,false);
 if(popup!==strikePopup)return;
 strikePopup={index,preview:null,anchor:()=>document.querySelector('.marker.selected')?.getBoundingClientRect()??popup.anchor()};
 showBubble();tick();
});
$('bubbleRemove').onclick=()=>{const index=strikePopup.index;strikePanel.hidePopover();commit(state.legs.filter((_,i)=>i!==index),'Custom strategy')};
addEventListener('resize',placeBubble);
addEventListener('scroll',placeBubble,{capture:true,passive:true});
let sliderMove=null;
$('railVolume').onchange=updateStrikeVolumes;
function beginSlider(e){
 sliderMove=e.shiftKey&&state.ready&&state.page==='build'&&state.book?
  {start:nearest(state.book,state.center).strike,book:state.book,legs:state.legs}:null;
}
$('strikePan').onpointerdown=beginSlider;
$('strikePan').onkeydown=e=>{if(['ArrowLeft','ArrowRight','ArrowUp','ArrowDown','Home','End','PageUp','PageDown'].includes(e.key))beginSlider(e)};
$('strikePan').onpointercancel=()=>{sliderMove=null;structure()};
$('strikePan').oninput=e=>{
 if(!state.book||sliderMove)return;
 state.center=state.book.strikes[Number(e.target.value)].strike;structure();state.screen=[];$('optGrid').innerHTML='';
};
$('strikePan').onchange=handled(async e=>{
 const gesture=sliderMove;sliderMove=null;
 if(!gesture||state.book!==gesture.book||state.legs!==gesture.legs)return;
 const next=gesture.book.strikes[Number(e.target.value)].strike;
 try{await shiftOptions(shiftedStrike(next,-gesture.start),next)}finally{structure()}
});
const modelMenu=$('modelSettings');
modelMenu.addEventListener('keydown',e=>{
 if(e.key==='Escape'&&modelMenu.open){e.preventDefault();modelMenu.open=false;modelMenu.querySelector('summary').focus()}
});
document.addEventListener('pointerdown',e=>{if(modelMenu.open&&!modelMenu.contains(e.target))modelMenu.open=false});
const chartMenu=$('modelSettings');
document.addEventListener('pointerdown',e=>{if(chartMenu.open&&!chartMenu.contains(e.target))chartMenu.open=false});
chartMenu.addEventListener('keydown',e=>{
 if(e.key!=='Escape'||!chartMenu.open)return;
 e.preventDefault();chartMenu.open=false;chartMenu.querySelector('summary').focus();
});
document.querySelectorAll('[data-unit]').forEach(b=>b.onclick=()=>{
 const metric=b.dataset.unit;
 if(greekModes[metric]&&!greekModes[state.unit]&&Number($('horizon').value)===100){
  pickedDate=null;$('horizon').value='0';
 }
 state.unit=metric;
 document.querySelectorAll('[data-unit]').forEach(x=>{x.classList.toggle('active',x===b);x.setAttribute('aria-pressed',String(x===b))});
 if(greekModes[metric]){$('modelSettings').open=false;document.querySelector('#modelSettings summary').focus()}
 render();
});
async function add(side,right){
 if(!state.ready||!state.book)return;
 const seq=state.seq,book=state.book;
 if(state.legs.length>=16)throw Error('This workspace supports up to sixteen legs per strategy.');
 const strike=nearest(book,state.spot??state.center,right).strike;
 const leg=await qualify({kind:'option',root:state.root,expiry:state.expiry,strike,right,qty:side,entry:null});
 if(seq!==state.seq||book!==state.book||state.page!=='build')return;
 if(state.legs.length>=16)throw Error('This workspace supports up to sixteen legs per strategy.');
 const q=state.quotes[leg.conId],entry=entryQuote(leg,q);
 if(valid(entry)){leg.entry=entry;leg.entryFeed=q.feed}
 commit([...state.legs,leg],'Custom strategy',state.legs.length);tick();
}
function placeAddMenu(){
 const menu=$('addMenu');if(!menu.matches(':popover-open'))return;
 const rect=$('addLeg').getBoundingClientRect(),width=menu.offsetWidth,height=menu.offsetHeight;
 menu.style.left=Math.max(4,Math.min(innerWidth-width-4,rect.left+rect.width/2))+'px';
 menu.style.top=Math.max(4,rect.bottom+height<=innerHeight-4?rect.bottom:rect.top-height)+'px';
}
$('addMenu').addEventListener('toggle',e=>{
 $('addLeg').setAttribute('aria-expanded',String(e.newState==='open'));
 if(e.newState==='open')placeAddMenu();
});
addEventListener('resize',placeAddMenu);
addEventListener('scroll',placeAddMenu,{capture:true,passive:true});
$('addMenu').onclick=handled(e=>{
 const b=e.target.closest('[data-right]');if(!b)return;
 $('addMenu').hidePopover();$('addLeg').focus();return add(Number(b.dataset.side),b.dataset.right);
});
function menuKeys(e){
 if(!['ArrowDown','ArrowUp','Home','End'].includes(e.key))return;
 e.preventDefault();const menu=$('addMenu'),items=[...menu.querySelectorAll('button')];
 if(!menu.matches(':popover-open'))menu.showPopover({source:$('addLeg')});
 const i=items.indexOf(document.activeElement);
 const next=e.key==='Home'?0:e.key==='End'?items.length-1:e.key==='ArrowUp'?(i<=0?items.length-1:i-1):(i+1)%items.length;
 items[next].focus();
}
$('addLeg').onkeydown=menuKeys;$('addMenu').onkeydown=menuKeys;
function handled(fn){return event=>Promise.resolve().then(()=>fn(event)).catch(e=>{
 if($('legsPanel').open){$('positionError').textContent=e.message;$('positionError').hidden=false}
 else message(e.message);
})}
connectTicker({
 search:q=>api('search?'+qs({q})),current:()=>tickerLabel(state.info),onError:e=>message(e.message),
 select:async hit=>{
  if(state.ready&&hit.conId===state.info?.conId)return;
  await load(hit.key,null,true);
  if(state.page==='activity'){delete $('activityTools').dataset.tab;await activity()}
 }
});
$('root').onchange=handled(()=>setExpiry(state.info.roots[$('root').value].expiries.includes(state.expiry)?state.expiry:state.info.roots[$('root').value].expiries[0],$('root').value));
$('template').onchange=handled(()=>preset($('template').value));$('feed').onchange=()=>{state.mode=Number($('feed').value);state.quotes={};state.screen=[];$('optGrid').innerHTML='';render();tick()};
const positionsDialog=$('legsPanel');
$('commissionRate').addEventListener('change',e=>{
 const input=e.target,newRate=input.value===''?0:input.valueAsNumber;
 if(!input.validity.valid||!valid(newRate)){input.reportValidity();input.value=String(state.commissionPerContract);return}
 input.value=String(newRate);
 if(newRate===state.commissionPerContract)return;
 state.commissionPerContract=newRate;state.comparison='current';
 invalidateHistory();draft();render();
});
$('positions').onclick=()=>{
 positionsClosed=false;$('positionError').hidden=true;
 if(strikePanel.matches(':popover-open'))strikePanel.hidePopover();
 positionsDialog.append(strikePanel);positionsDialog.showModal();legsPanel();
};
$('closeLegs').onclick=()=>positionsDialog.close();
positionsDialog.addEventListener('click',e=>{
 if(e.target!==positionsDialog)return;
 const r=positionsDialog.getBoundingClientRect();
 if(e.clientX<r.left||e.clientX>r.right||e.clientY<r.top||e.clientY>r.bottom)positionsDialog.close();
});
positionsDialog.addEventListener('close',()=>{
 if(strikePanel.matches(':popover-open'))strikePanel.hidePopover();
 positionsDialog.after(strikePanel);
});
for(const [id,closed] of [['openPositions',false],['closedPositions',true]])$(id).onclick=()=>{
 positionsClosed=closed;$('positionError').hidden=true;legsPanel();
};
function updatePositions(action,mode=state.pricing){
 const flip=action==='flip',reset=action==='reset';
 if(flip&&state.legs.some(l=>remainingQty(l)&&closedQuantity(l)))return;
 const legs=state.legs.map(l=>{
  if(closedQuantity(l))return l;
  const leg=flip?{...l,qty:-l.qty}:{...l};
  if(reset?!customEntry(l):customEntry(l))return leg;
  const q=state.quotes[l.conId],entry=entryQuote(leg,q,mode);
  leg.entry=valid(entry)?entry:null;leg.entryFeed=valid(entry)?q.feed:null;
  return leg;
 });
 state.pricing=mode;commit(legs,flip?'Custom strategy':state.name,state.active);tick();
}
$('flipPositions').onclick=()=>updatePositions('flip');
$('resetPrices').onclick=()=>updatePositions('reset');
for(const b of document.querySelectorAll('[data-position-pricing]'))b.onclick=()=>{
 if(b.dataset.positionPricing!==state.pricing)updatePositions('pricing',b.dataset.positionPricing);
};
$('share').onclick=handled(async()=>{
 const value=JSON.stringify(doc()),bytes=new TextEncoder().encode(value);
 const hash=btoa(Array.from(bytes,c=>String.fromCharCode(c)).join('')).replaceAll('+','-').replaceAll('/','_').replace(/=+$/,'');
 const url=new URL(location.href);url.hash='strategy='+hash;
 try{await navigator.clipboard.writeText(url.href);message('Strategy link copied. It opens on a computer running Options Lab.')}
 catch{const input=document.createElement('input');input.value=url.href;input.readOnly=true;const result=dialog('Copy strategy link',input,'Done');input.select();await result}
});
$('save').onclick=handled(save);$('fetchHistory').onclick=handled(loadHistory);
for(const id of ['historyWindow','historyType'])$(id).onchange=handled(loadHistory);
for(const id of ['iv','rate','targetPrice'])$(id).oninput=render;
$('horizon').oninput=()=>{
 const fraction=Number($('horizon').value)/100,now=Date.now();
 pickedDate=fraction>0&&fraction<1&&dateExpiry>now?
  {expiry:dateExpiry,time:now+(dateExpiry-now)*fraction}:null;
 if(dateFrame!==null)return;
 dateFrame=requestAnimationFrame(()=>{
  dateFrame=null;
  if(!state.book||state.page!=='build'||state.view!=='graph')return;
  const p=params();
  syncDateControl(p);
  renderGraph(p);
  renderScenarioNote(p,analyze(p.legs,p.spot,p.horizonMs,p.ivShift,p.rate,p.now));
 });
};
$('zoom').oninput=()=>{manualRange=Number($('zoom').value);manualCeiling=Number($('zoom').max);render()};
$('zoom').ondblclick=()=>{manualRange=null;manualCeiling=null;render()};
for(const slider of [$('horizon'),$('iv'),$('zoom')])slider.onkeydown=e=>{
 if(!['ArrowLeft','ArrowRight','ArrowUp','ArrowDown'].includes(e.key))return;
 e.preventDefault();const sign=['ArrowUp','ArrowRight'].includes(e.key)?1:-1;
 slider.value=String(Number(slider.value)+sign*(Number(slider.max)-Number(slider.min))/100);
 slider.dispatchEvent(new Event('input',{bubbles:true}));
};
function setIvFactor(value){$('iv').value=String(value);render()}
for(const button of document.querySelectorAll('[data-factor]'))button.onclick=()=>setIvFactor(Number(button.dataset.factor));
$('resetIv').onclick=()=>setIvFactor(1);
$('setChartTarget').onclick=()=>{
 const input=$('targetDraft');input.value=readTarget()??state.spot??state.center;input.min=$('targetPrice').min;
 $('chartTargetDialog').showModal();input.focus();input.select();
};
$('chartTargetForm').onsubmit=e=>{e.preventDefault();$('targetPrice').value=$('targetDraft').value;$('chartTargetDialog').close();render()};
$('clearTarget').onclick=()=>{$('targetPrice').value='';$('chartTargetDialog').close();render()};
$('cancelTarget').onclick=()=>$('chartTargetDialog').close();
$('chainPanel').ontoggle=()=>{if(state.ready&&$('chainPanel').open)renderChain()};
function pointerPosition(event){
 const rect=event.currentTarget.getBoundingClientRect();
 return {x:event.clientX-rect.left,y:event.clientY-rect.top};
}
function inspectGraphStrike(){
 if(!valid(state.inspectedPrice)||!state.book)return;
 const chart=$('riskCanvas'),dx=state.hover,dy=state.hoverY??chart.clientHeight/2;
 const strike=nearest(state.book,state.inspectedPrice).strike;
 return inspectStrike(strike,()=>{
  const rect=chart.getBoundingClientRect(),left=rect.left+dx,top=rect.top+dy;
  return {left,top,bottom:top+1};
 });
}
$('riskCanvas').onclick=handled(e=>{inspectRisk(e);return inspectGraphStrike()});
function inspectRisk(e){const at=pointerPosition(e);state.hover=at.x;state.hoverY=at.y;renderGraph()}
$('riskCanvas').onpointermove=inspectRisk;
$('riskCanvas').onpointerdown=inspectRisk;
$('riskCanvas').onpointerleave=()=>{state.hover=null;state.hoverY=null;renderGraph()};
$('riskCanvas').onkeydown=e=>{
 if(e.key==='Enter'){e.preventDefault();Promise.resolve(inspectGraphStrike()).catch(e=>message(e.message));return}
 if(!['ArrowLeft','ArrowRight','Escape'].includes(e.key))return;
 e.preventDefault();
 if(e.key==='Escape')state.hover=null;
 else state.hover=Math.max(68,Math.min($('riskCanvas').clientWidth-8,(state.hover??$('riskCanvas').clientWidth/2)+(e.key==='ArrowLeft'?-6:6)));
 state.hoverY=null;renderGraph();
};
$('riskCanvas').onblur=()=>{state.hover=null;state.hoverY=null;renderGraph()};
$('histCanvas').onpointermove=e=>{state.historyHover=pointerPosition(e);drawHistory()};
$('histCanvas').onpointerleave=()=>{state.historyHover=null;drawHistory()};
new ResizeObserver(()=>{
 if(!state.ready||!state.book||state.page!=='build')return;
 const width=$('strikes').clientWidth;
 if(width>0&&width!==state.railWidth)structure();
 if(state.view==='graph')renderGraph();else if(state.view==='history')drawHistory();
}).observe($('build'));
let railDrag=null,suppressStrikeClick=false;
const rail=$('strikes');
function strikeUnderPointer(e){
 const cell=document.elementFromPoint(e.clientX,e.clientY)?.closest('.strike[data-strike]');
 return cell&&rail.contains(cell)?cell:null;
}
rail.addEventListener('pointerdown',e=>{
 suppressStrikeClick=false;
 const cell=e.target.closest('.strike[data-strike]'),marker=e.target.closest('[data-leg]');
 if(!cell||e.button!==0||!e.isPrimary||!state.ready||state.page!=='build'||marker?.dataset.movable==='false')return;
 railDrag={id:e.pointerId,index:marker?Number(marker.dataset.leg):null,start:Number(cell.dataset.strike),
  x:e.clientX,y:e.clientY,shift:e.shiftKey,center:state.center,book:state.book,legs:state.legs,dragging:false,target:null};
});
window.addEventListener('pointermove',e=>{
 const g=railDrag;if(!g||g.id!==e.pointerId)return;
 if(!g.dragging){
  if(Math.hypot(e.clientX-g.x,e.clientY-g.y)<5)return;
  g.dragging=true;rail.classList.add('dragging');
  if(e.isTrusted)rail.setPointerCapture(e.pointerId);
 }
 const over=strikeUnderPointer(e);
 if(over!==g.target){g.target?.classList.remove('drop-target');over?.classList.add('drop-target');g.target=over}
});
function clearRailDrag(){
 const g=railDrag;if(!g)return;
 railDrag=null;g.target?.classList.remove('drop-target');rail.classList.remove('dragging');
 if(rail.hasPointerCapture(g.id))rail.releasePointerCapture(g.id);
}
rail.addEventListener('lostpointercapture',e=>{if(e.target===rail&&railDrag?.id===e.pointerId)clearRailDrag()});
window.addEventListener('pointercancel',e=>{if(railDrag?.id===e.pointerId)clearRailDrag()});
window.addEventListener('pointerup',e=>{
 const g=railDrag;if(!g||g.id!==e.pointerId)return;
 const cell=strikeUnderPointer(e);
 clearRailDrag();if(!g.dragging)return;
 suppressStrikeClick=true;
 if(!cell||g.book!==state.book||g.legs!==state.legs)return;
 const strike=Number(cell.dataset.strike),delta=shiftedStrike(strike,-g.start);
 if(!delta)return;
 const shift=g.shift||e.shiftKey;
 if(g.index!==null){handled(()=>moveLeg(g.index,strike,shift))();return}
 if(shift){handled(()=>shiftOptions(delta,shiftedStrike(g.center,delta)))();return}
 state.center=nearest(state.book,shiftedStrike(g.center,-delta)).strike;
 state.screen=[];$('optGrid').innerHTML='';structure();tick();
});
rail.addEventListener('click',e=>{
 if(suppressStrikeClick&&e.detail){suppressStrikeClick=false;e.preventDefault();e.stopImmediatePropagation()}
},true);
$('strikes').onclick=handled(async e=>{
 const s=e.target.closest('[data-strike]');if(!s)return;
 const strike=Number(s.dataset.strike),m=e.target.closest('[data-leg]');
 if(state.page==='build'){
  const index=m?Number(m.dataset.leg):undefined;
  const selector=m?'.marker[data-leg="'+index+'"]':'.strike[data-strike="'+strike+'"]';
  const original=s.getBoundingClientRect();
  await inspectStrike(strike,()=>document.querySelector(selector)?.getBoundingClientRect()??original,index);
 }else{state.center=strike;structure();state.screen=[];$('optGrid').innerHTML=''}

});
for(const [id,sign] of [['left',-1],['right',1]])$(id).onclick=()=>{
 if(!state.book)return;const arr=state.book.strikes,i=arr.indexOf(nearest(state.book,state.center));state.center=arr[Math.max(0,Math.min(arr.length-1,i+sign*6))].strike;
 state.screen=[];$('optGrid').innerHTML='';structure();tick();
};
$('expiries').onclick=handled(async e=>{const b=e.target.closest('[data-exp]');if(b)await setExpiry(b.dataset.exp,state.root,state.page==='build')});
$('legs').onclick=handled(e=>{
 const button=e.target.closest('[data-pick]');if(!button)return;
 const i=Number(button.dataset.pick),leg=state.legs[i];if(!leg)return;
 state.active=i;strikePopup={index:i,preview:null,anchor:()=>$('legs').querySelector('[data-pick="'+i+'"]')?.getBoundingClientRect()??$('legs').getBoundingClientRect()};
 showBubble();
});
$('chainGrid').onclick=handled(async e=>{
 const b=e.target.closest('[data-chain]');if(!b)return;const q=chainRows().find(r=>r.conId===Number(b.dataset.chain));
 if(state.legs.length>=16)throw Error('Remove a leg before adding another.');
 const l=cleanLeg({...q,qty:Number(b.dataset.side),entry:entryQuote({qty:Number(b.dataset.side)},q)??null,entryFeed:q.feed,kind:'option'});
 commit([...state.legs,l],'Custom strategy',state.legs.length);
});
$('optimize').querySelector('.filters').addEventListener('input',e=>{resetOptimizer();optimizerDates(e.target.id==='optHorizon')});
$('scan').onclick=handled(optimize);
$('optGrid').onclick=handled(async e=>{
 const b=e.target.closest('[data-use]');if(!b)return;const r=state.screen[Number(b.dataset.use)],legs=await Promise.all(r.legs.map(l=>qualify({...l,entryFeed:r.pricing})));
 commit(legs,r.name);page('build');setView('graph');
});
document.querySelectorAll('[data-page]').forEach(b=>b.onclick=()=>{
 if(b.dataset.page==='build'&&state.page==='build'&&state.ready&&state.book){
  const menu=$('buildMenu'),groups=[...new Set(presets.map(p=>p.group))];
  menu.innerHTML=groups.map(g=>'<section><h3>'+esc(g)+'</h3>'+presets.filter(p=>p.group===g).map(p=>'<button data-preset="'+esc(p.id)+'"'+(p.usesStock&&state.info.secType!=='STK'||p.usesNextExpiry&&!laterExp()?' disabled':'')+'>'+esc(p.name)+'</button>').join('')+'</section>').join('');
  for(const item of menu.querySelectorAll('[data-preset]')){
   const canvas=document.createElement('canvas');canvas.width=88;canvas.height=40;
   canvas.setAttribute('aria-hidden','true');item.prepend(canvas);
   const values=strategyShape(item.dataset.preset);
   if(values.some(v=>!valid(v)))continue;
   const hi=Math.max(0,...values),lo=Math.min(0,...values),span=hi-lo||1;
   const y=v=>3+(hi-v)/span*34,zero=y(0),g=canvas.getContext('2d');
   const gradient=g.createLinearGradient(0,0,0,40),fraction=zero/40;
   gradient.addColorStop(0,'#97cd67');gradient.addColorStop(fraction,'#97cd67');
   gradient.addColorStop(fraction,'#e88770');gradient.addColorStop(1,'#e88770');
   g.strokeStyle='#45445c';g.beginPath();g.moveTo(0,zero);g.lineTo(88,zero);g.stroke();
   g.strokeStyle=gradient;g.lineWidth=2.6;g.beginPath();
   values.forEach((v,i)=>{const x=2+i/48*84;if(i)g.lineTo(x,y(v));else g.moveTo(x,y(v))});g.stroke();
  }
  const r=b.getBoundingClientRect();menu.style.top=Math.max(4,r.bottom+4)+'px';menu.style.left=Math.max(8,Math.min(innerWidth-740,r.left))+'px';menu.showPopover();
 }else page(b.dataset.page)
});
$('buildMenu').onclick=handled(async e=>{const b=e.target.closest('[data-preset]');if(b){$('buildMenu').hidePopover();await preset(b.dataset.preset)}});
$('topHistory').onclick=()=>{page('build');setView('history')};
document.querySelectorAll('[data-view]').forEach(b=>b.onclick=()=>setView(b.dataset.view));
document.querySelectorAll('[data-activity]').forEach(b=>b.onclick=()=>{state.act=b.dataset.activity;activity()});
$('activityTools').onclick=e=>{if(e.target.closest('button'))activity()};$('activityTools').onchange=()=>activity();
$('activityBody').onclick=handled(async e=>{
 const b=e.target.closest('button');if(!b)return;
 if(b.dataset.symbol){await load(b.dataset.symbol);page('build')}
 if(b.dataset.article){const res=await api('article?'+qs({provider:b.dataset.provider,id:b.dataset.article}));const text=document.createElement('p');text.textContent=res.text;await dialog(b.dataset.provider+' news',text,'Close')}
});
const savedTrades=bindSavedTrades({
 api,esc,dialog,handled,openSaved,message,isVisible:()=>state.page==='saved',mode:()=>state.mode,
 onDeleted(id){if(state.savedId===id){attachSaved(null);draft()}},
 onSaved(item,result){if(state.savedId===item.id){state.name=result.name;state.version=result.version;draft()}}
});
const optionsHistory=bindOptionsHistory({
 api,isVisible:()=>state.page==='saved',
 openSavedById:async id=>{
  const item=(await api('library')).find(row=>row.id===id);
  if(!item)throw Error('This saved trade is no longer in the library.');
  if(state.page==='saved'&&$('savedShow').value==='archived')await openSaved(item);
 }
});
$('export').onclick=handled(async()=>{const items=await api('library'),url=URL.createObjectURL(new Blob([JSON.stringify({schema:1,strategies:items.map(s=>({name:s.name,document:s.document}))},null,2)],{type:'application/json'})),a=document.createElement('a');a.href=url;a.download='options-lab-strategies.json';a.click();setTimeout(()=>URL.revokeObjectURL(url),1000)});
$('import').onchange=handled(async e=>{
 const file=e.target.files[0];if(!file)return;if(file.size>2e6)throw Error('Choose a library export smaller than 2 MB.');
 const bundle=JSON.parse(await file.text());if(bundle.schema!==1||!Array.isArray(bundle.strategies)||bundle.strategies.length>100)throw Error('Choose an Options Lab strategy export with up to 100 strategies.');
 const res=await api('import',{strategies:bundle.strategies});e.target.value='';await savedTrades.reload();message('Imported '+res.count+' strategies.');
});
// Chart preferences belong to the tab and series. Shared links start from their own strategy.
const chartSessionKey='optionslab.chart.v1';
const chartSeries=()=>[state.info?.conId,state.root,state.expiry].join('|');
function rememberChart(){
 if(!state.ready||!state.book||location.hash.startsWith('#strategy='))return;
 const snapshot={series:chartSeries(),view:state.view,unit:state.unit,center:state.center,active:state.active,
  range:manualRange,ceiling:manualCeiling,iv:Number($('iv').value),rate:Number($('rate').value),
  historyType:$('historyType').value,historyWindow:$('historyWindow').value,events:$('showEvents').checked,
  showGreeks:$('statTrack').classList.contains('show-greeks'),
  target:readTarget(),horizon:Number($('horizon').value),date:pickedDate};
 try{sessionStorage.setItem(chartSessionKey,JSON.stringify(snapshot))}catch{}
}
function restoreChart(){
 if(!state.book||location.hash.startsWith('#strategy='))return;
 let v;try{v=JSON.parse(sessionStorage.getItem(chartSessionKey))}catch{return}
 if(!v||v.series!==chartSeries())return;
 const selected=[...document.querySelectorAll('[data-unit]')].find(b=>b.dataset.unit===v.unit);
 if(selected){
  state.unit=v.unit;
  for(const b of document.querySelectorAll('[data-unit]')){
   b.classList.toggle('active',b===selected);b.setAttribute('aria-pressed',String(b===selected));
  }
 }
 if(valid(v.range)&&valid(v.ceiling)&&v.range>=1&&v.ceiling>=v.range){rangeSeries=chartSeries();manualRange=v.range;manualCeiling=v.ceiling}
 if(valid(v.iv)&&v.iv>=.1&&v.iv<=3)$('iv').value=String(v.iv);
 if(valid(v.rate)&&v.rate>=-5&&v.rate<=50)$('rate').value=String(v.rate);
 if(valid(v.target))$('targetPrice').value=String(v.target);
 if(valid(v.horizon)&&v.horizon>=0&&v.horizon<=100)$('horizon').value=String(v.horizon);
 if(valid(v.date?.expiry)&&valid(v.date?.time))pickedDate=v.date;
 if(Number.isInteger(v.active)&&state.legs[v.active])state.active=v.active;
 if(valid(v.center))state.center=nearest(state.book,v.center).strike;
 for(const id of ['historyType','historyWindow']){
  if([...$(id).options].some(option=>option.value===v[id]))$(id).value=v[id];
 }
 if(typeof v.events==='boolean')$('showEvents').checked=v.events;
 if(typeof v.showGreeks==='boolean'&&$('statTrack').classList.contains('show-greeks')!==v.showGreeks)changeStatPage();
 structure();setView(['graph','table','history'].includes(v.view)?v.view:'graph');
}
window.addEventListener('pagehide',rememberChart);
async function start(){
 let saved=null,localDraft=false;
 try{
  if(location.hash.startsWith('#strategy=')&&location.hash.length<40000){
   const bytes=Uint8Array.from(atob(location.hash.slice(10).replaceAll('-','+').replaceAll('_','/')),c=>c.charCodeAt(0));
   const shared=JSON.parse(new TextDecoder().decode(bytes));
   if(shared.schema===1&&typeof shared.symbol==='string'&&shared.legs?.length>0&&shared.legs.length<=16&&shared.legs.every(l=>
     ['option','stock'].includes(l.kind)&&Number.isInteger(l.qty)&&l.qty!==0&&Math.abs(l.qty)<=100000&&
     (l.entry===null||valid(l.entry)&&l.entry>=0)&& (l.kind==='stock'||['C','P'].includes(l.right)&&valid(l.strike)&&/^\d{8}$/.test(l.expiry))))saved=shared;
  }else{saved=JSON.parse(localStorage.getItem('optionslab.draft.v1'));localDraft=true}
 }catch{}
 let savedItem=null;
 if(localDraft&&saved?.savedTrade){
  try{savedItem=(await api('library')).find(s=>s.id===saved.savedTrade.id&&s.version===saved.savedTrade.version&&s.document.symbol.trim().toUpperCase()===saved.symbol.trim().toUpperCase())}catch{}
 }
 try{
  await load(saved?.symbol||'SPX',saved,false,savedItem);
  if(localDraft&&saved?.savedTrade&&!savedItem)message('The saved version is unavailable. Your edits are open as a separate draft.');
 }catch(e){if(saved){try{await load('SPX');message('The prior browser draft could not be reopened. Loaded the current SPX chain.')}catch{}}}
}
let startingBuilder=null;
function startBuilder(){
 if(!startingBuilder)startingBuilder=start().then(restoreChart).catch(e=>message(e.message)).finally(()=>{startingBuilder=null});
 return startingBuilder;
}
function savedListHash(){
 return {active:'#saved',archived:'#saved/closed',all:'#saved/all'}[$('savedShow').value];
}
function openSavedLocation(){
 const filter={'#saved':'active','#saved/closed':'archived','#saved/all':'all'}[location.hash];
 if(!filter)return false;
 $('savedShow').value=filter;
 page('saved');
 return true;
}
$('savedShow').addEventListener('change',()=>{
 if(state.page==='saved')history.replaceState(null,'',savedListHash());
});
if(!openSavedLocation())startBuilder();
window.addEventListener('hashchange',openSavedLocation);
setInterval(tick,800);setInterval(()=>{if(state.ready&&state.page==='activity'&&state.act==='updates')activity()},2400);

import {expiryMs, remainingQty} from './risk.js';
import {bindSavedActions} from './saved-actions.js';

const $ = id => document.getElementById(id);
const dates = new Intl.DateTimeFormat('en-US', {timeZone:'America/New_York',year:'numeric',
 month:'short',day:'numeric',hour:'numeric',minute:'2-digit'});
const easternDay = new Intl.DateTimeFormat('sv-SE', {timeZone:'America/New_York',year:'numeric',month:'2-digit',day:'2-digit'});
const symbolOf = item => item.document.symbol.split('#')[0];
function groupOf(item) {
 const value = item.document.libraryGroup ?? item.document.source?.group;
 return typeof value === 'string' && value !== 'All' ? value : '';
}
function createdText(item) {
 return item.document.source?.createdAtText || (Number.isFinite(item.created) ? dates.format(item.created) : '');
}
const monthIndex = new Map('Jan Feb Mar Apr May Jun Jul Aug Sep Oct Nov Dec'.split(' ').map((m,i)=>[m,i]));
function createdSort(item) {
 // Compare imported and local Eastern wall-clock labels without browser-specific date parsing.
 const parts=/^(\w{3}) (\d{1,2}), (\d{4}),? (\d{1,2}):(\d{2}) (AM|PM)$/i.exec(createdText(item).replace(/\s+/g,' '));
 if (!parts || !monthIndex.has(parts[1])) return 0;
 const hour=Number(parts[4])%12+(parts[6]==='PM'?12:0);
 return Date.UTC(Number(parts[3]),monthIndex.get(parts[1]),Number(parts[2]),hour,Number(parts[5]));
}
function openExpiry(item) {
 const open = item.document.legs.filter(l => !l.excluded && remainingQty(l));
 const options = open.filter(l => l.kind === 'option' && /^\d{8}$/.test(l.expiry)).map(l => l.expiry);
 return options.length ? options.sort()[0] : '';
}
function expiryLabel(expiry) {
 if (!expiry) return null;
 const year = expiry.slice(0,4), month = expiry.slice(4,6), day = expiry.slice(6,8);
 const distance = Math.round((Date.parse(year+'-'+month+'-'+day) - Date.parse(easternDay.format(Date.now()))) / 86400000);
 if (!Number.isFinite(distance)) return null;
 return {distance:distance >= 365 ? (distance/365.25).toFixed(1)+'y' : distance+'d', date:Number(month)+'/'+Number(day)+'/'+year.slice(2)};
}
function statusOf(item,snapshot) {
 if (snapshot?.status) return snapshot.status;
 const included = item.document.legs.filter(l=>!l.excluded);
 if (!included.length) return 'excluded';
 const open = included.filter(l=>remainingQty(l));
 if (open.length) return open.every(l=>l.kind==='option' && expiryMs(l)!=null && expiryMs(l)<=Date.now()) ? 'expired' : 'open';
 return item.document.source?.status==='expired' ? 'expired' : 'closed';
}
const archived = status => status === 'closed' || status === 'expired';
function closedText(item,status) {
 if (item.document.source?.closedAtText) return item.document.source.closedAtText;
 const fills = item.document.legs.filter(l=>!l.excluded).flatMap(l=>l.closes ?? []);
 const last = fills.length ? Math.max(...fills.map(f=>f.at ?? f.confirmedClosedBy ?? 0)) : null;
 if (status==='closed' && last) return (fills.some(f=>f.confirmedClosedBy) ? 'Closed by ' : 'Closed ')+'('+dates.format(last)+')';
 const expiry = item.document.legs.filter(l=>!l.excluded && l.kind==='option').map(l=>expiryMs(l)).filter(Number.isFinite).sort((a,b)=>b-a)[0];
 return status==='expired' && expiry ? 'Expired ('+dates.format(expiry)+')' : (status==='expired'?'Expired':'Closed');
}
const currencyFormats = new Map();
function amount(value,currency) {
 if (!Number.isFinite(value)) return '—';
 if (!currencyFormats.has(currency)) {
  try { currencyFormats.set(currency,new Intl.NumberFormat('en-US',{style:'currency',currency,minimumFractionDigits:0,maximumFractionDigits:2,signDisplay:'exceptZero'})); }
  catch { currencyFormats.set(currency,new Intl.NumberFormat('en-US',{maximumFractionDigits:2,signDisplay:'exceptZero'})); }
 }
 return currencyFormats.get(currency).format(Math.abs(value)<.005?0:value);
}
const pctFormat = new Intl.NumberFormat('en-US',{maximumFractionDigits:1,signDisplay:'exceptZero'});
const pctLarge = new Intl.NumberFormat('en-US',{maximumFractionDigits:0,signDisplay:'exceptZero'});
function percent(value) {
 return Number.isFinite(value) ? ' ('+(Math.abs(value)<10?pctFormat:pctLarge).format(value)+'%)' : '';
}
const sessionDates = new Intl.DateTimeFormat('en-US',{timeZone:'UTC',weekday:'short',month:'short',day:'numeric'});
function sessionDate(value) {
 if (!/^\d{4}-\d{2}-\d{2}$/.test(value || '')) return '';
 const time=Date.parse(value+'T12:00:00Z');
 return Number.isFinite(time)?sessionDates.format(time):'';
}
function dayDescription(row) {
 const period=row?.dayPeriod;
 if (period?.mode!=='closed') return row?.daySource || '';
 const from=sessionDate(period.priorDate), to=sessionDate(period.date);
 const attribution=period.attribution==='broker'&&period.verified===true?'Broker-verified session return':
  period.attribution==='model'?'Saved-position model':'';
 const description=[from && to ? 'Last trading day · '+from+' close to '+to+' close' : 'Last trading day',attribution,row.daySource];
 if (period.estimated && Number.isFinite(row.dayPnl)) description.push('Opening or closing fill times are incomplete.');
 return description.filter(Boolean).join(' · ');
}
const gear = '<svg aria-hidden="true" viewBox="0 0 24 24"><g fill="none" stroke="currentColor">' +
 '<circle cx="12" cy="12" r="6" stroke-width="4"/><path stroke-width="3.2" stroke-linecap="round" ' +
 'd="M12 3v2m0 14v2M3 12h2m14 0h2M5.6 5.6l1.5 1.5m9.8 9.8l1.5 1.5M5.6 18.4l1.5-1.5m9.8-9.8l1.5-1.5"/></g></svg>';

export function bindSavedTrades({api,esc,dialog,handled,openSaved,onDeleted,onSaved,mode,isVisible,message}) {
 let items=[], rows={}, version=0, timer, error='', active=false, fingerprint='', envelope=null;
 const snap = id => rows[id];
 const groupNames = () => [...new Set(items.map(groupOf).filter(Boolean))].sort((a,b)=>a.localeCompare(b));
 function visibleItems() {
  const group=$('savedGroup').value, show=$('savedShow').value, sort=$('savedSort').value;
  const displayed=items.filter(item=>{
   if (group && groupOf(item)!==group) return false;
   const status=statusOf(item,snap(item.id));
   return show==='all' || archived(status)===(show==='archived');
  });
  return displayed.sort((a,b)=>{
   let order=0;
   if (sort==='symbol') order=symbolOf(a).localeCompare(symbolOf(b));
   if (sort==='name') order=a.name.localeCompare(b.name);
   if (sort==='expiry') order=(openExpiry(a)||a.document.expiry||'99999999').localeCompare(openExpiry(b)||b.document.expiry||'99999999');
   return order || createdSort(b)-createdSort(a) || a.name.localeCompare(b.name) || a.id.localeCompare(b.id);
  });
 }
 const actions=bindSavedActions({api,dialog,handled,openSaved,onDeleted,onSaved,reload,draw,dayDescription,
  getItem:id=>items.find(item=>item.id===id),getSnapshot:snap,getVisibleItems:visibleItems,getGroups:groupNames});
 function markup(list,archivedOnly) {
  if (!list.length) return '<p class="saved-empty">'+(items.length?'No trades match these filters.':'Save a strategy in the builder to track its returns here.')+'</p>';
  const editing=actions.editing();
  const headers=['Name','Total Return',...(archivedOnly?[]:["Today's Return"]),'Created At',archivedOnly?'Expired / Closed Date':$('savedShow').value==='all'?'Expiration / Close':'Days Until Expiration'];
  let html='<table class="saved-table"><thead><tr>';
  if (editing) html+='<th><input type="checkbox" id="savedSelectAll" aria-label="Select all visible trades"></th>';
  html+=headers.map(h=>'<th scope="col">'+h+(h==="Today's Return"?'<small id="savedDayDate" class="source-marker" hidden></small>':'')+'</th>').join('')+'</tr></thead><tbody>';
  let lastSymbol=null;
  for (const item of list) {
   const id=esc(item.id), name=esc(item.name), sym=symbolOf(item), status=statusOf(item,snap(item.id));
   if ($('savedSort').value==='symbol' && lastSymbol!==sym) {
    html+='<tr class="saved-symbol"><td colspan="'+(headers.length+Number(editing))+'">'+esc(sym)+'</td></tr>';
    lastSymbol=sym;
   }
   html+='<tr data-trade-id="'+id+'">';
   if (editing) html+='<td><input type="checkbox" data-select-trade="'+id+'" aria-label="Select '+name+'"></td>';
   html+='<td class="saved-name-cell"><a href="#saved" class="saved-name" data-open="'+id+'">'+name+'</a>';
   if (!editing) html+='<button class="saved-gear" data-manage="'+id+'" aria-label="Manage '+name+'" title="Manage strategy">'+gear+'</button>';
   html+='</td><td data-field="total">—</td>'+(archivedOnly?'':'<td data-field="day">—</td>');
   html+='<td title="'+(createdText(item)?'Eastern Time':'Original creation time unavailable')+'">'+esc(createdText(item)||'—')+'</td>';
   const exp=openExpiry(item), label=expiryLabel(exp);
   const end=archived(status)?esc(closedText(item,status)):label?'<strong>'+esc(label.distance)+'</strong> ('+esc(label.date)+')':'—';
   html+='<td title="'+(archived(status)?'Eastern Time':'Nearest open option expiration')+'">'+end+'</td></tr>';
  }
  return html+'</tbody></table>';
 }
 function paintCell(cell,value,rate,currency,tooltip,tag) {
  if (!cell) return;
  const formatted=amount(value,currency), pc=percent(rate), key=[formatted,pc,tag].join('|');
  if (cell.dataset.display!==key) {
   const bold=document.createElement('strong'); bold.textContent=formatted;
   cell.replaceChildren(bold,document.createTextNode(pc));
   if (tag) {const small=document.createElement('small');small.className='source-marker';small.textContent=tag;cell.append(small)}
   cell.dataset.display=key;
  }
  cell.className=!Number.isFinite(value)?'return-missing':value<-.005?'return-loss':value>=.005?'return-gain':'';
  cell.title=tooltip || '';
 }
 function draw() {
  if (!active || !isVisible()) return;
  const list=visibleItems(), archivedOnly=$('savedShow').value==='archived';
  const key=JSON.stringify([actions.editing(),$('savedShow').value,$('savedSort').value,easternDay.format(Date.now()),list.map(s=>[s.id,s.version,statusOf(s,snap(s.id))])]);
  if (key!==fingerprint) {
   $('library').innerHTML=markup(list,archivedOnly);fingerprint=key;
  }
  actions.syncSelection();
  const displayed = new Map(list.map(x=>[x.id,x]));
  const activeRows=list.filter(i=>statusOf(i,snap(i.id))==='open').map(i=>snap(i.id));
  const sources=[...new Set(activeRows.map(s=>s?.source || (error?'TWS unavailable':'Waiting for TWS')))];
  const firstPeriod=activeRows[0]?.dayPeriod;
  const sameSession=firstPeriod?.mode==='closed' && activeRows.every(s=>
   s?.dayPeriod?.mode==='closed' && s.dayPeriod.date===firstPeriod.date && s.dayPeriod.priorDate===firstPeriod.priorDate);
  const commonDate=sameSession ? sessionDate(firstPeriod.date) : '';
  const header=$('savedDayDate');
  if (header) {
   header.hidden=!commonDate;
   header.textContent=commonDate?'Last session · '+commonDate:'';
  }
  for (const tr of $('library').querySelectorAll('tr[data-trade-id]')) {
   const id=tr.dataset.tradeId, item=displayed.get(id), s=snap(id);
   const why=s?.source || error || 'Waiting for TWS prices';
   const totalTitle=[why,s?.detail,Number.isFinite(s?.receivedAt)?'Received '+dates.format(s.receivedAt)+' ET':''].filter(Boolean).join(' · ');
   const tag=sources.length>1 && statusOf(item,s)==='open'?why:'';
   paintCell(tr.querySelector('[data-field="total"]'),s?.totalPnl,s?.totalPct,s?.currency,totalTitle,tag);
   const period=s?.dayPeriod;
   let dayTag='';
   if (period?.mode==='closed') {
    let detail='';
    if (Number.isFinite(s.dayPnl)) {
     if(period.attribution==='broker'&&period.verified===true)detail=period.accountStatus==='lastVerifiedOffline'?'Broker-verified · offline':'Broker-verified';
     else if(period.estimated)detail='Current-position estimate';
     else if(period.attribution==='model')detail='Saved-position model';
    }
    if (!Number.isFinite(s.dayPnl)) detail=period.loading?'Loading closes…':'Unavailable';
    dayTag=[commonDate?'':sessionDate(period.date),detail].filter(Boolean).join(' · ');
   }
   paintCell(tr.querySelector('[data-field="day"]'),s?.dayPnl,s?.dayPct,s?.currency,dayDescription(s) || (s?.dayPnl==null ? s?.detail : '') || why,dayTag);
  }
  $('savedFeed').textContent=error?'TWS pricing unavailable · '+error:!items.length?'':archivedOnly?'Closed trades use recorded fills.':sources.length?'TWS · '+sources.join(' / ')+' · Updates automatically':'Recorded fills';
  if (!error && commonDate) {
   $('savedFeed').textContent='TWS · Total return uses '+sources.join(' / ').toLowerCase()+' · Today’s Return uses the last completed session · Updates automatically';
  }
  if (typeof envelope?.connected==='boolean' || error) {
   const connected=!error && envelope?.connected;
   $('connection').textContent=connected?'TWS connected':'TWS disconnected';
   $('connection').className='pill '+(connected?'live':'waiting');
  }
 }
 function stop() {
  version++;active=false;clearTimeout(timer);actions.resetSelection();
  if ($('savedTradeDetails').open) $('savedTradeDetails').close();
 }
 async function poll(epoch) {
  if (!active || version!==epoch) return;
  try {
   const data=await api('saved-snapshots?mode='+mode());
   if (!active || version!==epoch) return;
   if (!data.rows || typeof data.rows!=='object') throw Error('No valuation snapshot was returned.');
   if (items.length!==Object.keys(data.rows).length || items.some(s=>data.rows[s.id]?.version!==s.version)) {
    // Another tab may have saved a trade while pricing was in flight.
    await readItems(epoch);
    if (!active || version!==epoch) return;
   }
   rows=Object.fromEntries(items.filter(i=>data.rows[i.id]?.version===i.version).map(i=>[i.id,data.rows[i.id]]));
   envelope=data; error='';
  } catch (e) {
   if (!active || version!==epoch) return;
   // A closed position's confirmed realized result does not rely on TWS.
   rows=Object.fromEntries(Object.entries(rows)
    .filter(([,r])=>r.status==='closed'||(r.status==='expired' && r.source==='Realized'))
    .map(([id,r])=>{
     if(r.dayPeriod?.attribution!=='broker') return [id,r];
     const {version,status,currency,basis,marketValue,totalPnl,totalPct,source,markSource,feed}=r;
     return [id,{id,version,status,currency,basis,marketValue,totalPnl,totalPct,source,markSource,feed,
      dayPnl:r.modeledDayPnl,dayPct:r.modeledDayPct,daySource:r.modeledDaySource,
      dayPeriod:{...r.modeledDayPeriod,attribution:'model',verified:false}}];
    }));
   envelope=null;error=e.message;
  }
  draw();
  if (active && version===epoch) timer=setTimeout(()=>poll(epoch),2000);
 }
 async function readItems(epoch) {
  const fresh=await api('library');
  if (!active || version!==epoch) return;
  items=fresh;
  const current=$('savedGroup').value, groups=groupNames();
  $('savedGroup').replaceChildren(new Option('All',''),...groups.map(g=>new Option(g,g)));
  if (groups.includes(current)) $('savedGroup').value=current;
 }
 async function reload() {
  const epoch=++version;active=true;clearTimeout(timer);fingerprint='';
  try {await readItems(epoch)}
  catch (e) {
   if (version===epoch && active) {error=e.message;rows={};draw();message('Could not load saved trades. '+e.message);timer=setTimeout(()=>reload().catch(message),3500)}
   return;
  }
  if (version!==epoch || !active) return;
  draw();await poll(epoch);
 }
 for (const id of ['savedGroup','savedSort','savedShow']) $(id).addEventListener('change',()=>{actions.resetSelection();draw()});
 $('library').addEventListener('click',event=>{
  const link=event.target.closest('[data-open]');if (!link) return;
  event.preventDefault();
  const item=items.find(i=>i.id===link.dataset.open);
  if (item) handled(()=>openSaved(item))(event);
 });
 $('savedImportButton').onclick=()=>$('import').click();
 return {reload,stop};
}

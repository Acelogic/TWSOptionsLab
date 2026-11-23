import {bindHistoryGrouping} from './history-grouping.js';
// The execution ledger is independent of saved strategies. Multiple partial
// fills for the same contract share a contract ID and remain separate rows.
const eastern='America/New_York';
const dayKey=new Intl.DateTimeFormat('sv-SE',{timeZone:eastern,year:'numeric',month:'2-digit',day:'2-digit'});
const dateText=new Intl.DateTimeFormat('en-US',{timeZone:eastern,year:'numeric',month:'short',day:'numeric'});
const clockText=new Intl.DateTimeFormat('en-US',{timeZone:eastern,hour:'numeric',minute:'2-digit',second:'2-digit',timeZoneName:'short'});
const dateOnly=new Intl.DateTimeFormat('en-US',{timeZone:'UTC',year:'numeric',month:'short',day:'numeric'});
const quantity=new Intl.NumberFormat('en-US',{maximumFractionDigits:8});
const reportedPrice=new Intl.NumberFormat('en-US',{minimumFractionDigits:2,maximumFractionDigits:8});
const cashFormat=new Intl.NumberFormat('en-US',{minimumFractionDigits:2,maximumFractionDigits:2});
const goodTime=value=>Number.isFinite(value)&&value>0&&Number.isFinite(new Date(value).getTime());
const signedSide={BUY:'Buy',SELL:'Sell'};
const lifecycleActions=new Map([['expiration','Expired'],['assignment','Assigned'],['exercise','Exercised']]);
const contractState={closed:'Closed',expired:'Expired',open:'Open',unknown:'Unknown'};
const columns=['Time (ET)','Contract','Action','Quantity','Reported price','Commission','Broker status','Saved trade match'];

function element(tag,text,cls){
 const el=document.createElement(tag);
 if(text!=null)el.textContent=text;
 if(cls)el.className=cls;
 return el;
}
function calendarDate(value){
 const iso=String(value??'').replace(/^(\d{4})(\d{2})(\d{2})$/,'$1-$2-$3');
 if(!/^\d{4}-\d{2}-\d{2}$/.test(iso))return '';
 const stamp=Date.parse(iso+'T12:00:00Z');
 return Number.isFinite(stamp)&&new Date(stamp).toISOString().startsWith(iso)?dateOnly.format(stamp):'';
}
function price(value,currency){
 return Number.isFinite(value)?reportedPrice.format(value)+(currency?' '+currency:''):'—';
}
function cash(value,currency){
 return Number.isFinite(value)?cashFormat.format(Math.abs(value)<0.005?0:value)+(currency?' '+currency:''):'—';
}
function cashCell(value,currency,signed=false){
 const text=cash(value,currency),prefix=signed&&Number.isFinite(value)&&value>=0.005?'+':'';
 const cell=element('td',prefix+text,'numeric');
 if(Number.isFinite(value)&&price(value,currency)!==text)cell.title=price(value,currency);
 return cell;
}
function coverageText(coverage){
 if(!coverage)return '';
 const source=coverage.source||'IBKR',from=calendarDate(coverage.from),to=calendarDate(coverage.to);
 const period=from&&to?from+' – '+to:from?'From '+from:to?'Through '+to:'Date range unconfirmed';
 const completeness=coverage.complete===true&&from&&to?'Complete for reported range':'Partial or unconfirmed coverage';
 const update=goodTime(coverage.asOf)?'Updated '+dateText.format(coverage.asOf)+', '+clockText.format(coverage.asOf):'';
 return [source,period,completeness,coverage.message,update].filter(Boolean).join(' · ');
}
function fillContract(fill){
 const cell=element('td'),right={C:'Call',P:'Put'}[fill.right],strike=Number.isFinite(fill.strike)?quantity.format(fill.strike):'';
 cell.append(element('strong',[fill.symbol||fill.localSymbol||'Contract',strike,right].filter(Boolean).join(' ')));
 const expiry=calendarDate(fill.expiry);
 const detail=[expiry,fill.secType==='FOP'?'Futures option':''].filter(Boolean).join(' · ');
 if(detail)cell.append(element('small',detail));
 cell.title=[fill.localSymbol,fill.conId?'IBKR contract '+fill.conId:'',Number.isFinite(fill.multiplier)?'Multiplier '+fill.multiplier:''].filter(Boolean).join(' · ');
 return cell;
}
function matchCell(fill){
 const cell=element('td'),matches=Array.isArray(fill.matches)?fill.matches:[];
 const itemLink=match=>{
  if(!match.id)return element('span',match.name||'Saved trade');
  const b=element('button',match.name||'View saved trade','saved-link');b.type='button';b.dataset.historyOpen=match.id;
  b.title='View saved trade with the same option contract';return b;
 };
 cell.title='Matches identify saved trades with the same option contract.';
 if(fill.matchStatus==='matched'&&matches.length===1){
  cell.append(element('small','Matched'),itemLink(matches[0]));
 }else if(fill.matchStatus==='ambiguous'||matches.length>1){
  const details=element('details');details.append(element('summary','Ambiguous'+(matches.length?' ('+matches.length+')':'')));
  for(const match of matches){const row=element('div');row.append(itemLink(match));details.append(row)}
  cell.append(details);
 }else cell.textContent=fill.matchStatus==='matched'?'Matched':fill.matchStatus==='unmatched'?'Unmatched':'Unknown';
 return cell;
}
function fillRow(fill,grouping){
 const row=element('tr');if(fill.id!=null)row.dataset.execution=fill.id;
 if(grouping?.editing())row.append(grouping.fillCell(fill));
 const time=element('td');
 if(goodTime(fill.at))time.append(element('span',dateText.format(fill.at)),element('small',clockText.format(fill.at)));
 else time.textContent='Time unavailable';
 const direction=String(fill.side??'').toUpperCase(),signed=signedSide[direction];
 const size=signed&&Number.isFinite(fill.qty)&&fill.qty>0?(direction==='SELL'?'−':'+')+quantity.format(fill.qty):'—';
 const commission=cashCell(fill.commission,fill.commissionCurrency);
 if(!Number.isFinite(fill.commission))commission.title='Commission unavailable from the broker.';
 else if(!fill.commissionCurrency)commission.title='Commission currency unavailable from the broker.';
 const lifecycle=lifecycleActions.get(fill.eventType);
 const action=element('td',lifecycle||signed||'—',lifecycle?'':direction==='BUY'?'buy':direction==='SELL'?'sell':'');
 if(lifecycle)action.title='IBKR Activity Flex booking'+(signed?' · broker side '+signed:'');
 row.append(time,fillContract(fill),action,
  element('td',size,'numeric'),element('td',price(fill.price,fill.currency),'numeric'),commission,
  element('td',contractState[fill.positionStatus]||'Unknown'),matchCell(fill));
 return row;
}

const tradeStates={closed:'Closed',open:'Open',incomplete:'Incomplete history'};
function historyTime(at){
 const cell=element('td');
 if(goodTime(at))cell.append(element('span',dateText.format(at)),element('small',clockText.format(at)));
 else cell.textContent='—';
 return cell;
}

function returnCell(amount,currency,reason=''){
 const cell=cashCell(amount,currency,true);
 if(Number.isFinite(amount)&&amount!==0)cell.classList.add(amount>0?'buy':'sell');
 if(reason&&!Number.isFinite(amount))cell.append(element('small',reason,'history-trade-missing'));
 return cell;
}

function auditTable(label,headings){
 const container=element('div',null,'history-group-audit'),table=element('table');
 table.setAttribute('aria-label',label);
 const tr=table.createTHead().insertRow();
 for(const heading of headings){const th=element('th',heading);th.scope='col';tr.append(th)}
 const body=table.createTBody();container.append(table);return {container,body};
}

function groupDetail(trade,grouping){
 const row=element('tr'),detail=element('td',null,'history-group-detail');detail.colSpan=grouping?.editing()?6:5;row.append(detail);
 if(Number.isFinite(trade.brokerRealizedPnl)){
  const fifo=element('p','IBKR reported FIFO return · '+cash(trade.brokerRealizedPnl,trade.currency),'history-source');
  fifo.title=price(trade.brokerRealizedPnl,trade.currency);detail.append(fifo);
 }
 for(const value of [trade.groupSource,trade.chronologyNote,trade.pnlSource,trade.pnlReason])if(value)detail.append(element('p',String(value),'history-source'));
 const legs=Array.isArray(trade.legs)?trade.legs:[];
 const contracts=new Map(legs.map(leg=>[leg.conId,leg]));
 if(legs.length){
  detail.append(element('h3','Legs'));
  const brokerReturns=legs.some(leg=>Number.isFinite(leg.brokerRealizedPnl));
  const headings=['Contract','Direction','Opened','Closed','Remaining','Multiplier','Realized return'];
  if(brokerReturns)headings.push('IBKR FIFO return');
  const {container,body}=auditTable('Grouped option legs',headings);
  for(const leg of legs){
   const tr=body.insertRow(),contract=element('td',leg.localSymbol||trade.symbol||'—');
   const terms=[calendarDate(leg.expiry),Number.isFinite(leg.strike)?quantity.format(leg.strike):'',leg.right==='C'?'Call':leg.right==='P'?'Put':''].filter(Boolean);
   if(terms.length)contract.append(element('small',terms.join(' · ')));
   const direction=leg.direction==='long'?'Long':leg.direction==='short'?'Short':'Unknown';
   tr.append(contract,element('td',direction));
   for(const qty of [leg.openedQty,leg.closedQty,leg.remainingQty,leg.multiplier])tr.append(element('td',Number.isFinite(qty)?quantity.format(qty):'—','numeric'));
   tr.append(returnCell(leg.netRealizedPnl,leg.currency||trade.currency));
   if(brokerReturns)tr.append(returnCell(leg.brokerRealizedPnl,leg.currency||trade.currency));
  }
  detail.append(container);
 }
 const fills=Array.isArray(trade.fills)?trade.fills:[];
 if(fills.length){
  const totals=new Map();let missing=0;
  for(const fill of fills){
   if(Number.isFinite(fill.commission)&&fill.commissionCurrency)totals.set(fill.commissionCurrency,(totals.get(fill.commissionCurrency)||0)+fill.commission);
   else missing++;
  }
  const amounts=[...totals].map(([currency,amount])=>cash(amount,currency));
  if(missing)amounts.push(missing+' '+(missing===1?'entry':'entries')+' with unavailable commission or currency');
  const commissionTotal=element('p','Commissions on listed activity · '+amounts.join(' · '));
  commissionTotal.title=[...totals].map(([currency,amount])=>price(amount,currency)).join(' · ');
  detail.append(commissionTotal);
  detail.append(element('h3','Executions & lifecycle'));
  const brokerReturns=fills.some(f=>Number.isFinite(f.brokerRealizedPnl));
  const headings=['Time (ET)','Contract','Action','Role','Quantity','Reported price','Commission','Realized return'];
  if(brokerReturns)headings.push('IBKR FIFO return');
  headings.push('Broker ID');
  if(grouping?.editing())headings.unshift('Select');
  const {container,body}=auditTable('Activity allocated to this trade',headings);
  for(const f of fills){
   const tr=body.insertRow(),direction=signedSide[f.side],action=lifecycleActions.get(f.eventType)||direction||'—';
   const signed=direction&&Number.isFinite(f.qty)?(f.side==='BUY'?'+':'−')+quantity.format(f.qty):'—';
   const fee=cashCell(f.commission,f.commissionCurrency);
   if(Number.isFinite(f.commission)&&!f.commissionCurrency)fee.append(element('small','Currency unavailable'));
   const role={open:'Opening',close:'Closing',unclassified:'Unclassified'}[f.role]||'Unclassified';
   if(grouping?.editing())tr.append(grouping.fillCell(f,trade));
   tr.append(historyTime(f.at),element('td',contracts.get(f.conId)?.localSymbol||String(f.conId??'—')),element('td',action),element('td',role),
    element('td',signed,'numeric'),element('td',price(f.price,f.currency),'numeric'),fee,returnCell(f.netRealizedPnl,f.currency));
   if(brokerReturns)tr.append(returnCell(f.brokerRealizedPnl,f.currency));
   tr.append(element('td',f.id||'—'));
  }
  detail.append(container);
 }
 if(Array.isArray(trade.matches)&&trade.matches.length){
  detail.append(element('h3','Saved trades with matching contracts'));
  const matches=matchCell(trade),links=element('div');links.append(...matches.childNodes);detail.append(links);
 }
 if(trade.manualGroupId){
  const action=grouping?.undoButton(trade);
  if(action)detail.append(action);
 }
 return row;
}

function tradeCaption(trade){
 const legs=Array.isArray(trade.legs)?trade.legs:[];
 const label=String(trade.strategyLabel||trade.label||''),prefix=trade.symbol+' ';
 const pattern=label.startsWith(prefix)?label.slice(prefix.length):label;
 if(!legs.length)return pattern;
 if(legs.length===1){
  const leg=legs[0],side=leg.direction==='long'?'Long':leg.direction==='short'?'Short':'';
  const right=leg.right==='C'?'call':leg.right==='P'?'put':'';
  return [calendarDate(leg.expiry),Number.isFinite(leg.strike)?quantity.format(leg.strike):'',right?[side,right].filter(Boolean).join(' '):pattern].filter(Boolean).join(' · ');
 }
 const expiries=[...new Set(legs.map(leg=>leg.expiry))].sort();
 const expiry=expiries.length===1?calendarDate(expiries[0]):[calendarDate(expiries[0]),calendarDate(expiries.at(-1))].filter(Boolean).join(' – ');
 const strikes=[...new Set(legs.map(leg=>leg.strike).filter(Number.isFinite))].sort((a,b)=>a-b);
 const visible=strikes.slice(0,4).map(k=>quantity.format(k)).join('/')+(strikes.length>4?'…':'');
 return [expiry,visible,pattern].filter(Boolean).join(' · ');
}
const returnFormats=new Map();
function tradeReturn(trade){
 const {netRealizedPnl:amount,currency}=trade;
 const cell=returnCell(amount,currency,trade.pnlReason);
 if(!Number.isFinite(amount)||!currency)return cell;
 if(!returnFormats.has(currency)){
  returnFormats.set(currency,new Intl.NumberFormat('en-US',{style:'currency',currency,signDisplay:'exceptZero'}));
 }
 cell.textContent=returnFormats.get(currency).format(amount);
 cell.title=price(amount,currency);
 return cell;
}
function tradeRows(trade,expanded,grouping){
 const row=element('tr');row.dataset.trade=trade.id;
 const toggle=element('button',null,'history-trade-button');toggle.type='button';toggle.dataset.tradeToggle=trade.id;
 toggle.setAttribute('aria-expanded',String(expanded.has(trade.id)));
 const name=element('span',trade.symbol||'Option trade');const caption=tradeCaption(trade);
 if(trade.manualGroupId){
  if(trade.manualName)name.append(element('small',trade.manualName,'history-personal-label'));
  if(caption)name.append(element('small',caption));
  name.append(element('small','Manually grouped spread','history-manual-source'));
 }else if(caption)name.append(element('small',caption));
 toggle.append(name);const first=element('td');first.append(toggle);
 const status=element('td',tradeStates[trade.status]||'Unknown');
 if(grouping?.editing())row.append(grouping.tradeCell(trade));
 row.append(first,historyTime(trade.openedAt),historyTime(trade.closedAt),status,tradeReturn(trade));
 const makeDetail=()=>{
  const detail=groupDetail(trade,grouping);row.after(detail);
 };
 toggle.onclick=()=>{
  if(expanded.has(trade.id)){expanded.delete(trade.id);row.nextElementSibling?.remove();toggle.setAttribute('aria-expanded','false')}
  else{expanded.add(trade.id);makeDetail();toggle.setAttribute('aria-expanded','true')}
 };
 return expanded.has(trade.id)?[row,groupDetail(trade,grouping)]:[row];
}

function spreadPreview(result,name){
 const trade=result.trade,wrap=element('div'),title=element('h3',name||trade.label||'Option spread');
 const net=element('p','Net realized P&L after fees · '+tradeReturn(trade).textContent,'history-preview-total');
 const sources=Number.isInteger(result.sourceTradeCount)?result.sourceTradeCount:result.selectionSummary?.length;
 const counts=[];
 if(Number.isInteger(sources))counts.push(sources+' source '+(sources===1?'trade':'trades'));
 if(Array.isArray(trade.legs))counts.push(trade.legs.length+' option '+(trade.legs.length===1?'leg':'legs'));
 if(Array.isArray(trade.fills))counts.push(trade.fills.length+' allocated '+(trade.fills.length===1?'record':'records'));
 wrap.append(title,net,element('p',counts.join(' · ')));
 const detail=element('div',null,'history-group-detail');detail.append(...groupDetail(trade).firstElementChild.childNodes);wrap.append(detail);
 return wrap;
}
function bindFlexImport(afterImport){
 const $=id=>document.getElementById(id),form=$('optionsFlexForm'),dialog=$('optionsFlexDialog');
 const files=$('optionsFlexFiles'),zone=$('optionsFlexZone'),verify=$('optionsFlexVerify'),date=$('optionsFlexDate'),confirm=$('optionsFlexUnfiltered');
 const open=$('optionsFlexOpen'),cancel=$('optionsFlexCancel'),submit=$('optionsFlexSubmit'),error=$('optionsFlexError'),out=$('optionsFlexResult');
 const loopback=['http:','https:'].includes(location.protocol)&&(['localhost','[::1]'].includes(location.hostname)||/^127\./.test(location.hostname));
 open.disabled=!loopback;
 open.title=loopback?'Import a local IBKR Activity Flex statement':'Flex import is available only on this computer’s loopback address.';
 const zones=Intl.supportedValuesOf?.('timeZone')??['America/New_York','America/Chicago','Europe/London','Asia/Hong_Kong','UTC'];
 for(const value of new Set(['UTC','America/New_York',...zones]))$('optionsFlexZones').append(new Option(value,value));
 let importing=false;
 function syncVerification(){
  $('optionsFlexVerification').hidden=!verify.checked;date.required=confirm.required=verify.checked;
  if(!verify.checked){date.value='';confirm.checked=false}
 }
 function showResult(data,checkedDay){
  const count=v=>Array.isArray(v)?v.length:Number.isInteger(v)?v:null;
  const parts=[];
  for(const [key,one,many] of [['statements','statement','statements'],['executions','execution','executions'],['lifecycleEvents','lifecycle event','lifecycle events'],['accounts','account','accounts']]){
   const n=count(data[key]);if(n!=null&&(key!=='lifecycleEvents'||n>0))parts.push(n+' '+(n===1?one:many));
  }
  const verified=count(data.verifiedStrategies);
  if(checkedDay&&verified!=null)parts.push(verified+' broker-verified saved '+(verified===1?'strategy':'strategies')+' for '+checkedDay);
  out.replaceChildren(element('span',parts.length?'Activity Flex import complete · '+parts.join(' · '):'Activity Flex import complete.'));
  const warnings=Array.isArray(data.warnings)?data.warnings.filter(v=>typeof v==='string'):[];
  const skipped=Array.isArray(data.skippedStrategies)?data.skippedStrategies.map(s=>[s?.name,s?.reason].filter(Boolean).join(' · ')).filter(Boolean):[];
  if(warnings.length||skipped.length){
   const details=element('details'),list=element('ul');
   details.append(element('summary',[warnings.length?warnings.length+' import '+(warnings.length===1?'notice':'notices'):'',
    skipped.length?skipped.length+' saved '+(skipped.length===1?'strategy':'strategies')+' unverified':''].filter(Boolean).join(' · ')));
   for(const line of [...warnings,...skipped])list.append(element('li',line));
   details.append(list);out.append(details);
  }
  out.hidden=false;
 }
 open.onclick=()=>{
  if(!loopback||importing)return;
  form.reset();syncVerification();error.hidden=true;dialog.showModal();
 };
 verify.onchange=syncVerification;
 cancel.onclick=()=>{if(!importing)dialog.close()};
 dialog.addEventListener('cancel',e=>{if(importing)e.preventDefault()});
 dialog.addEventListener('close',()=>{if(!dialog.open)files.value=''});
 form.addEventListener('submit',async e=>{
  e.preventDefault();
  if(importing||!loopback)return;
  const chosen=[...files.files],timezone=zone.value.trim(),verifySaved=verify.checked?date.value:null;
  error.hidden=true;
  try{
   if(!chosen.length||chosen.length>32)throw Error('Choose between one and 32 Activity Flex XML files.');
   if(verify.checked&&(!verifySaved||!confirm.checked))throw Error('Choose the trading day and confirm the reports include all assets, executions and positions.');
   try{new Intl.DateTimeFormat('en-US',{timeZone:timezone})}catch{throw Error('Enter the time zone used by these Activity Flex statements.')}
   const limit=64*1024*1024;
   if(chosen.reduce((n,f)=>n+f.size,0)>limit)throw Error('Import up to 64 MiB at once.');
   importing=true;for(const input of form.querySelectorAll('input,button'))input.disabled=true;
   submit.textContent='Importing…';
   const body=JSON.stringify({xml:await Promise.all(chosen.map(f=>f.text())),timezone,verifySaved,confirmUnfiltered:verify.checked&&confirm.checked});
   if(new Blob([body]).size>limit)throw Error('The encoded statements exceed 64 MiB. Choose fewer files.');
   // Reports contain account data. Restrict the entire request to the app's
   // loopback origin even if the HTTP handler tries to redirect it.
   const response=await fetch('/api/ibkr-flex',{method:'POST',mode:'same-origin',credentials:'same-origin',redirect:'error',cache:'no-store',
    headers:{'Content-Type':'application/json'},body});
   const result=await response.json();
   if(!response.ok||result.ok!==true)throw Error(result.error||'The Activity Flex import failed.');
   showResult(result,verifySaved);dialog.close();await afterImport();
  }catch(err){error.textContent=err?.message||String(err);error.hidden=false}
  finally{
   importing=false;for(const input of form.querySelectorAll('input,button'))input.disabled=false;
   submit.textContent='Import XML';
  }
 });
}

export function bindOptionsHistory({api,isVisible,openSavedById}){
 const $=id=>document.getElementById(id),panel=$('optionsHistoryPanel'),holder=$('optionsHistoryTable'),pages=$('optionsHistoryPages');
 const status=$('optionsHistoryStatus'),ticker=$('optionsHistoryTicker'),from=$('optionsHistoryFrom'),to=$('optionsHistoryTo');
 const contract=$('optionsHistoryContract'),clear=$('optionsHistoryClear'),refresh=$('optionsHistoryRefresh');
 const tradesButton=$('optionsHistoryTrades'),activityButton=$('optionsHistoryActivity'),tradeStatus=$('optionsHistoryTradeStatus');
 let epoch=0,timer=null,active=false,loading=false,loaded=false,refreshing=false,problem='',rows=[],trades=null,coverage=null,page=0,signature=null,view='trades';
 const expanded=new Set(),pageSize=50;
 async function reloadCurrent(){
  if(active){epoch++;loading=false;clearTimeout(timer);await load()}
 }
 function revealManual(id,scope){
  const trade=trades?.find(t=>t.manualGroupId===id&&t.selectionScope===scope);if(!trade)return null;
  const previous=view;view='trades';const index=filtered().findIndex(t=>t.id===trade.id);
  if(index<0){view=previous;return {trade,shown:false}}
  expanded.add(trade.id);page=Math.floor(index/pageSize);render();
  [...holder.querySelectorAll('tr[data-trade]')].find(r=>r.dataset.trade===trade.id)?.scrollIntoView({block:'nearest'});
  return {trade,shown:true};
 }
 const grouping=bindHistoryGrouping({api,draw:render,reload:reloadCurrent,renderPreview:spreadPreview,revealManual});

 function filtered(){
  const name=ticker.value.trim().toUpperCase();
  const grouped=view==='trades';
  return (grouped?trades||[]:rows).filter(item=>{
   if(grouped){
    if(tradeStatus.value!=='all'&&item.status!==tradeStatus.value)return false;
   }else if(contract.value==='archived'&&!['closed','expired'].includes(item.positionStatus)&&!lifecycleActions.has(item.eventType))return false;
   if(name&&!(item.symbol||item.localSymbol||'').toUpperCase().includes(name))return false;
   if(!from.value&&!to.value)return true;
   const at=grouped?(item.status==='closed'?item.closedAt:item.lastAt):item.at;
   const date=goodTime(at)?dayKey.format(at):'';
   return (!from.value||date&&date>=from.value)&&(!to.value||date&&date<=to.value);
  });
 }
 function summary(count){
  const grouped=view==='trades';
  holder.setAttribute('aria-busy',String(loading));refresh.disabled=loading;
  $('optionsHistoryCoverage').textContent=coverageText(coverage);
  $('optionsHistoryMatchNote').hidden=grouped||!count;
  const lifecycle=rows.filter(r=>lifecycleActions.has(r.eventType)).length;
  const executions=rows.length-lifecycle;
  const totals=lifecycle?' option records · '+executions+' '+(executions===1?'execution':'executions')+' · '+lifecycle+' lifecycle '+(lifecycle===1?'event':'events'):' reported option executions';
  const description=loaded?(grouped?(Array.isArray(trades)?count+' of '+trades.length+' broker '+(trades.length===1?'trade':'trades'):''):count+' of '+rows.length+totals):'';
  status.textContent=[problem,loading?'Loading options history…':'',description].filter(Boolean).join(' · ');
 }
 function syncControls(){
  const grouped=view==='trades';
  tradesButton.setAttribute('aria-pressed',String(grouped));activityButton.setAttribute('aria-pressed',String(!grouped));
  $('historyGroupRawHint').hidden=grouped||contract.value!=='archived';
  $('optionsHistoryContractLabel').hidden=grouped;$('optionsHistoryTradeStatusLabel').hidden=!grouped;
  $('optionsHistoryFromLabel').textContent=grouped?(tradeStatus.value==='closed'?'Closed from':'Close or activity from'):'Activity from';
 }
 function render(){
  syncControls();
  const grouped=view==='trades',invalid=from.value&&to.value&&from.value>to.value;
  const subset=invalid?[]:filtered();
  const narrow=Boolean(ticker.value.trim()||from.value||to.value),pageCount=Math.ceil(subset.length/pageSize);
  page=Math.min(page,Math.max(0,pageCount-1));
  clear.hidden=!narrow;
  summary(subset.length);
  pages.replaceChildren();pages.hidden=pageCount<2;
  if(!subset.length){
   let reason='';
   if(invalid)reason='Choose an end date on or after the start date.';
   else if(grouped&&loaded&&!problem){
    if(!Array.isArray(trades))reason='Grouped trade history is unavailable for this response. Choose Executions & lifecycle to inspect broker records.';
    else if(narrow)reason='No broker trades match the ticker and date filters.';
    else if(refreshing&&!trades.length)reason='TWS is retrieving recent option activity…';
    else if(tradeStatus.value==='closed'&&trades.length)reason='No trades have a confirmed close in this history. Choose All trades to inspect open positions and incomplete records.';
    else if(trades.length)reason='No trades match the selected trade status.';
    else reason='No broker trades are available for the reported coverage. Executions & lifecycle shows the original broker records.';
   }
   else if(!grouped&&rows.length&&narrow)reason='No reported option records match these filters.';
   else if(!grouped&&rows.length&&contract.value==='archived')reason='No reported option records have a confirmed expired or closed broker contract. Choose All option contracts to view the available history.';
   else if(refreshing&&!problem)reason='TWS is retrieving recent option executions…';
   else if(loaded&&!problem)reason='No option executions were reported for the available coverage.';
   holder.replaceChildren(...(reason?[element('p',reason,'options-history-empty')]:[]));return;
  }
  const table=element('table',null,'options-history-table');table.setAttribute('aria-label',grouped?'Broker option trades':'Broker option activity');
  const header=table.createTHead().insertRow();
  const headings=grouped?['Ticker / strategy','Opened (ET)','Closed (ET)','Status','Net realized P&L']:columns;
  if(grouping.editing()){const th=element('th','Select');th.scope='col';header.append(th)}
  for(const [i,title] of headings.entries()){
   const th=element('th',title,(grouped?i===4:i>=3&&i<=5)?'numeric':'');th.scope='col';
   if(title==='Net realized P&L')th.title='Realized on closed contracts after allocated entry and exit commissions. Expand for calculation details.';
   if(title==='Saved trade match')th.title='Matches identify saved trades with the same option contract.';
   header.append(th);
  }
  const body=table.createTBody();
  for(const item of subset.slice(page*pageSize,(page+1)*pageSize))body.append(...(grouped?tradeRows(item,expanded,grouping):[fillRow(item,grouping)]));
  holder.replaceChildren(table);
  if(pageCount>1){
   const prev=element('button','Previous'),next=element('button','Next');prev.type=next.type='button';
   prev.disabled=page===0;next.disabled=page===pageCount-1;
   prev.onclick=()=>{page--;render()};next.onclick=()=>{page++;render()};
   pages.append(prev,element('span','Page '+(page+1)+' of '+pageCount),next);
  }
 }
 async function load(){
  if(!active||loading)return;
  const serial=epoch;loading=true;problem='';
  refresh.disabled=true;clearTimeout(timer);
  if(!loaded)render();
  try{
   const data=await api('options-history');
   if(serial!==epoch||!active)return;
   if(!Array.isArray(data.rows))throw Error('The execution ledger returned an invalid response.');
   const available=data.status==='ok';
   if(grouping.updateData(data))signature=null;
   refreshing=available&&data.accountVerified!==false&&data.refreshing===true;
   if(data.accountVerified===false){
    rows=[];trades=null;expanded.clear();coverage=data.coverage??null;loaded=true;
    problem='The current broker account scope is unverified. Execution history is unavailable.';
   }else if(available||data.rows.length||data.trades?.length||!rows.length&&!trades?.length){
    rows=data.rows.filter(fill=>fill&&['OPT','FOP'].includes(fill.secType)).sort((a,b)=>(goodTime(b.at)?b.at:0)-(goodTime(a.at)?a.at:0));
    trades=Array.isArray(data.trades)?data.trades.filter(t=>t&&typeof t.id==='string').sort((a,b)=>(b.closedAt??b.lastAt??0)-(a.closedAt??a.lastAt??0)):null;
    const valid=new Set((trades||[]).map(t=>t.id));for(const id of expanded)if(!valid.has(id))expanded.delete(id);
    coverage=data.coverage??null;loaded=true;
   }
   if(!available&&data.accountVerified!==false){
    problem=(rows.length||trades?.length)?'Broker history is unavailable. Showing recorded activity.':'Broker execution history is unavailable.';
    if(data.coverage?.message&&data.coverage!==coverage)problem+=' '+data.coverage.message;
   }
  }catch(error){
   if(serial!==epoch||!active)return;
   refreshing=false;
   problem=((rows.length||trades?.length)?'Refresh failed. Showing the last loaded activity. ':'Could not load options history. ')+(error?.message||'');
  }finally{
   if(serial===epoch&&active){
    loading=false;refresh.disabled=false;
    const next=JSON.stringify([rows,trades,problem,refreshing]);
    if(next!==signature){signature=next;render()}else summary(from.value&&to.value&&from.value>to.value?0:filtered().length);
    timer=setTimeout(load,refreshing?4000:30000);
   }
  }
 }
 function stop(){
  active=false;epoch++;loading=false;grouping.reset();clearTimeout(timer);panel.hidden=true;
  // The next visit must validate its account scope before displaying old fills.
  rows=[];trades=null;expanded.clear();coverage=null;loaded=false;refreshing=false;problem='';signature=null;page=0;
  holder.replaceChildren();$('optionsFlexResult').replaceChildren();$('optionsFlexResult').hidden=true;
 }
 function syncVisibility(){
  if(!isVisible()||$('savedShow').value!=='archived'){if(active)stop();return}
  panel.hidden=false;if(active)return;
  active=true;epoch++;render();load();
 }
 for(const [button,selected] of [[tradesButton,'trades'],[activityButton,'activity']])button.onclick=()=>{
  view=selected;page=0;render();
 };
 for(const input of [tradeStatus,contract,ticker,from,to])input.addEventListener(input===ticker?'input':'change',()=>{page=0;render()});
 clear.onclick=()=>{ticker.value=from.value=to.value='';page=0;render()};
 refresh.onclick=load;
 bindFlexImport(reloadCurrent);
 holder.addEventListener('click',async e=>{
  const link=e.target.closest('[data-history-open]');if(!link)return;
  try{await openSavedById(link.dataset.historyOpen)}catch(error){if(active){problem=error?.message||String(error);render()}}
 });
 $('savedShow').addEventListener('change',syncVisibility);
 return {syncVisibility,stop};
}

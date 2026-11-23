// Manual annotations reference account-scoped trade allocations. The server resolves
// matching entry/exit quantities and calculates the preview used by the save token.
const MAX_SELECTIONS=128;
const get=id=>document.getElementById(id);
function element(tag,text='',cls=''){
 const el=document.createElement(tag);el.textContent=text;if(cls)el.className=cls;return el;
}
function keyOf(scope,selection){return JSON.stringify([scope,selection.tradeId,selection.fillId??null,selection.role??null])}
function message(el,text=''){el.textContent=text;el.hidden=!text}
function labelOf(t){return t.manualName||t.label||t.symbol||'Option trade'}
const fillDate=new Intl.DateTimeFormat('en-US',{timeZone:'America/New_York',month:'short',day:'numeric',year:'numeric',hour:'numeric',minute:'2-digit',timeZoneName:'short'});
function describeTrade(t,id){
 const leg=(t.legs||[]).find(l=>l.conId===id)||t.legs?.[0];
 if(!leg)return labelOf(t);
 const expiry=String(leg.expiry||'').replace(/^(\d{4})(\d{2})(\d{2})$/,'$1-$2-$3');
 const term=Number.isFinite(leg.strike)&&['C','P'].includes(leg.right)?String(leg.strike)+leg.right:'';
 return [t.symbol,term||leg.localSymbol,expiry,leg.direction==='long'?'Long':leg.direction==='short'?'Short':''].filter(Boolean).join(' · ')||labelOf(t);
}
function describeFill(t,f){
 return [describeTrade(t,f.conId),roleLabel(f.role),f.side,Number.isFinite(f.qty)?String(f.qty):'',
  Number.isFinite(f.at)?fillDate.format(f.at):'',f.id].filter(Boolean).join(' · ');
}
function roleLabel(role){return role==='open'?'Opening':role==='close'?'Closing':'Unclassified'}
function scopeOf(o){return typeof o?.selectionScope==='string'?o.selectionScope:''}
function fillRef(tradeId,fillId,role){return {tradeId,fillId,...(role==='open'||role==='close'?{role}:{})}}

export function bindHistoryGrouping({api,draw,reload,renderPreview,revealManual}){
 const start=get('historyGroupStart'),selection=get('historyGroupSelection'),name=get('historyGroupName');
 const status=get('historyGroupMessage'),selectedPanel=get('historyGroupSelected'),list=get('historyGroupSelectedList');
 const previewButton=get('historyGroupPreview'),previewDialog=get('historyGroupDialog'),body=get('historyGroupPreviewBody');
 const save=get('historyGroupSave'),back=get('historyGroupBack'),saveError=get('historyGroupSaveMessage');
 const undoDialog=get('historyUngroupDialog'),undoBack=get('historyUngroupBack'),undo=get('historyUngroupConfirm'),undoError=get('historyUngroupError');
 const selected=new Map();
 let sources=new Map(),owners=new Map(),manualGroups=new Map(),scope='',scopeSignature='',confirmed=false;
 let selecting=false,pending='',preview=null,undoTarget=null,epoch=0,sourceStamp='',savedDetail=false;
 name.maxLength=96;
 const close=dialog=>{if(dialog.open)dialog.close()};
 const redraw=()=>{syncControls();draw()};
 function syncControls(){
  start.hidden=selecting;start.disabled=!confirmed||!!pending;
  start.title=confirmed?'Select completed option trades or fills to combine':'A verified broker account is needed to group trades';
  selection.hidden=!selecting;
  name.disabled=!!pending;get('historyGroupCancel').disabled=pending==='save';
  previewButton.disabled=!selected.size||!!pending;
  previewButton.textContent=pending==='preview'?'Preparing preview…':'Preview spread';
  save.hidden=savedDetail;save.disabled=!preview||!!pending;back.disabled=pending==='save';back.textContent=savedDetail?'Close':'Back';
  get('historyGroupDialogTitle').textContent=savedDetail?'Saved spread':'Spread preview';
  save.textContent=pending==='save'?'Saving…':'Save spread';
  undo.disabled=!undoTarget||!!pending;undoBack.disabled=pending==='ungroup';
  undo.textContent=pending==='ungroup'?'Ungrouping…':'Ungroup spread';
  const whole=[...selected.values()].filter(v=>!v.selection.fillId).length,parts=[];
  if(whole)parts.push(whole+' whole '+(whole===1?'trade':'trades'));
  const fills=selected.size-whole;if(fills)parts.push(fills+' '+(fills===1?'fill':'fills'));
  get('historyGroupCount').textContent=parts.length?parts.join(' · ')+' selected':'0 selected';
  selectedPanel.hidden=!selected.size;list.replaceChildren();
  for(const [key,entry] of selected){
   const row=element('li',entry.label+' '),remove=element('button','Remove','history-selection-remove');remove.type='button';remove.disabled=!!pending;
   remove.setAttribute('aria-label','Remove '+entry.label);remove.onclick=()=>{selected.delete(key);selectionChanged()};
   row.append(remove);list.append(row);
  }
 }
 function clearDraft(){
  epoch++;pending='';selecting=false;scope='';sourceStamp='';preview=null;undoTarget=null;savedDetail=false;selected.clear();
  name.value='';selectedPanel.open=false;close(previewDialog);close(undoDialog);body.replaceChildren();
  message(saveError);message(undoError);
 }
 function fingerprint(){
  return JSON.stringify([...new Set([...selected.values()].map(v=>v.selection.tradeId))].map(id=>{
   const t=sources.get(keyOf(scope,{tradeId:id}));return t?[id,t.fills,t.legs,t.netRealizedPnl]:[id,null];
  }));
 }
 function selectionChanged(){
  scope=selected.values().next().value?.scope||'';
  epoch++;preview=null;sourceStamp=fingerprint();message(status);redraw();
 }
 function choose(entry,checked){
  if(!selecting||pending)return;
  const key=keyOf(entry.scope,entry.selection);
  if(checked){
   if(scope&&scope!==entry.scope){message(status,'Select trades from one broker account at a time.');redraw();return}
   const whole=keyOf(entry.scope,{tradeId:entry.selection.tradeId});
   if(entry.selection.fillId&&selected.has(whole))return;
   if(!entry.selection.fillId)for(const [k,v] of selected)if(v.scope===entry.scope&&v.selection.tradeId===entry.selection.tradeId)selected.delete(k);
   if(selected.size>=MAX_SELECTIONS){message(status,'Select up to 128 trades or fills per spread.');redraw();return}
   selected.set(key,entry);
  }else selected.delete(key);
  selectionChanged();
 }
 function box(entry,caption){
  const ref=entry.selection,whole=keyOf(entry.scope,{tradeId:ref.tradeId}),key=keyOf(entry.scope,ref);
  const parent=!!ref.fillId&&selected.has(whole),another=!!scope&&scope!==entry.scope;
  const label=element('label'),checkbox=document.createElement('input');checkbox.type='checkbox';
  if(ref.fillId)checkbox.dataset.groupFill=ref.fillId;else checkbox.dataset.groupTrade=ref.tradeId;
  checkbox.dataset.sourceTrade=ref.tradeId;
  if(ref.role)checkbox.dataset.fillRole=ref.role;
  checkbox.checked=parent||selected.has(key);
  if(!ref.fillId&&!checkbox.checked)checkbox.indeterminate=[...selected.values()].some(v=>v.scope===entry.scope&&v.selection.tradeId===ref.tradeId);
  checkbox.disabled=!!pending||parent||another;
  checkbox.setAttribute('aria-label','Select '+entry.label);
  label.title=another?'The current selection belongs to another account.':parent?'Included by the selected whole trade.':entry.label;
  checkbox.onchange=()=>{
   const table=checkbox.closest('table')?.getAttribute('aria-label');
   choose(entry,checkbox.checked);
   const replacement=[...get('optionsHistoryTable').querySelectorAll('input[type=checkbox]')].find(input=>
    input.dataset.sourceTrade===ref.tradeId&&input.dataset.groupFill===ref.fillId&&input.dataset.fillRole===ref.role&&
    input.closest('table')?.getAttribute('aria-label')===table);
   replacement?.focus({preventScroll:true});
  };
  label.append(checkbox);if(caption)label.append(document.createTextNode(caption));return label;
 }
 function tradeCell(t){
  const cell=element('td','','history-select-cell'),owner=scopeOf(t);
  if(owner&&sources.has(keyOf(owner,{tradeId:t.id})))cell.append(box({scope:owner,selection:{tradeId:t.id},label:describeTrade(t)+' · whole trade'}));
  else{cell.textContent='—';cell.title=t.manualGroupId?'Already grouped as a manual spread.':'A complete single-contract source trade is required.'}
  return cell;
 }
 function fillCell(f,t=null){
  const cell=element('td','','history-select-cell'),owner=t?scopeOf(t):scopeOf(f);
  const options=owners.get(JSON.stringify([owner,f.id]))||[];
  const refs=t?options.filter(v=>v.selection.tradeId===t.id&&v.selection.role===f.role):options;
  if(!refs.length){cell.textContent='—';cell.title='This activity has no eligible completed trade allocation.';return cell}
  for(const v of refs)cell.append(box(v,refs.length>1?roleLabel(v.selection.role)+' · '+v.tradeLabel:''));
  return cell;
 }
 function showUndo(record){
  if(pending||!record.scope||!confirmed)return;
  undoTarget=record;message(undoError);
  get('historyUngroupCopy').textContent='Remove the manual grouping for '+(record.name||'this spread')+'? Its broker executions will appear under their original trades.';
  syncControls();undoDialog.showModal();
 }
 function undoButton(t){
  if(!t.manualGroupId)return null;
  const record=manualGroups.get(JSON.stringify([scopeOf(t),t.manualGroupId]))||{id:t.manualGroupId,scope:scopeOf(t),name:labelOf(t)};
  const btn=element('button','Ungroup spread','history-group-undo');btn.type='button';btn.dataset.ungroupTrade=record.id;
  btn.disabled=!!pending||!confirmed||!record.scope;btn.onclick=()=>showUndo(record);return btn;
 }
 function updateData(data){
  const trades=Array.isArray(data.trades)?data.trades:[],raw=Array.isArray(data.rows)?data.rows:[];
  const records=Array.isArray(data.manualGroups)?data.manualGroups:[],nextSources=new Map(),nextOwners=new Map();
  const scopes=new Set([...trades,...raw].map(scopeOf).filter(Boolean));
  for(const r of records)if(r.scope)scopes.add(r.scope);
  const verified=data.accountVerified===true&&scopes.size>0;
  const signature=verified?JSON.stringify([...scopes].sort()):'';
  const changed=scopeSignature!==signature;
  if(changed){
   const hadDraft=selecting||!!undoTarget||previewDialog.open;clearDraft();
   message(status,hadDraft?'Broker account scope changed. Start a new selection.':'');
  }
  confirmed=verified;scopeSignature=signature;
  if(confirmed)for(const t of trades){
   const owner=scopeOf(t);if(!owner||!t.manualEligible||!t.id)continue;
   nextSources.set(keyOf(owner,{tradeId:t.id}),t);
   for(const f of t.fills||[]){
    if(!f.id||!['open','close'].includes(f.role))continue;
    const key=JSON.stringify([owner,f.id]),options=nextOwners.get(key)||[];
    if(!options.some(v=>v.selection.tradeId===t.id&&v.selection.role===f.role)){
     options.push({scope:owner,selection:fillRef(t.id,f.id,f.role),tradeLabel:describeTrade(t,f.conId),label:describeFill(t,f)});nextOwners.set(key,options);
    }
   }
  }
  sources=nextSources;owners=nextOwners;
  manualGroups=new Map(records.filter(r=>r.id&&r.scope).map(r=>[JSON.stringify([r.scope,r.id]),r]));
  const missing=[];
  for(const [key,entry] of selected){
   const r=entry.selection,t=sources.get(keyOf(entry.scope,{tradeId:r.tradeId}));
   if(!t||r.fillId&&!t.fills?.some(f=>f.id===r.fillId&&f.role===r.role))missing.push(key);
  }
  if(missing.length&&pending!=='save'){
   for(const k of missing)selected.delete(k);
   selectionChanged();close(previewDialog);pending='';message(status,'Some selected allocations are no longer available. Review the remaining selection.');
  }else if(selected.size&&sourceStamp!==fingerprint()&&pending!=='save'){
   sourceStamp=fingerprint();epoch++;pending='';preview=null;close(previewDialog);message(status,'Broker activity changed. Preview the spread again.');
  }
  const reviews=get('historyGroupReview');reviews.replaceChildren();
  if(confirmed)for(const r of records.filter(r=>r.status==='needsReview')){
   const line=element('p',(r.name||'Manual spread')+' · '+(r.reason||'The broker activity for this spread changed.')+' ');
   const btn=element('button','Ungroup spread');btn.type='button';btn.dataset.ungroupTrade=r.id;btn.onclick=()=>showUndo(r);
   line.append(btn);reviews.append(line);
  }
  syncControls();return changed||missing.length>0;
 }
 function reset(){clearDraft();confirmed=false;scopeSignature='';sources.clear();owners.clear();manualGroups.clear();message(status);get('historyGroupReview').replaceChildren();syncControls()}
 const request=()=>({scope,selections:[...selected.values()].map(v=>v.selection),name:name.value.trim()});
 start.onclick=()=>{
  if(!confirmed||pending)return;
  if(!sources.size){message(status,'There are no completed single-contract trades available to group in this account history.');return}
  selecting=true;message(status);redraw();
 };
 get('historyGroupCancel').onclick=()=>{if(pending==='save')return;clearDraft();message(status);redraw()};
 name.oninput=()=>{preview=null;message(status);syncControls()};
 previewButton.onclick=async()=>{
  if(!selecting||pending||!confirmed||!selected.size)return;
  if([...name.value.trim()].length>96){message(status,'Use up to 96 characters for the spread name.');return}
  const ticket=++epoch;pending='preview';message(status);redraw();
  try{
   const result=await api('manual-spread',{action:'preview',...request()});
   if(ticket!==epoch)return;
   if(!result?.ok||!result.previewToken||!result.trade)throw Error('The server did not return a complete spread preview.');
   savedDetail=false;preview=result;body.replaceChildren(renderPreview(result,name.value.trim()));message(saveError);
   previewDialog.showModal();
  }catch(error){if(ticket===epoch)message(status,error?.message||'Could not preview the selected spread.')}
  finally{if(ticket===epoch){pending='';redraw()}}
 };
 const leavePreview=()=>{if(pending==='save')return;preview=null;savedDetail=false;close(previewDialog);syncControls()};
 back.onclick=leavePreview;previewDialog.addEventListener('cancel',e=>{e.preventDefault();leavePreview()});
 save.onclick=async()=>{
  if(!preview||!confirmed||pending)return;
  const ticket=++epoch,payload={action:'save',...request(),previewToken:preview.previewToken},label=name.value.trim()||preview.trade.label||'spread';
  pending='save';message(saveError);syncControls();
  try{
   const result=await api('manual-spread',payload);if(ticket!==epoch)return;
   if(!result?.ok)throw Error('The spread was not saved.');
   clearDraft();message(status,'Saved '+label+' as a manual spread.');redraw();const visit=epoch;await reload();
   if(visit!==epoch||!confirmed)return;
   const view=element('button','View saved spread');view.id='historyGroupViewSaved';view.type='button';
   view.onclick=()=>{
    const located=revealManual(result.id,payload.scope);
    if(!located){message(status,'The saved spread is no longer available in the current broker history.');return}
    if(!located.shown){
     savedDetail=true;preview=null;body.replaceChildren(renderPreview({trade:located.trade},located.trade.manualName||''));
     syncControls();previewDialog.showModal();
    }
   };
   status.append(document.createTextNode(' '),view);
  }catch(error){if(ticket===epoch)message(saveError,error?.message||'Could not save the spread. Open a new preview to retry.')}
  finally{if(ticket===epoch){pending='';syncControls()}}
 };
 const leaveUndo=()=>{if(pending==='ungroup')return;undoTarget=null;close(undoDialog);syncControls()};
 undoBack.onclick=leaveUndo;undoDialog.addEventListener('cancel',e=>{e.preventDefault();leaveUndo()});
 undo.onclick=async()=>{
  if(!undoTarget||!confirmed||pending)return;
  const {scope:targetScope,id,name:targetName}=undoTarget,ticket=++epoch;pending='ungroup';message(undoError);syncControls();
  try{
   const result=await api('manual-spread',{action:'ungroup',scope:targetScope,id});if(ticket!==epoch)return;
   if(!result?.ok)throw Error('The spread was not ungrouped.');
   epoch++;pending='';undoTarget=null;close(undoDialog);
   message(status,'Ungrouped '+(targetName||'spread')+'.');redraw();await reload();
  }catch(error){if(ticket===epoch)message(undoError,error?.message||'Could not ungroup the spread.')}
  finally{if(ticket===epoch){pending='';syncControls()}}
 };
 syncControls();
 return {editing:()=>selecting,updateData,reset,tradeCell,fillCell,undoButton};
}

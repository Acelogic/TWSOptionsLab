// Saved trades use versioned SQLite writes. Polling and sorting belong to the
// list owner; this module reads its current items and portfolio snapshots.
function node(tag,text,className){
 const element=document.createElement(tag);
 if(text!==undefined)element.textContent=text;
 if(className)element.className=className;
 return element;
}

function button(text,action,className){
 const b=node('button',text,className);
 b.type='button';b.dataset.savedAction=action;
 return b;
}

function field(label,input){
 const wrapper=node('label',undefined,'saved-detail-field');
 wrapper.append(node('span',label),input);
 return wrapper;
}

function amount(value,currency){
 if(!Number.isFinite(value))return '—';
 if(currency){
  try{return new Intl.NumberFormat(undefined,{style:'currency',currency,maximumFractionDigits:2}).format(value)}catch{}
 }
 return value.toLocaleString(undefined,{maximumFractionDigits:2});
}

const percent=value=>Number.isFinite(value)?value.toLocaleString(undefined,{maximumFractionDigits:2})+'%':'';
const visibleId=item=>String(item.id);
function strategyGroup(item){
 const d=item.document,value=Object.hasOwn(d,'libraryGroup')?d.libraryGroup:d.source?.group;
 return typeof value==='string'&&value.trim().toLowerCase()!=='all'?value.trim():'';
}
function positionLabel(leg,symbol){
 const qty=Math.abs(leg.qty),closed=(leg.closes??[]).reduce((n,fill)=>n+fill.qty,0);
 const side=leg.qty>0?'Long':'Short';
 const expiry=String(leg.expiry??'');
 const date=/^\d{8}$/.test(expiry)?
  expiry.slice(0,4)+'-'+expiry.slice(4,6)+'-'+expiry.slice(6):expiry;
 const contract=leg.kind==='stock'?symbol+' '+(qty===1?'share':'shares'):
  [leg.root||symbol,date,Number(leg.strike).toLocaleString(undefined,{maximumFractionDigits:8}),leg.right==='C'?'call':'put'].filter(Boolean).join(' ');
 return [side+' '+qty+' '+contract,closed>=qty?'Closed':closed>0?(qty-closed)+' open':'',leg.excluded?'Excluded':''].filter(Boolean).join(' · ');
}

export function bindSavedActions({api,dialog,handled,openSaved,dayDescription,getItem,getSnapshot,getVisibleItems,getGroups,reload,onDeleted,onSaved,draw}){
 const $=id=>document.getElementById(id);
 const panel=$('savedTradeDetails'),library=$('library');
 const selected=new Map();
 let editing=false,busy=false,detail=null;
 const signals=node('div',undefined,'saved-action-status');
 signals.setAttribute('role','status');signals.hidden=true;
 library.before(signals);
 panel.classList.add('saved-trade-details');

 function notify(text=''){
  signals.textContent=text;signals.hidden=!text;
 }
 function reportProblem(error){
  const message=error?.message??String(error);
  if(panel.open&&detail){
   detail.error.textContent=message;detail.error.hidden=false;
  }else notify(message);
 }
 function currentItem(item){
  const current=getItem(item.id);
  if(!current||current.version!==item.version)
   throw Error('This trade changed. Close this dialog and reopen the current version.');
  return current;
 }
 function refreshOverview(){
  if(!panel.open||detail?.kind!=='overview')return;
  const {item,metrics,source,daySource,description,status}=detail;
  const current=getItem(item.id);
  const latest=getSnapshot(item.id);
  const snapshot=latest&&(!latest.id||latest.id===item.id)&&(!latest.version||latest.version===item.version)?latest:null;
  const currency=snapshot?.currency||item.document.legs.find(l=>l.currency)?.currency;
  const values=[
   [snapshot?.totalPnl,snapshot?.totalPct],[snapshot?.dayPnl,snapshot?.dayPct],
   [snapshot?.basis,null],[snapshot?.marketValue,null]
  ];
  for(let i=0;i<metrics.length;i++){
   const [value,pct]=values[i];
   metrics[i].firstChild.textContent=amount(value,currency);
   const percentage=percent(pct);
   metrics[i].lastChild.textContent=percentage?' ('+percentage+')':'';
   if(i<2){
    metrics[i].classList.toggle('positive',value>0);
    metrics[i].classList.toggle('negative',value<0);
   }
  }
  status.textContent=[item.document.symbol.split('#')[0],snapshot?.status].filter(Boolean).join(' · ');
  const sources=[...new Set([snapshot?.source,snapshot?.markSource,snapshot?.feed]
   .filter(v=>typeof v==='string'&&v).flatMap(v=>v.split(' · ')))];
  if(Number.isFinite(snapshot?.receivedAt)&&snapshot.receivedAt>0){
   const at=new Date(snapshot.receivedAt);
   if(Number.isFinite(at.getTime()))sources.push(at.toLocaleString(undefined,{year:'numeric',month:'short',day:'numeric',hour:'numeric',minute:'2-digit',timeZoneName:'short'}));
  }
  source.textContent='P&L source · '+(sources.join(' · ')||'Awaiting portfolio snapshot');
  const day=dayDescription(snapshot);
  daySource.textContent=day?'Day P&L source · '+day:'';
  daySource.hidden=!daySource.textContent;
  description.textContent=snapshot?.detail||'';description.hidden=!description.textContent;
  if(!current||current.version!==item.version){
   detail.error.textContent='This trade changed. Close this dialog and reopen the current version.';
   detail.error.hidden=false;
  }
 }
 function syncSelection(){
  const visible=getVisibleItems(),index=new Map(visible.map(item=>[visibleId(item),item]));
  for(const [id,version] of selected)if(index.get(id)?.version!==version)selected.delete(id);
  for(const box of library.querySelectorAll('[data-select-trade]')){
   box.checked=selected.has(box.dataset.selectTrade);box.disabled=busy;
  }
  const all=$('savedSelectAll');
  if(all){
   all.checked=visible.length>0&&selected.size===visible.length;
   all.indeterminate=selected.size>0&&!all.checked;all.disabled=busy||!visible.length;
  }
  $('savedEdit').hidden=editing;$('savedEdit').disabled=busy||!visible.length;
  $('savedAddGroup').hidden=editing;$('savedAddGroup').disabled=busy||!visible.length;
  $('savedExportActions').hidden=editing;
  const remove=$('savedDeleteSelected');
  remove.hidden=!editing;remove.disabled=busy||!selected.size;
  remove.textContent='Delete Selected ('+selected.size+')';
  $('savedCancelEdit').hidden=!editing;$('savedCancelEdit').disabled=busy;
  if(panel.open&&detail){
   panel.setAttribute('aria-busy',String(busy));
   const stale=detail.kind==='overview'&&getItem(detail.item.id)?.version!==detail.item.version;
   for(const control of panel.querySelectorAll('button,input,select')){
    control.disabled=busy||Boolean(stale&&control.dataset.savedAction!=='close');
   }
   refreshOverview();
  }
 }
 function switchEdit(next){
  editing=next;selected.clear();notify();draw();syncSelection();
 }
 async function run(action){
  if(busy)return;
  busy=true;syncSelection();
  try{await action()}catch(error){reportProblem(error)}
  finally{busy=false;syncSelection()}
 }
 function prepareDialog(title,kind){
  if(panel.open)panel.close();
  panel.replaceChildren();
  const header=node('header',undefined,'saved-detail-header'),heading=node('h2',title);
  heading.id='savedDetailTitle';panel.setAttribute('aria-labelledby',heading.id);
  const close=button('×','close','saved-detail-close');
  close.setAttribute('aria-label','Close trade settings');close.onclick=()=>panel.close();
  header.append(heading,close);
  const error=node('p',undefined,'saved-detail-error');
  error.setAttribute('role','alert');error.hidden=true;
  panel.append(header);
  detail={kind,error};
  return error;
 }
 async function persist(item,name,group){
  currentItem(item);
  const cleanName=name.trim(),cleanGroup=group.trim();
  if(!cleanName||[...cleanName].length>100)throw Error('Enter a trade name of up to 100 characters.');
  if([...cleanGroup].length>100)throw Error('Enter a group name of up to 100 characters.');
  if(cleanGroup.toLowerCase()==='all')throw Error('Choose a group name other than All.');
  const doc={...item.document,name:cleanName,libraryGroup:cleanGroup};
  const result=await api('save',{id:item.id,version:item.version,name:cleanName,document:doc});
  // Let the builder update its saved-version reference and preserve any draft.
  await onSaved(item,{...result,name:cleanName,document:doc});
  if(panel.open)panel.close();
  if(!$('saved').hidden){await reload();notify('Saved '+cleanName+(cleanGroup?' in '+cleanGroup:'')+'.')}
 }
 async function removeItems(items){
  if(!items.length)return;
  const text=items.length===1?'Delete '+items[0].name+' and its locally recorded marks?':
   'Delete '+items.length+' selected trades and their locally recorded marks?';
  const ok=await dialog(items.length===1?'Delete saved trade':'Delete selected trades',node('p',text),'Delete');
  if(!ok)return;
  const failed=[];
  let removed=0;
  for(const item of items){
   try{
    await api('delete',{id:item.id,version:item.version});
   }catch(error){failed.push(item.name+' · '+(error.message??String(error)));continue}
   removed++;selected.delete(visibleId(item));await onDeleted(item.id);
  }
  if(removed&&panel.open)panel.close();
  if(!failed.length){selected.clear();editing=false}
  if($('saved').hidden)return;
  await reload();draw();
  const message=removed+' '+(removed===1?'trade':'trades')+' deleted.';
  if(failed.length)reportProblem(Error(message+' '+failed.join(' | ')));else notify(message);
 }
 function overview(item){
  if(!item||busy||editing)return;
  const error=prepareDialog(item.name,'overview');
  const status=node('p',undefined,'saved-detail-status'),metrics=[];
  const totals=node('dl',undefined,'saved-detail-metrics');
  for(const label of ['Total Return','Today’s Return','Cost Basis','Current Value']){
   const group=node('div'),value=node('dd');
   value.append(node('span'),node('small'));
   group.append(node('dt',label),value);totals.append(group);metrics.push(value);
  }
  const source=node('p',undefined,'saved-detail-source');
  const daySource=node('p',undefined,'saved-detail-source'),description=node('p',undefined,'saved-detail-source');
  const positions=node('ul',undefined,'saved-detail-positions');positions.setAttribute('aria-label','Trade positions');
  for(const leg of item.document.legs)positions.append(node('li',positionLabel(leg,item.document.symbol.split('#')[0])));
  const meta=node('form',undefined,'saved-detail-form');
  const name=node('input');name.id='savedDetailName';name.maxLength=100;name.required=true;name.value=item.name;
  const group=node('select');group.id='savedDetailGroup';
  const options=[...new Set([...getGroups(),strategyGroup(item)].filter(v=>typeof v==='string'&&v.trim()&&v.trim().toLowerCase()!=='all'))];
  group.add(new Option('Ungrouped',''));for(const value of options)group.add(new Option(value,value));
  const create=new Option('+ New group…','');create.dataset.create='true';group.add(create);
  group.value=strategyGroup(item);
  const newGroup=node('input');newGroup.id='savedDetailNewGroup';newGroup.type='text';newGroup.maxLength=100;
  const newField=field('New group name',newGroup);newField.hidden=true;
  group.onchange=()=>{
   const make=group.selectedOptions[0]===create;newField.hidden=!make;newGroup.required=make;
   if(make)newGroup.focus();
  };
  const actions=node('div',undefined,'actions saved-detail-actions');
  const open=button('View / edit trade','open'),remove=button('Delete trade','delete');
  const save=button('Save changes','save','primary');save.type='submit';
  actions.append(open,remove,save);
  meta.append(field('Trade name',name),field('Group',group),newField,actions);
  meta.addEventListener('submit',e=>{
   e.preventDefault();
   const value=group.selectedOptions[0]===create?newGroup.value.trim():group.value;
   if(group.selectedOptions[0]===create&&!value){reportProblem(Error('Enter a group name.'));return}
   handled(()=>run(()=>persist(item,name.value,value)))();
  });
  open.onclick=handled(()=>run(async()=>{const current=currentItem(item);panel.close();await openSaved(current)}));
  remove.onclick=handled(()=>run(()=>removeItems([currentItem(item)])));
  Object.assign(detail,{item,metrics,source,daySource,description,status});
  panel.append(status,positions,totals,source,daySource,description,meta,error);
  panel.showModal();syncSelection();
 }
 function addGroup(){
  const items=[...getVisibleItems()];
  if(!items.length||busy||editing)return;
  const error=prepareDialog('Add group','group'),form=node('form',undefined,'saved-detail-form');
  const input=node('input');input.id='savedNewGroupName';input.required=true;input.maxLength=100;
  const choose=node('select');choose.id='savedGroupTrade';
  for(const item of items)choose.add(new Option(item.name+' · '+item.document.symbol.split('#')[0],visibleId(item)));
  const submit=button('Create and assign','save','primary');submit.type='submit';
  form.append(field('Group name',input),field('Assign trade',choose),submit);
  form.addEventListener('submit',e=>{
   e.preventDefault();
   handled(()=>run(async()=>{
    const group=input.value.trim();if(!group)throw Error('Enter a group name.');
    const item=items.find(s=>visibleId(s)===choose.value);
    if(!item)throw Error('Choose a saved trade.');
    await persist(item,item.name,group);
   }))();
  });
  panel.append(form,error);panel.showModal();input.focus();syncSelection();
 }
 library.addEventListener('click',e=>{
  const gear=e.target.closest('[data-manage]');if(gear)overview(getItem(gear.dataset.manage));
 });
 library.addEventListener('change',e=>{
  if(!editing||busy)return;
  const box=e.target;
  if(box.id==='savedSelectAll'){
   selected.clear();if(box.checked)for(const item of getVisibleItems())selected.set(visibleId(item),item.version);
  }else if(box.matches('[data-select-trade]')){
   const item=getItem(box.dataset.selectTrade);if(!item)return;
   if(box.checked)selected.set(visibleId(item),item.version);else selected.delete(visibleId(item));
  }else return;
  syncSelection();
 });
 $('savedEdit').onclick=()=>switchEdit(true);
 $('savedCancelEdit').onclick=()=>switchEdit(false);
 $('savedDeleteSelected').onclick=handled(()=>run(()=>{
  const items=getVisibleItems().filter(item=>selected.get(visibleId(item))===item.version);
  return removeItems(items);
 }));
 $('savedAddGroup').onclick=addGroup;
 panel.addEventListener('cancel',e=>{if(busy)e.preventDefault()});
 panel.addEventListener('close',()=>{if(!panel.open)detail=null});
 return {editing:()=>editing,syncSelection,resetSelection:()=>{
  if(editing||selected.size)switchEdit(false);else notify();
 }};
}

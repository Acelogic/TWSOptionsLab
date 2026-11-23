// Run with a signed-in TWS and Chrome. Each run creates its own browser profile and library.
// node scripts/verify-rail.mjs /path/to/rail-evidence.json
import {spawn,execFileSync} from 'node:child_process';
import {mkdtemp,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {dirname,join,resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import net from 'node:net';
import assert from 'node:assert/strict';
import {testBrowser} from './browser-fixture.mjs';

const project=resolve(dirname(fileURLToPath(import.meta.url)),'..');
const tmp=await mkdtemp(join(tmpdir(),'tws-rail-'));
const evidence=process.argv[2]||join(process.cwd(),'rail-evidence.json');
const report={time:new Date().toISOString(),cases:[]};
const pause=ms=>new Promise(resolve=>setTimeout(resolve,ms));
let backend,browser;
async function waitFor(probe,description,timeout=30000){
 const until=Date.now()+timeout;
 while(Date.now()<until){try{const value=await probe();if(value)return value}catch{}await pause(100)}
 throw Error('Timed out waiting for '+description);
}
async function freePort(){
 const socket=net.createServer();await new Promise(r=>socket.listen(0,'127.0.0.1',r));
 const port=socket.address().port;await new Promise(r=>socket.close(r));return port;
}
async function runInPage(which,step,listed,name){
 const $=id=>document.getElementById(id);
 const delay=ms=>new Promise(r=>setTimeout(r,ms));
 const draft=()=>JSON.parse(localStorage.getItem('optionslab.draft.v1'));
 const strikes=()=>draft().legs.map(l=>l.strike);
 const equal=(a,b)=>JSON.stringify(a)===JSON.stringify(b);
 const check=(ok,message)=>{if(!ok)throw Error(message)};
 async function wait(probe,reason){
  for(let i=0;i<240;i++){if(probe())return;await delay(50)}
  throw Error(reason+' · '+($('message')?.textContent||'')+' · '+JSON.stringify(strikes()));
 }
 const marker=i=>document.querySelector('.marker[data-leg="'+i+'"]');
 const cell=k=>document.querySelector('.strike[data-strike="'+k+'"]');
 function drag(source,destination,shift){
  check(source&&destination,'Gesture endpoints must be visible');
  for(const [element,type] of [[source,'pointerdown'],[destination,'pointermove'],[destination,'pointerup']]){
   const b=element.getBoundingClientRect();
   element.dispatchEvent(new PointerEvent(type,{bubbles:true,cancelable:true,pointerId:5,isPrimary:true,
    pointerType:'mouse',button:0,buttons:type==='pointerup'?0:1,clientX:b.left+b.width/2,clientY:b.top+b.height/2,shiftKey:shift}));
  }
 }
 function slider(index,shift){
  const input=$('strikePan');
  input.dispatchEvent(new PointerEvent('pointerdown',{bubbles:true,shiftKey:shift}));
  input.value=String(index);
  input.dispatchEvent(new Event('input',{bubbles:true}));
  input.dispatchEvent(new Event('change',{bubbles:true}));
 }
 async function expectStrikes(wanted,reason){
  await wait(()=>equal(strikes(),wanted),reason);
  const legs=draft().legs;
  check(legs.every(leg=>listed.find(row=>row.strike===leg.strike)?.[leg.right]===leg.conId),'TWS IDs do not match displayed strikes');
 }
 await wait(()=>draft()?.name===name&&marker(0),'Load isolated strategy');
 const initial=strikes();
 if(which==='partial'){
  check(marker(0).querySelector('.state-partial'),'Partial close icon missing');
  slider(Number($('strikePan').value)+1,true);
  await wait(()=>$('message').textContent.includes('closing fills'),'Reject moving a partially closed group');
  check(equal(strikes(),initial),'Rejected group move changed a contract');
  return {strikes:initial,closingFills:draft().legs[0].closes,warning:$('message').textContent};
 }
 if(which==='butterfly'){
  const wanted=initial.slice();wanted[0]-=step;wanted[2]+=step;
  drag(marker(0),cell(wanted[0]),true);await expectStrikes(wanted,'Butterfly opposite wing');
  return {initial,paired:wanted,middleQuantity:draft().legs[1].qty};
 }
 const icons=[...document.querySelectorAll('.marker .leg-state')];
 check(icons.some(icon=>icon.classList.contains('state-excluded')&&icon.querySelector('svg')),'Excluded eye icon missing');
 for(const icon of icons){
  const box=icon.getBoundingClientRect(),text=icon.parentElement.querySelector('.marker-text').getBoundingClientRect();
  check(box.width>0&&box.left>=text.right-.25,'Status icon overlaps its strike text');
 }
 $('positions').click();await wait(()=>$('legsPanel').open,'Positions chooser');
 check($('legs').querySelector('.state-entry')&&$('legs').querySelector('.state-excluded'),'Open leg status icons missing');
 $('closedPositions').click();check($('legs').querySelector('.state-closed'),'Closed check missing');
 $('closeLegs').click();
 check($('strikeVolumes').hidden,'Volume starts hidden');
 $('railVolume').click();
 await wait(()=>!$('strikeVolumes').hidden&&$('strikeVolumes').querySelector('.volume-cell[aria-label]'),'Visible TWS volumes');
 // Give after-hours quotes a short opportunity to report volume.
 for(let i=0;i<20&&$('strikeVolumes').dataset.empty==='true';i++)await delay(100);
 const volumeCells=[...$('strikeVolumes').children];
 const volume=volumeCells.map(c=>({label:c.title,heights:[...c.children].map(el=>parseFloat(el.style.height)||0)}));
 check(volume.every(c=>c.label.includes('Call volume')&&c.label.includes('Put volume')),'Missing volume descriptions');
 check(volume.every(c=>c.heights.every(h=>h>=0&&h<=20)),'Volume outside bar range');
 $('railVolume').click();check($('strikeVolumes').hidden,'Volume toggle will not hide');
 const centerIndex=Number($('strikePan').value);
 slider(centerIndex+1,false);await wait(()=>Number($('strikePan').value)===centerIndex+1,'Browse rail');
 check(equal(strikes(),initial),'Browsing changed strategy strikes');
 slider(centerIndex+2,true);
 const shifted=initial.map((v,i)=>i===4?v:v+step);
 await expectStrikes(shifted,'Slider shifts all open positions');
 check(draft().legs[1].excluded&&draft().legs[4].closes.length===1,'Lost excluded flag or closing fill');
 const grouped=shifted.map((v,i)=>i===4?v:v+step);
 drag(cell(shifted[0]),cell(shifted[0]+step),true);await expectStrikes(grouped,'Rail shifts all open options');
 const mirrored=grouped.slice();mirrored[0]-=step;mirrored[3]+=step;
 drag(marker(0),cell(mirrored[0]),true);await expectStrikes(mirrored,'Condor outer pair');
 const crossed=mirrored[2];
 drag(marker(0),cell(crossed),true);
 await wait(()=>$('message').textContent.includes('cross another leg'),'Reject crossed wings');
 check(equal(strikes(),mirrored),'Crossed-wing move partially applied');
 const single=mirrored.slice();single[0]+=step;
 drag(marker(0),cell(single[0]),false);await expectStrikes(single,'Single leg drag');
 const external=new DataTransfer();external.setData('text/plain','0');
 cell(single[0]-step).dispatchEvent(new DragEvent('drop',{bubbles:true,cancelable:true,dataTransfer:external}));
 await delay(100);check(equal(strikes(),single),'External drop moved a position');
 slider(listed.length-1,true);
 await wait(()=>$('message').textContent.includes('did not list'),'Reject unavailable TWS strike');
 check(equal(strikes(),single),'Unavailable strike partially applied');
 return {initial,shifted,grouped,mirrored,single,iconCount:icons.length,volumeBars:volume.filter(c=>c.heights.some(Boolean)).length,volumeSample:volume.find(c=>c.heights.some(Boolean))??volume[0],closedLeg:draft().legs[4],rejected:$('message').textContent};
}
try{
 execFileSync('cargo',['build','--locked','--quiet'],{cwd:project,stdio:'inherit'});
 const port=await freePort(),base='http://127.0.0.1:'+port;
 backend=spawn(join(project,'target/debug/tws-options-lab'),['--port',String(port),'--data-dir',join(tmp,'library'),'--no-open'],{stdio:'ignore'});
 const api=async path=>{const r=await fetch(base+'/api/'+path,{signal:AbortSignal.timeout(55000)});if(!r.ok)throw Error(await r.text());return r.json()};
 await waitFor(()=>api('status'),'isolated Rust backend');
 const info=await api('instrument?symbol=SPX'),root=info.defaultRoot,expiry=info.roots[root].expiries[0];
 const book=await api('book?'+new URLSearchParams({symbol:info.symbol,root,expiry}));
 const listed=book.strikes;
 // Find a local run of listed calls and puts with equal increments for paired gestures.
 const choices=[];
 for(let i=7;i<listed.length-7;i++){
  const center=listed[i].strike,step=listed[i+1].strike-center;
  if(step>0&&listed.slice(i-7,i+8).every((r,j)=>r.C&&r.P&&Math.abs(r.strike-center-(j-7)*step)<1e-8))choices.push({center,step});
 }
 assert.ok(choices.length,'TWS has no suitable continuous SPX strike ladder for this check');
 const {center,step}=choices.reduce((a,b)=>Math.abs(a.center-7000)<Math.abs(b.center-7000)?a:b);
 report.listing={symbol:info.symbol,root,expiry,center,step,strikeCount:listed.length};
 browser=await testBrowser(tmp,waitFor);const {call,evalPage}=browser;
 async function nativeShiftGesture(){
  const snapshot=()=>evalPage("JSON.parse(localStorage.getItem('optionslab.draft.v1')).legs.map(l=>l.strike)");
  const initial=await snapshot();
  await evalPage("document.getElementById('strikePan').focus()");
  await call('Input.dispatchKeyEvent',{type:'keyDown',key:'ArrowRight',code:'ArrowRight',windowsVirtualKeyCode:39,modifiers:8});
  await call('Input.dispatchKeyEvent',{type:'keyUp',key:'ArrowRight',code:'ArrowRight',windowsVirtualKeyCode:39,modifiers:8});
  const moved=initial.map(v=>v+step);
  await waitFor(async()=>JSON.stringify(await snapshot())===JSON.stringify(moved),'trusted Shift+Right grouped strike change',5000);
  const tile=selector=>evalPage('(()=>{const b=document.querySelector('+JSON.stringify(selector)+').getBoundingClientRect();return {x:b.left+b.width/2,y:b.top+b.height/2}})()');
  const from=await tile('.marker[data-leg="0"] .marker-text'),to=await tile('.strike[data-strike="'+(moved[0]-step)+'"]');
  await call('Input.dispatchMouseEvent',{type:'mouseMoved',...from,modifiers:8});
  await call('Input.dispatchMouseEvent',{type:'mousePressed',...from,button:'left',buttons:1,clickCount:1,modifiers:8});
  await call('Input.dispatchMouseEvent',{type:'mouseMoved',x:from.x+7,y:from.y+1,button:'left',buttons:1,modifiers:8});
  await call('Input.dispatchMouseEvent',{type:'mouseMoved',...to,button:'left',buttons:1,modifiers:8});
  await call('Input.dispatchMouseEvent',{type:'mouseReleased',...to,button:'left',buttons:0,clickCount:1,modifiers:8});
  const paired=[moved[0]-step,moved[1],moved[2]+step];
  await waitFor(async()=>JSON.stringify(await snapshot())===JSON.stringify(paired),'trusted symmetric marker drop',5000);
  return {before:initial,keyboard:moved,mouse:paired};
 }
 for(const which of ['condor','butterfly','partial']){
  const leg=(right,offset,qty,extra={})=>({kind:'option',right,strike:center+offset*step,qty,entry:10,entryFeed:'Manual',root,expiry,...extra});
  const closed={qty:1,price:7.5,at:Date.now()};
  const legs=which==='condor'?[leg('P',-2,1),leg('P',-1,-1,{excluded:true}),leg('C',1,-1),leg('C',2,1),leg('C',-2,1,{closes:[closed]})]:
   which==='butterfly'?[leg('C',-2,1),leg('C',0,-2),leg('C',2,1)]:
   [leg('C',0,2,{closes:[closed]}),leg('C',2,-2)];
  const name='Rail verification '+which;
  const share={schema:1,symbol:info.symbol,root,expiry,legs,name};
  const url=base+'/?fixture='+which+'#strategy='+Buffer.from(JSON.stringify(share)).toString('base64url');
  await call('Page.navigate',{url});
  await waitFor(()=>evalPage("location.search==="+JSON.stringify('?fixture='+which)+"&&document.readyState==='complete'"),'fixture document');
  const details=await evalPage('('+runInPage.toString()+')('+[which,step,listed,name].map(v=>JSON.stringify(v)).join(',')+')');
  if(which==='butterfly')details.trustedGestures=await nativeShiftGesture();
  report.cases.push({name:which,passed:true,details});console.log('PASS '+which);
 }
 report.savedTrades=(await api('library')).length;assert.equal(report.savedTrades,0);
}catch(e){report.error=e.message;process.exitCode=1;console.error(e.message)}
finally{
 await writeFile(evidence,JSON.stringify(report,null,2)+'\n');
 await browser?.close();backend?.kill();
 await pause(300);await rm(tmp,{recursive:true,force:true,maxRetries:3,retryDelay:200});
 console.log('Evidence '+evidence);
}

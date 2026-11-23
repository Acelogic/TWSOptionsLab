// Browser phase of verify-manual-spreads.py. The harness provides a fresh
// profile and a native server bound to a temporary TWS fixture and library.
import assert from 'node:assert/strict';
import {readFile,writeFile} from 'node:fs/promises';
import {join} from 'node:path';
import {testBrowser} from './browser-fixture.mjs';

const [port,folder,phase,input,output]=process.argv.slice(2);
const state=JSON.parse(await readFile(input,'utf8'));
const pause=ms=>new Promise(resolve=>setTimeout(resolve,ms));
async function waitFor(probe,description,ms=12000){
 const deadline=Date.now()+ms;
 let last;
 while(Date.now()<deadline){
  try{const value=await probe();if(value)return value}catch(e){last=e}
  await pause(80);
 }
 throw Error('Timed out on '+description+(last?' ('+last.message+')':''));
}
const browser=await testBrowser(folder,waitFor),q=JSON.stringify;
const ev=expression=>browser.evalPage(expression);
async function click(selector){
 const point=await ev('(()=>{const el=document.querySelector('+q(selector)+');if(!el||el.disabled||!el.getClientRects().length)throw Error("Unavailable "+'+q(selector)+');el.scrollIntoView({block:"center",inline:"center",behavior:"instant"});const r=el.getBoundingClientRect();return{x:r.x+r.width/2,y:r.y+r.height/2}})()');
 await browser.call('Input.dispatchMouseEvent',{type:'mouseMoved',...point});
 await browser.call('Input.dispatchMouseEvent',{type:'mousePressed',...point,button:'left',clickCount:1});
 await browser.call('Input.dispatchMouseEvent',{type:'mouseReleased',...point,button:'left',clickCount:1});
}
const text=id=>ev('document.getElementById('+q(id)+').innerText');
const visible=selector=>ev('Boolean(document.querySelector('+q(selector)+')?.getClientRects().length)');
const change=(id,value,type='change')=>ev('(()=>{const el=document.getElementById('+q(id)+');el.value='+q(value)+';el.dispatchEvent(new Event('+q(type)+',{bubbles:true}))})()');
const trades=()=>ev('Array.from(document.querySelectorAll("#optionsHistoryTable tr[data-trade]"),r=>({id:r.dataset.trade,cells:Array.from(r.cells,c=>c.innerText)}))');
const orig=id=>'[data-group-trade="'+id+'"]';
try{
 await browser.call('Page.navigate',{url:'http://127.0.0.1:'+port+'/#saved'});
 await waitFor(()=>visible('#savedShow'),'Saved page');
 await change('savedShow','archived');
 await waitFor(()=>visible('#optionsHistoryPanel'),'historical trades');
 await change('optionsHistoryTicker',state.symbol,'input');
 await waitFor(async()=>(await trades()).length>0,'native broker trade rows');
 if(phase==='create'){
  assert.equal((await trades()).length,2);
  await click('#historyGroupStart');
  await click(orig(state.sourceIds[0]));
  assert.match(await text('historyGroupCount'),/1 whole trade/);
  await click('#optionsHistoryActivity');
  await waitFor(()=>visible('[data-group-fill="MANS-HI-OPEN.01"]'),'raw opening fill');
  await click('[data-group-fill="MANS-HI-OPEN.01"][data-fill-role="open"]');
  assert.match(await text('historyGroupCount'),/1 whole trade.*1 fill/s);
  await click('#optionsHistoryTrades');
  const retained=await ev('document.querySelector('+q(orig(state.sourceIds[0]))+').checked');
  assert.equal(retained,true);
  await change('historyGroupName',state.name,'input');
  await click('#historyGroupPreview');
  await waitFor(()=>ev('document.getElementById("historyGroupDialog").open'),'native preview');
  const preview=await text('historyGroupPreviewBody');
  assert.match(preview,new RegExp(state.whole.toFixed(2).replace('.','\\.')));
  assert.match(preview,/commission|opening fee|entry fee/i);
  assert.match(preview,/100/);assert.match(preview,/110/);
  const clip=await ev('(()=>{const d=document.getElementById("historyGroupDialog").getBoundingClientRect();return{x:Math.max(0,Math.floor(scrollX+d.x)),y:Math.max(0,Math.floor(scrollY+d.y)),width:Math.min(innerWidth,Math.ceil(d.width)),height:Math.min(innerHeight,Math.ceil(d.height)),scale:1}})()');
  const image=await browser.call('Page.captureScreenshot',{format:'png',clip});
  await writeFile(join(folder,'preview.png'),Buffer.from(image.data,'base64'));
  await click('#historyGroupBack');
  assert.equal(await ev('document.getElementById("historyGroupDialog").open'),false);
  assert.match(await text('historyGroupCount'),/1 whole trade.*1 fill/s);
  await click('#historyGroupCancel');
  assert.equal((await trades()).length,2);
  assert.equal(await visible('#historyGroupSelection'),false);
  await click('#historyGroupStart');
  await click(orig(state.sourceIds[0]));await click(orig(state.sourceIds[1]));
  await change('historyGroupName',state.name,'input');await click('#historyGroupPreview');
  await waitFor(()=>ev('document.getElementById("historyGroupDialog").open'),'second native preview');
  await click('#historyGroupSave');
  await waitFor(async()=>/Saved .*manual spread/i.test(await text('historyGroupMessage'))&&(await trades()).length===1,'saved manual trade');
  const row=(await trades())[0];
  assert.match(row.cells.join(' '),new RegExp(state.whole.toFixed(2).replace('.','\\.')));
  assert.match(row.cells.join(' '),new RegExp(state.name));
  await click('[data-trade-toggle="'+row.id+'"]');
  const detail=await text('optionsHistoryTable');assert.match(detail,/MANS-LO-OPEN\.01/);assert.match(detail,/MANS-HI-CLOSE2\.01/);
  assert.equal(await visible('[data-ungroup-trade]'),true);
  await writeFile(output,JSON.stringify({selectionRetainedAcrossViews:retained,previewNet:state.whole,previewCanceledBeforeSave:true,savedRow:row.cells,shownOpeningAndClosingIds:true}));
 }else if(phase==='undo'){
  const before=await trades();assert.equal(before.length,1);
  assert.match(before[0].cells.join(' '),new RegExp(state.name));
  await click('[data-trade-toggle="'+before[0].id+'"]');
  const undo='[data-ungroup-trade="'+state.manualId+'"]';
  await waitFor(()=>visible(undo),'persisted ungroup control');
  await click(undo);await waitFor(()=>ev('document.getElementById("historyUngroupDialog").open'),'ungroup confirmation');
  assert.match(await text('historyUngroupCopy'),new RegExp(state.name));
  await click('#historyUngroupBack');assert.equal((await trades()).length,1);
  await click(undo);await click('#historyUngroupConfirm');
  await waitFor(async()=>/Ungrouped/i.test(await text('historyGroupMessage'))&&(await trades()).length===2,'ungrouped source trades');
  const restored=(await trades()).map(r=>r.id).sort();
  assert.deepEqual(restored,[...state.sourceIds].sort());
  await change('optionsHistoryTicker','NOFEE','input');await click('#historyGroupStart');
  const choices=await ev('Array.from(document.querySelectorAll("[data-group-trade]"),e=>e.dataset.groupTrade)');
  assert.equal(choices.length,2);
  for(const id of choices)await click(orig(id));
  await click('#historyGroupPreview');
  await waitFor(()=>ev('document.getElementById("historyGroupDialog").open'),'unpriced commission preview');
  const feeNet=await ev('document.querySelector("#historyGroupPreviewBody .history-preview-total").innerText');
  assert.match(feeNet,/—|unavailable|unpriced/i);assert.doesNotMatch(feeNet,/\$0\.00/);
  assert.match(await text('historyGroupPreviewBody'),/commission.*missing|missing.*commission|unavailable commission/i);
  await click('#historyGroupBack');await click('#historyGroupCancel');
  await writeFile(output,JSON.stringify({visibleAfterServiceRestart:true,canceledUngroupKeptSpread:true,originalTradesRestored:restored.length,missingCommissionDisplayed:feeNet}));
 }else throw Error('Unknown browser phase');
}finally{await browser.close()}

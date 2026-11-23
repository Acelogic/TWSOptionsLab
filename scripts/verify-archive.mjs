// Run with Chrome. Uses a private SQLite library, private browser profile and an unavailable TWS port.
import assert from 'node:assert/strict';
import {execFileSync,spawn} from 'node:child_process';
import {mkdtemp,rm,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {dirname,join,resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import net from 'node:net';
import {testBrowser} from './browser-fixture.mjs';

const project=resolve(dirname(fileURLToPath(import.meta.url)),'..');
const dir=await mkdtemp(join(tmpdir(),'tws-archive-e2e-'));
const output=process.argv[2]||'archive-evidence.json';
const report={time:new Date().toISOString(),passed:false};
const delay=ms=>new Promise(resolve=>setTimeout(resolve,ms));
async function waitFor(probe,description){
 for(let i=0;i<200;i++){try{const value=await probe();if(value)return value}catch{}await delay(100)}
 throw Error('Timed out waiting for '+description);
}
async function freePort(){
 const listener=net.createServer();await new Promise(resolve=>listener.listen(0,'127.0.0.1',resolve));
 const port=listener.address().port;await new Promise(resolve=>listener.close(resolve));return port;
}
let server,browser;
try{
 execFileSync('cargo',['build','--locked','--quiet'],{cwd:project,stdio:'inherit'});
 const port=await freePort(),unused=await freePort(),base='http://127.0.0.1:'+port;
 server=spawn(join(project,'target/debug/tws-options-lab'),['--port',String(port),'--tws-port',String(unused),'--no-open','--data-dir',join(dir,'db')],{cwd:project,stdio:'ignore'});
 async function api(path,body){
  const reply=await fetch(base+'/api/'+path,body?{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)}:{});
  const data=await reply.json();if(!reply.ok)throw Error(data.error||reply.status);return data;
 }
 await waitFor(()=>api('status'),'isolated server');
 const at=Date.UTC(2024,11,20,17),later=Date.UTC(2025,0,4,16);
 const option={kind:'option',symbol:'AAPL',secType:'OPT',currency:'USD',root:'AAPL',expiry:'20241220',right:'C',strike:300,
  qty:3,entry:2.2,multiplier:100,conId:null,closes:[{qty:1,price:1,at},{qty:2,price:0,confirmedClosedBy:later,reason:'expiredWorthless'}]};
 const shares={kind:'stock',symbol:'AAPL',currency:'USD',secType:'STK',conId:265598,qty:-5,entry:20,multiplier:1,closes:[{qty:5,price:18,at}]};
 const incoming={name:'Completed split-fill archive',document:{schema:1,symbol:'AAPL',currency:'USD',root:'AAPL',expiry:'20241220',
  commissionPerContract:1.25,legs:[option,shares],source:{provider:'E2E fixture',recordId:'archive-fixture',realizedPnl:-550}}};
 assert.equal((await api('import',{strategies:[incoming]})).count,1);
 assert.equal((await api('import',{strategies:[incoming]})).count,0);
 const [saved]=await api('library');assert.deepEqual(saved.document,incoming.document);
 assert.equal(saved.document.legs[0].closes[1].at,undefined);
 const history=await api('history',saved.document);
 assert.deepEqual(history.points,[]);assert.match(history.message,/Archived/);assert.match(history.message,/confirmed-by/);
 for(const changes of [{qty:4},{qty:4,excluded:true},{kind:'stock'},{conId:0},{expiry:'20990119'},
  {closes:[{qty:3,price:1}]},{closes:[{qty:3,price:1,at,confirmedClosedBy:later}]},{closes:[{qty:3,price:1,confirmedClosedBy:Date.now()+86400000}]}]){
  const bad=structuredClone(incoming);Object.assign(bad.document.legs[0],changes);
  await assert.rejects(api('import',{strategies:[bad]}));
 }
 assert.equal((await api('library')).length,1);
 const mark=await waitFor(async()=>(await api('marks?id='+saved.id)).at(-1),'confirmed realized mark');
 assert.ok(Math.abs(mark[1]+557.5)<1e-8);assert.equal(mark[2],0);

 browser=await testBrowser(dir,waitFor);await browser.call('Page.navigate',{url:base});
 await waitFor(()=>browser.evalPage("typeof document.querySelector('[data-page=saved]')?.onclick==='function'"),'library navigation');
 await browser.evalPage("document.querySelector('[data-page=saved]').click()");
 await browser.evalPage("(()=>{const show=document.getElementById('savedShow');show.value='archived';show.dispatchEvent(new Event('change',{bubbles:true}))})()");
 await waitFor(()=>browser.evalPage("!!document.querySelector('#library [data-open]')"),'saved trade');
 await browser.evalPage("document.querySelector('#library [data-open]').click()");
 const view=await waitFor(()=>browser.evalPage("document.getElementById('archiveTrade').open&&({title:document.getElementById('archiveTitle').textContent,summary:document.getElementById('archiveSummary').textContent,fills:document.getElementById('archiveFills').innerText})"),'archive details');
 assert.equal(view.title,incoming.name);assert.match(view.summary,/-557.5 USD/);assert.match(view.summary,/7.5 in commissions/);
 assert.match(view.fills,/Confirmed closed by/);assert.match(view.fills,/execution time unknown/);assert.match(view.fills,/Expired worthless/);assert.match(view.fills,/AAPL shares/);
 // Reconfirm unchanged economics later. The older observation now has unknown timing and must disappear.
 const changed=structuredClone(incoming),bound=Math.max(Date.now(),mark[0]+1);
 await delay(5);changed.document.legs[0].closes[1].confirmedClosedBy=bound;delete changed.document.source;
 const updated=await api('save',{...changed,id:saved.id,version:saved.version});assert.equal(updated.id,saved.id);
 const finalMarks=await waitFor(async()=>{const rows=await api('marks?id='+saved.id);return rows.length&&rows.every(m=>m[0]>=bound)&&rows},'filtered historical observations');
 assert.equal(finalMarks.at(-1)[2],0);assert.ok(Math.abs(finalMarks.at(-1)[1]+557.5)<1e-8);
 assert.deepEqual((await api('library')).find(s=>s.id===updated.id).document.source,incoming.document.source);
 const fork=structuredClone(changed);fork.document.commissionPerContract=.5;
 const forked=await api('save',{...fork,...updated});assert.notEqual(forked.id,updated.id);
 assert.equal((await api('library')).find(s=>s.id===forked.id).document.source,undefined);
 report.passed=true;Object.assign(report,{unqualifiedOption:saved.document.legs[0],validationRejections:8,sourceRetained:true,forkWithoutSource:true,observedMark:mark,latestConfirmedBy:bound,visibleObservations:finalMarks,historyMessage:history.message,browser:view});
 console.log('PASS archived imports, monetary accounting, historical boundaries and offline browser reopening');
}catch(error){report.error=error.message;console.error(error);process.exitCode=1}
finally{
 await writeFile(output,JSON.stringify(report,null,2)+'\n');
 await browser?.close();server?.kill('SIGTERM');await rm(dir,{recursive:true,force:true,maxRetries:4,retryDelay:100});
}

// node scripts/verify-saved-trades.mjs [evidence.json]
// Uses Chrome and the native Rust application. Broker traffic stays on private loopback sockets.
import assert from 'node:assert/strict';
import {spawn,execFileSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import {mkdtemp,readFile,readdir,rm,writeFile} from 'node:fs/promises';
import {createServer} from 'node:http';
import net from 'node:net';
import {tmpdir} from 'node:os';
import {dirname,extname,join,resolve,sep} from 'node:path';
import {fileURLToPath} from 'node:url';
import {testBrowser} from './browser-fixture.mjs';

const project=resolve(dirname(fileURLToPath(import.meta.url)),'..'),web=join(project,'web');
const scratch=await mkdtemp(join(tmpdir(),'tws-saved-trades-e2e-')),output=process.argv[2];
const section=process.argv[3]==='--case'?process.argv[4]:'all';
const clock=Date.parse('2026-11-23T15:30:00Z');
const day=86400000,at=date=>Date.parse(date+'T17:00:00Z');
const report={time:new Date().toISOString(),fixtureClock:new Date(clock).toISOString(),files:{},cases:[]};
// Closed-session regressions to exercise before accepting a daily-return change.
report.closedSessionFailureModes=[
 'A weekend or exchange holiday selects a civil date with no completed trading session.',
 'An early close stays in live mode after the actual exchange close, or a reopen inherits the old closed-period label.',
 'A prior close is substituted for a missing historical observation, producing a fabricated zero.',
 'A short trade changes sign, a partial close loses realized P&L or exit fees, or a newly opened trade acquires a pre-entry return.',
 'An unknown opening or closing time is treated as known, or an estimate is displayed as a confirmed return.',
 'A single header date masks mixed trading dates or remains visible on live rows; the row and its trade overview disagree.'
];
const delay=ms=>new Promise(resolve=>setTimeout(resolve,ms));
async function waitFor(probe,reason,ms=20000){
 const deadline=Date.now()+ms;let last;
 while(Date.now()<deadline){try{last=await probe();if(last)return last}catch(e){last=e.message}await delay(50)}
 throw Error('Timed out waiting for '+reason+' (last='+JSON.stringify(last)+')');
}
const listen=server=>new Promise(resolve=>server.listen(0,'127.0.0.1',()=>resolve(server.address().port)));
const closeServer=server=>new Promise(resolve=>server.close(resolve));
function passed(name,details){report.cases.push({name,details});console.log('PASS '+name)}
function expectedPercent(text,expected){
 const found=text.match(/([+−-]?[\d,]+(?:\.\d+)?)\s*%/);
 assert.ok(found,'Missing return percentage in '+text);
 const number=found[1].replaceAll(',','').replace('−','-'),places=number.split('.')[1]?.length??0;
 assert.ok(Math.abs(Number(number)-expected)<=.5*10**-places+1e-8,'Wrong return percentage in '+text+' for '+expected);
}
function option(symbol,conId,expiry,qty=1,entry=5){
 return {kind:'option',secType:'OPT',symbol,root:symbol,conId,expiry,right:'C',strike:100,qty,entry,multiplier:100,currency:'USD'};
}
function item(id,symbol,name,legs,created,group=''){
 return {id,version:1,name,createdAt:created,created,updated:created+3*day,
  document:{schema:1,name,symbol,root:symbol,expiry:legs[0].expiry,currency:'USD',pricing:'mid',
   openedAt:created,libraryGroup:group,commissionPerContract:1.25,legs}};
}
const trades=[
 item('open-a','AAPL','Zebra debit',[{...option('AAPL',1101,'20261218',2),closes:[{qty:1,price:6,at:clock-3600000}]}],at('2026-11-03'),'Core'),
 item('open-s','SPY','Alpha credit',[option('SPY',2101,'20261127',-1)],at('2026-11-21'),'Hedges'),
 item('open-m','MSFT','Aardvark calendar',[option('MSFT',3101,'20270115')],at('2026-11-12'),'Core'),
 item('closed','NVDA','Split exit',[{...option('NVDA',null,'20251121',2),closes:[{qty:1,price:6,at:at('2025-11-01')},{qty:1,price:7.5,at:at('2025-11-20')}]}],at('2025-10-03'),'Core'),
 item('expired','AMD','Unmarked expiration',[option('AMD',4101,'20261120')],at('2026-10-12'),'Hedges')
];
// A heavily edited older trade must still sort by its original creation time.
trades[0].updated=clock-3600000;
trades[1].updated=at('2026-11-22');
const classic={basis:500,currency:'USD',status:'open',marketValue:500,source:'live',feed:'Live',markSource:'Midpoint',receivedAt:clock,detail:'Fixture live midpoint',daySource:'TWS prior close'};
let phase=0,networkFailure=false,polls=0,lastPoll=0,holdNext=false,releaseSnapshot=null;
let sessionReplay=null,sessionView=null;
function snapshots(){
 if(sessionView)return sessionView;
 const entry=trades[0],mid=phase===1?7.5:7;
 const pnl=(6-5)*100+(mid-5)*100-(2+1)*1.25;
 const dayPnl=pnl-((5.5-5)*2*100-2*1.25);
 const active=phase===2?{totalPnl:null,totalPct:null,dayPnl:null,dayPct:null,marketValue:null,source:'unavailable',feed:null,markSource:null,receivedAt:null,detail:'TWS disconnected. No saved mark available.'}:
  {totalPnl:pnl,totalPct:pnl/10,dayPnl,dayPct:dayPnl/10,marketValue:mid*100};
 const rows={
  [entry.id]:{...classic,basis:1000,...active},
  'open-s':{...classic,totalPnl:123.75,totalPct:24.75,dayPnl:null,dayPct:null,daySource:null,marketValue:-375,detail:'Missing previous close'},
  'open-m':{...classic,totalPnl:-51.25,totalPct:-10.25,dayPnl:-25,dayPct:-5,marketValue:450},
  closed:{...classic,status:'closed',totalPnl:345,totalPct:34.5,basis:1000,dayPnl:0,dayPct:0,marketValue:0,source:'realized',feed:null,markSource:'Closing fills',receivedAt:at('2025-11-20')},
  expired:{...classic,status:'expired',totalPnl:null,totalPct:null,dayPnl:null,dayPct:null,marketValue:null,source:'unavailable',feed:null,receivedAt:null,markSource:null,detail:'Expired contract has no settlement price.'}
 };
 for(const [id,row] of Object.entries(rows))Object.assign(row,{id,version:1});
 return {asOf:clock+polls*1000,mode:1,connected:phase!==2,rows};
}
const writes=[];
const fixtureServer=createServer(async(req,res)=>{
 try{
  const url=new URL(req.url,'http://127.0.0.1');
  if(!url.pathname.startsWith('/api/')){
   const path=resolve(web,'.'+(url.pathname==='/'?'/index.html':url.pathname));
   if(!path.startsWith(web+sep)){res.writeHead(404).end();return}
   const mime={'.js':'text/javascript','.html':'text/html','.css':'text/css','.woff2':'font/woff2'}[extname(path)];
   const asset=await readFile(path);res.writeHead(200,{'Content-Type':mime||'application/octet-stream','Cache-Control':'no-store'}).end(asset);return;
  }
  const respond=(status,value)=>res.writeHead(status,{'Content-Type':'application/json','Cache-Control':'no-store'}).end(JSON.stringify(value));
  if(req.method!=='GET'&&url.pathname!=='/api/quotes')writes.push(url.pathname);
  if(url.pathname==='/api/saved-snapshots'){
   polls++;lastPoll=Date.now();const status=networkFailure?503:200,data=networkFailure?{error:'Fixture service unreachable'}:snapshots();
   if(holdNext){holdNext=false;releaseSnapshot=()=>{if(!res.destroyed)respond(status,data);releaseSnapshot=null};return}
   respond(status,data);return;
  }
  if(url.pathname==='/api/library'){respond(200,sessionView?sessionReplay.library:trades);return}
  if(url.pathname==='/api/instrument'){respond(200,{symbol:'SPX',ticker:'SPX',currency:'USD',secType:'IND',conId:900,exchange:'CBOE',roots:{},defaultRoot:null});return}
  if(url.pathname==='/api/quotes'){respond(200,{quotes:{900:{mid:7000,feed:'Live',at:clock}},lines:1,time:clock});return}
  respond(404,{error:'Unexpected fixture route '+url.pathname});
 }catch(error){res.writeHead(404).end(error.message)}
});
let browser,native,offline;
async function nativeAccounting(){
 execFileSync('cargo',['build','--locked','--quiet'],{cwd:project,stdio:'inherit'});
 const reservation=net.createServer();const port=await listen(reservation);await closeServer(reservation);
 offline=net.createServer(socket=>socket.destroy());const twsPort=await listen(offline);
 native=spawn(join(project,'target/debug/tws-options-lab'),['--no-open','--port',String(port),'--tws-port',String(twsPort),'--data-dir',join(scratch,'db')],{cwd:project,stdio:'ignore'});
 const api=async(p,body)=>{
  const res=await fetch('http://127.0.0.1:'+port+'/api/'+p,body?{method:'POST',body:JSON.stringify(body),headers:{'Content-Type':'application/json'}}:{});
  const data=await res.json();if(!res.ok)throw Error(data.error||res.status);return data;
 };
 await waitFor(()=>api('library'),'isolated native library');assert.deepEqual(await api('library'),[]);
 const closed=structuredClone(trades.find(s=>s.id==='closed'));
 const open=item('native-open','QA','Unpriced open contract',[option('QA',51,'20991231')],at('2020-06-01'));
 const expired=item('native-expired','QB','Unpriced expired contract',[option('QB',52,'20011116')],at('2000-06-01'));
 const excluded=item('native-excluded','QA','Excluded contracts',[{...option('QA',53,'20991231'),excluded:true}],at('2020-06-01'));
 const zero=item('native-zero','QC','Zero-net-entry realized trade',[
  {...option('QC',null,'20251121'),closes:[{qty:1,price:7,at:at('2025-11-01')}]},
  {...option('QC',null,'20251121',-1),right:'P',closes:[{qty:1,price:3,at:at('2025-11-18')}]}
 ],at('2025-06-01'));
 const ids={};
 for(const trade of [closed,open,expired,excluded,zero])ids[trade.id]=(await api('save',{name:trade.name,document:trade.document})).id;
 const data=await api('saved-snapshots?mode=1'),result={};
 for(const [key,id] of Object.entries(ids)){const row=data.rows[id];assert.ok(row,'Missing native result '+key);result[key]=row}
 assert.equal(result.closed.status,'closed');assert.equal(result.closed.totalPnl,345);assert.equal(result.closed.totalPct,34.5);
 assert.equal(result.closed.dayPnl,0);assert.equal(result.closed.marketValue,0);
 assert.equal(result['native-zero'].totalPnl,395);assert.equal(result['native-zero'].totalPct,null);
 assert.equal(result['native-open'].status,'open');assert.equal(result['native-open'].totalPnl,null);
 assert.equal(result['native-expired'].status,'expired');assert.equal(result['native-expired'].totalPnl,null);
 assert.equal(result['native-excluded'].status,'excluded');assert.equal(result['native-excluded'].totalPnl,null);
 passed('Native accounting with isolated SQLite and disconnected broker',Object.fromEntries(Object.entries(result).map(([k,v])=>[k,{status:v.status,totalPnl:v.totalPnl,totalPct:v.totalPct,dayPnl:v.dayPnl,basis:v.basis,source:v.source,detail:v.detail}])));
}
async function verifyPage(){
 const fixturePort=await listen(fixtureServer);
 browser=await testBrowser(scratch,waitFor);
 await browser.call('Page.enable');await browser.call('Runtime.enable');
 await browser.call('Page.addScriptToEvaluateOnNewDocument',{source:'window.savedFixtureClock='+clock+';window.savedFixtureStart=performance.now();Date.now=()=>savedFixtureClock+Math.floor(performance.now()-savedFixtureStart)'});
 await browser.call('Page.navigate',{url:'http://127.0.0.1:'+fixturePort});
 const evaluate=s=>browser.evalPage(s);
 const click=sel=>evaluate('document.querySelector('+JSON.stringify(sel)+').click()');
 const select=(id,value)=>evaluate('(()=>{const e=document.getElementById('+JSON.stringify(id)+');e.value='+JSON.stringify(value)+';e.dispatchEvent(new Event("change",{bubbles:true}))})()');
 const rows=()=>evaluate('[...document.querySelectorAll("#library tr[data-trade-id]")].map(r=>({id:r.dataset.tradeId,text:r.innerText,total:r.querySelector("[data-field=total]")?.innerText,day:r.querySelector("[data-field=day]")?.innerText,totalClass:r.querySelector("[data-field=total]")?.className,totalTitle:r.querySelector("[data-field=total]")?.title,dayTitle:r.querySelector("[data-field=day]")?.title}))');
 const ids=async()=>(await rows()).map(x=>x.id);
 const get=async id=>(await rows()).find(r=>r.id===id);
 const header=()=>evaluate('[...document.querySelectorAll("#library thead th")].map(el=>el.innerText.trim())');
 const feed=()=>evaluate('document.getElementById("savedFeed").textContent');
 const read=selector=>evaluate('document.querySelector('+JSON.stringify(selector)+').value');
 async function closedSessionView(){
  async function show(name){
   sessionView=sessionReplay.envelopes[name];
   await evaluate('window.savedFixtureClock='+sessionView.asOf+';window.savedFixtureStart=performance.now()');
  }
  await show('weekend');
  await click('[data-page=build]');await click('[data-page=saved]');
  const dateHeader=()=>evaluate('({text:document.getElementById("savedDayDate")?.textContent,visible:document.getElementById("savedDayDate")?.hidden===false})');
  await waitFor(async()=>/Nov 20/.test((await dateHeader()).text),'closed weekend header');
  assert.equal((await dateHeader()).visible,true);
  const weekend=await get('long'),estimated=await get('unknown-opening'),missing=await get('missing-latest');
  assert.match(weekend.day,/400/);expectedPercent(weekend.day,40);
  assert.match(weekend.dayTitle,/Nov 19.*Nov 20/);assert.doesNotMatch(weekend.day,/Nov 20|estimate/i);
  assert.match(estimated.day,/Current-position estimate/i);assert.match(estimated.dayTitle,/remaining quantity/i);assert.match(estimated.dayTitle,/fill times are incomplete/i);
  assert.match(missing.day,/—/);assert.doesNotMatch(missing.day,/\$0|0%|estimate/i);
  await click('#library [data-manage="unknown-opening"]');
  await waitFor(()=>evaluate('document.getElementById("savedTradeDetails").open'),'trade overview');
  const explanation=await evaluate('document.querySelector("#savedTradeDetails").innerText');
  assert.match(explanation,/Nov 19.*Nov 20/);assert.match(explanation,/estimat/i);
  await click('#savedTradeDetails [data-saved-action="close"]');
  passed('Weekend return brings actual Rust values, session dates, estimated exposure and missing prices into the Saved list and overview',{weekend,estimated,missing,explanation});
  await show('holiday');
  await waitFor(async()=>/Nov 25/.test((await dateHeader()).text),'Thanksgiving remains on Wednesday');
  const holiday=await get('long');assert.match(holiday.dayTitle,/Nov 24.*Nov 25/);
  await show('beforeEarlyClose');
  await waitFor(async()=>!(await dateHeader()).visible&&(await get('long'))?.day?.includes('600'),'early-close day still trading');
  await show('afterEarlyClose');
  await waitFor(async()=>/Nov 27/.test((await dateHeader()).text),'after early-close display');
  const early=await get('long');assert.match(early.dayTitle,/Nov 25.*Nov 27/);
  passed('Holiday and shortened session transitions select the actual dated trading sessions',{holiday,early});
  await show('mixedMarkets');
  await waitFor(async()=>!(await dateHeader()).visible&&(await get('long'))?.day?.includes('Nov 25'),'per-row dates for mixed sessions');
  assert.match((await get('short-natural')).day,/Nov 26/);
  assert.doesNotMatch((await get('long-natural')).day,/Nov 25|Nov 26|last session/i);
  const mixed={header:await dateHeader(),closed:(await get('short-natural')).day,live:(await get('long-natural')).day};
  await show('reopen');
  await waitFor(async()=>(await get('long'))?.day?.includes('600')&&!(await get('short-natural'))?.day?.includes('Nov 26'),'normal live reopen');
  const live=await get('long');
  assert.equal((await dateHeader()).visible,false);assert.doesNotMatch(live.dayTitle,/Last trading day/);expectedPercent(live.day,60);
  passed('Mixed-session rows keep their own dates and reopening clears the closed-period label automatically',{mixed,live});
 }
 await waitFor(()=>evaluate('typeof document.querySelector("[data-page=saved]")?.onclick==="function"'),'saved-trades navigation');
 await click('[data-page=saved]');
 await waitFor(async()=>polls&&(await rows()).length===3&&(await get('open-a'))?.total?.match(/296/),'first valued trade snapshot');
 if(section==='sessions'){await closedSessionView();return}
 assert.equal(await read('#savedSort'),'symbol');assert.equal(await read('#savedShow'),'active');
 assert.deepEqual(await ids(),['open-a','open-m','open-s']);
 const headings=(await header()).join(' ');assert.match(headings,/Total Return/i);assert.match(headings,/Today.s Return/i);
 const a=await get('open-a'),s=await get('open-s');assert.match(a.total,/296\.25/);assert.match(a.day,/198\.75/);assert.match(s.total,/123\.75/);assert.doesNotMatch(s.day,/\$0|0%/);
 assert.match(a.text,/Nov 3, 2026/);assert.match(a.text,/25d\s+\(12\/18\/26\)/);assert.match(s.text,/4d\s+\(11\/27\/26\)/);
 expectedPercent(a.total,29.625);expectedPercent(a.day,19.875);expectedPercent(s.total,24.75);
 assert.match(a.totalClass,/return-gain/);assert.match((await get('open-m')).totalClass,/return-loss/);
 passed('Default active symbol order, partial close, fees and missing daily baseline',{headings,a,s,feed:await feed()});
 const bands=await evaluate('[...document.querySelectorAll("#library tr.saved-symbol")].map(r=>r.innerText.trim())');
 assert.equal(bands.length,3);assert.match(bands.join(' '),/AAPL.*MSFT.*SPY/s);
 await select('savedGroup','Core');await waitFor(async()=>JSON.stringify(await ids())===JSON.stringify(['open-a','open-m']),'Core group filter');
 await select('savedGroup','Hedges');await waitFor(async()=>JSON.stringify(await ids())===JSON.stringify(['open-s']),'Hedges group filter');
 await select('savedGroup','');await waitFor(async()=>(await ids()).length===3,'all groups');
 passed('Group filtering and symbol bands',{bands,groups:['Core','Hedges']});
 await click('#savedEdit');await waitFor(()=>evaluate('!document.querySelector("#savedCancelEdit").hidden'),'edit mode controls');
 const selection='#library tr[data-trade-id="open-a"] input[type=checkbox]';
 await click(selection);
 assert.match(await evaluate('document.querySelector("#savedDeleteSelected").textContent'),/1/);
 await click('#savedCancelEdit');await waitFor(()=>evaluate('document.querySelector("#savedCancelEdit").hidden'),'exit edit mode');
 assert.deepEqual(await ids(),['open-a','open-m','open-s']);assert.deepEqual(writes,[]);
 passed('Edit List can select and cancel without touching storage',{trade:'open-a'});
 for(const [value,expected] of [['name',['open-m','open-s','open-a']],['expiry',['open-s','open-a','open-m']],['created',['open-s','open-m','open-a']]]){
  await select('savedSort',value);await waitFor(async()=>JSON.stringify(await ids())===JSON.stringify(expected),'sort by '+value);
 }
 passed('Alphabetical names, increasing expiry and newest creation date',{activeRows:await ids()});
 await select('savedShow','archived');await waitFor(async()=>(await rows()).length===2,'archived rows');
 const archiveHead=(await header()).join(' ');assert.match(archiveHead,/Expired|Closed/i);assert.doesNotMatch(archiveHead,/Today.s Return/i);
 const c=await get('closed'),e=await get('expired');assert.match(c.total,/345/);assert.doesNotMatch(e.total,/\$0|0%/);assert.equal(c.day,undefined);
 assert.match(c.text,/Closed \(Nov 20, 2025/);assert.match(e.text,/Expired \(Nov 20, 2026/);
 await select('savedShow','all');await waitFor(async()=>(await rows()).length===5,'all saved trades');assert.match((await header()).join(' '),/Today.s Return/i);
 passed('Closed, expired and all filters',{archiveHead,closed:c,expired:e});
 await browser.call('Browser.setDownloadBehavior',{behavior:'allow',downloadPath:scratch});
 await click('#export');
 const portable=await waitFor(async()=>JSON.parse(await readFile(join(scratch,'options-lab-strategies.json'),'utf8')),'private library download');
 assert.equal(portable.schema,1);assert.deepEqual(portable.strategies,trades.map(({name,document})=>({name,document})));
 passed('Local export retains every saved strategy and its document',{schema:portable.schema,names:portable.strategies.map(s=>s.name)});
 await select('savedShow','active');await select('savedSort','symbol');
 const count=polls;phase=1;
 await waitFor(async()=>polls>count&&(await get('open-a'))?.total?.includes('346.25'),'hands-free live mark change');
 const changed=await get('open-a');assert.match(changed.day,/248\.75/);expectedPercent(changed.total,34.625);expectedPercent(changed.day,24.875);assert.deepEqual(await ids(),['open-a','open-m','open-s']);
 passed('Automatic polling updates the correct trade and both return columns',{pollsSinceNoInput:polls-count,lastPoll,changed});
 phase=2;await waitFor(async()=>{const r=await get('open-a');return r&&!r.total.match(/346\.25|\$0|0%/)},'missing offline market data');
 const missing=await get('open-a');assert.doesNotMatch(missing.day,/248\.75|\$0|0%/);
 phase=0;await waitFor(async()=>(await get('open-a'))?.total?.includes('296.25'),'recover broker snapshot');
 passed('Offline snapshot does not invent a zero return and normal polling recovers',{missing,recovered:await get('open-a')});
 await select('savedShow','all');await waitFor(async()=>(await rows()).length===5,'all rows before transport outage');
 networkFailure=true;const beforeOutage=polls;
 await waitFor(async()=>polls>beforeOutage&&/offline|stale|unavailable|unreachable|disconnected|failed/i.test(await feed()),'visible service outage status');
 const outageLabel=await feed();assert.match((await get('closed')).total,/345/);
 networkFailure=false;phase=1;await waitFor(async()=>(await get('open-a'))?.total?.includes('346.25'),'recover after HTTP service outage');
 passed('Transport outage retains realized trade and recovers automatically',{outageLabel,closed:await get('closed')});
 holdNext=true;await waitFor(()=>releaseSnapshot,'late previous visit snapshot');
 await click('[data-page=build]');phase=0;await click('[data-page=saved]');
 await waitFor(async()=>(await get('open-a'))?.total?.includes('296.25'),'new visit fresh values');
 releaseSnapshot();await delay(150);
 const newVisit=await get('open-a');assert.match(newVisit.total,/296\.25/);assert.match(newVisit.day,/198\.75/);
 passed('Leaving and reopening the saved page rejects a delayed quote from the prior visit',{retained:newVisit});
 if(sessionReplay)await closedSessionView();
 assert.deepEqual(writes,[]);
}
try{
 const files=['web/app.js','web/saved.js','web/saved-actions.js','web/index.html',...(await readdir(join(project,'src'),{recursive:true})).filter(n=>n.endsWith('.rs')).map(n=>'src/'+n)];
 if(section==='all'||section==='sessions')files.push('scripts/verify-saved-trades.mjs','scripts/saved-session-replay.mjs','scripts/saved-session-adapter.rs');
 for(const name of files)report.files[name]=createHash('sha256').update(await readFile(join(project,name))).digest('hex');
 assert.ok(['all','native','browser','sessions'].includes(section),'Use --case native, browser or sessions');
 if(section==='all'||section==='sessions'){
  const {replaySavedSessions}=await import('./saved-session-replay.mjs');
  sessionReplay=await replaySavedSessions({project,scratch,option,item});
  passed('Actual Rust session selection and return arithmetic with dated market observations',sessionReplay.details);
 }
 if(section==='all'||section==='native')await nativeAccounting();
 if(section!=='native')await verifyPage();
 report.passed=true;
 }catch(e){report.passed=false;report.error=e.stack;report.polls=polls;if(browser)report.visible=await browser.evalPage('({clock:new Date(Date.now()).toISOString(),table:document.querySelector("#saved")?.innerText||""})').catch(()=>null);console.error(e.stack);process.exitCode=1}
finally{
 releaseSnapshot?.();
 await browser?.close();
 if(native&&native.exitCode===null&&native.signalCode===null){const exit=new Promise(resolve=>native.once('exit',resolve));native.kill('SIGTERM');await exit}
 if(offline?.listening)await closeServer(offline);
 fixtureServer.closeAllConnections();if(fixtureServer.listening)await closeServer(fixtureServer);
 await rm(scratch,{recursive:true,force:true,maxRetries:8,retryDelay:100});
 if(output)await writeFile(output,JSON.stringify(report,null,2)+'\n');else console.log(JSON.stringify(report,null,2));
}

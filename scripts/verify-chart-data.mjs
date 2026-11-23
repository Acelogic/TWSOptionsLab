// End-to-end browser verification against deterministic IBKR-shaped HTTP responses.
// Run: node scripts/verify-chart-data.mjs [evidence.json]. Set CHROME_BIN to select Chrome.
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {createHash} from 'node:crypto';
import {mkdtemp,readFile,rm,writeFile} from 'node:fs/promises';
import {createServer} from 'node:http';
import {tmpdir} from 'node:os';
import {dirname,extname,join,resolve,sep} from 'node:path';
import {fileURLToPath} from 'node:url';
import {browserExecutable} from './browser-fixture.mjs';

const web=resolve(dirname(fileURLToPath(import.meta.url)),'../web');
const now=Date.parse('2026-11-01T03:30:00Z'); // October 31 in Eastern time, before the fall clock change.
const expiry='20261218',farExpiry='20270319',symbols=['AAA','BBB','CCC','IDX'];
const index=symbol=>symbols.indexOf(symbol)+1;
const underlying=symbol=>index(symbol)*1000;
const chain=(symbol,e)=>[90,95,100,105,110].map((strike,i)=>{
 const id=underlying(symbol)+(e===farExpiry?200:100)+2*i;
 return {strike,C:id,P:id+1};
});
const info=symbol=>({symbol,ticker:symbol,secType:symbol==='IDX'?'IND':'STK',conId:underlying(symbol),
 currency:'USD',exchange:'SMART',primaryExchange:'NASDAQ',style:symbol==='IDX'?'EU':'US',defaultRoot:symbol,
 roots:{[symbol]:{multiplier:100,expiries:[expiry,farExpiry]}}});
const listed=(symbol,e)=>({symbol,root:symbol,expiry:e,settlement:'PM',currency:'USD',
 expiresAt:Date.parse(e===expiry?'2026-12-18T21:00:00Z':'2027-03-19T20:00:00Z'),strikes:chain(symbol,e)});
const traded=(symbol,e,strike=100,right='C')=>({kind:'option',symbol,root:symbol,right,strike,expiry:e,qty:1,entry:10,entryFeed:'Manual',
 multiplier:100,conId:chain(symbol,e).find(r=>r.strike===strike)[right]});
const events=[
 ['20261031','Earnings opening boundary'],['2026-11-01T02:15:00Z','Ex-dividend UTC crossing'],
 ['2026-11-15','Earnings weekend'],['2026/12/18','Ex-dividend expiry boundary'],
 ['20261030','Earnings before window'],['20261219','Earnings extended window'],
 ['2026-11-31','Earnings impossible date'],['2026-11-12','Dividend payable'],
 ['20270109','Earnings January'],['2027-03-19','Earnings March boundary'],['20270320','Earnings outside extended window']
].map(([date,title])=>({date,title,detail:'Fixture'}));
const bars=[
 {time:now-180000,close:12.5,ohl:[10,19.25,7.75]},
 {time:now-120000,close:999,ohl:null},
 {time:now-60000,close:8.5,ohl:[13,21,3]}
];
const denied='No Wall Street Horizon subscription for this contract.';
const report={generated:new Date().toISOString(),clock:new Date(now).toISOString(),source:'Loopback-only IBKR-shaped fixtures and production browser assets',cases:[],files:{}};
const output=process.argv[2];
const delay=ms=>new Promise(resolve=>setTimeout(resolve,ms));
async function until(probe,reason,ms=10000){
 const start=Date.now();let last;
 do{try{last=await probe();if(last)return last}catch(e){last=e.message}await delay(35)}while(Date.now()-start<ms);
 throw Error('Timed out waiting for '+reason+' ('+JSON.stringify(last)+')');
}
const requests=[],pending=new Map(),hold=new Set(),denials=new Set();
function payload(url){
 const q=url.searchParams,symbol=q.get('symbol'),id=Number(q.get('id'));
 switch(url.pathname){
  case '/api/instrument':return info(symbol);
  case '/api/book':return listed(symbol,q.get('expiry'));
  case '/api/search':{const qSymbol=q.get('q').toUpperCase();
   return symbols.filter(s=>s.startsWith(qSymbol)).map(s=>({...info(s),key:s,label:s+' Fixture',derivatives:['OPT']}))}
  case '/api/events':return id===underlying('BBB')?{status:'unavailable',rows:[],message:denied}:
   {status:'ok',rows:events,message:'Fixture event calendar'};
  case '/api/bars':
   if(Math.floor(id/1000)===index('BBB'))return [{time:now-60000,close:61.25,ohl:[57,67,54]}];
   return q.get('window')==='1D'?[{time:now-50000,close:17,ohl:[9,23,4]}]:bars;
  case '/api/history':return {points:[[now,7]],coverage:[1]};
  case '/api/library':return [];
 }
 throw Error('Unexpected API route '+url.pathname);
}
let midpoint={at:now-5000,mid:10,feed:'Live'};
const types={'.js':'text/javascript','.html':'text/html','.css':'text/css','.woff2':'font/woff2'};
const server=createServer(async(req,res)=>{
 try{
  const url=new URL(req.url,'http://localhost');
  if(!url.pathname.startsWith('/api/')){
   const file=resolve(web,'.'+(url.pathname==='/'?'/index.html':url.pathname));
   if(!file.startsWith(web+sep)){res.writeHead(404).end();return}
   const data=await readFile(file);res.writeHead(200,{'Content-Type':types[extname(file)]||'application/octet-stream','Cache-Control':'no-store'}).end(data);return;
  }
  const key=url.pathname+url.search;requests.push(key);
  if(denials.has(key)){res.writeHead(403,{'Content-Type':'application/json'}).end(JSON.stringify({error:'Historical data subscription unavailable.'}));return}
  let reply;
  if(url.pathname==='/api/quotes'){
   let body='';for await(const part of req)body+=part;
   const {ids}=JSON.parse(body),quotes={};
   for(const id of ids){
    const isSpot=id%1000===0,mid=isSpot?100:midpoint.mid;
    quotes[id]={conId:id,mid,bid:mid-.1,ask:mid+.1,delta:.5,gamma:.02,theta:-.15,vega:.1,iv:.2,
     feed:isSpot?'Live':midpoint.feed,at:isSpot?now:midpoint.at,close:isSpot?99:10,modelUnderlying:100};
   }
   reply={quotes,lines:ids.length,time:now};
  }else reply=payload(url);
  const send=()=>res.writeHead(200,{'Content-Type':'application/json','Cache-Control':'no-store'}).end(JSON.stringify(reply));
  if(hold.has(key)){pending.set(key,send)}else send();
 }catch(error){res.writeHead(404).end(error.message)}
});
const release=key=>{hold.delete(key);pending.get(key)?.();pending.delete(key)};
const profile=await mkdtemp(join(tmpdir(),'options-chart-fixtures-'));
const chrome=await browserExecutable();
let browser,session,counter=0,buffer='';
const calls=new Map(),browserErrors=[];
function rpc(method,params={},sessionId){
 const id=++counter;
 return new Promise((resolve,reject)=>{
  calls.set(id,[resolve,reject]);browser.stdio[3].write(JSON.stringify({id,method,params,sessionId})+'\0');
 });
}
async function evaluate(expression){
 const result=await rpc('Runtime.evaluate',{expression,awaitPromise:true,returnByValue:true},session);
 if(result.exceptionDetails)throw Error(result.exceptionDetails.exception?.description||result.exceptionDetails.text);
 return result.result.value;
}
const d=id=>'document.getElementById('+JSON.stringify(id)+')';
const click=selector=>evaluate('document.querySelector('+JSON.stringify(selector)+').click()');
const wait=(expression,reason)=>until(()=>evaluate(expression),reason||expression);
const headers=()=>evaluate('[...document.querySelectorAll("#heatTable thead tr:last-child th")].map(h=>({title:h.title,label:h.querySelector(".heat-event")?.getAttribute("aria-label")??"",badge:h.querySelector(".heat-event")?.textContent??""}))');
const draft='JSON.parse(localStorage.getItem("optionslab.draft.v1"))';
let base,revision=0;
async function openStrategy(symbol,legs,e=expiry){
 const name='Chart data fixture '+ ++revision,doc={schema:1,name,symbol,root:symbol,expiry:e,legs};
 const url=base+'/?case='+revision+'#strategy='+Buffer.from(JSON.stringify(doc)).toString('base64url');
 await rpc('Page.navigate',{url},session);
 await wait(draft+'.name==='+JSON.stringify(name)+' && !!document.querySelector(".marker")','new isolated strategy');
}
async function selectValue(id,value){
 await evaluate('(()=>{const el='+d(id)+';el.value='+JSON.stringify(value)+';el.dispatchEvent(new Event("change",{bubbles:true}))})()');
}
async function selectSymbol(symbol){
 await evaluate('(()=>{const e='+d('symbol')+';e.focus();e.value='+JSON.stringify(symbol)+';e.dispatchEvent(new Event("input",{bubbles:true}));'+d('symbolForm')+'.requestSubmit()})()');
 await wait(draft+'.symbol==='+JSON.stringify(symbol),'select '+symbol);
}
const calendarOn=()=>click('[data-view="table"]');
const hourLabel=()=>evaluate(d('histCanvas')+'.getAttribute("aria-label")');
const barNote=()=>evaluate(d('historyNote')+'.textContent');
async function candles(){
 await click('#topHistory');await selectValue('historyType','bars');
}
async function inspectCandle(fraction){
 await evaluate('(()=>{const c='+d('histCanvas')+',r=c.getBoundingClientRect();window.__candleText=[];c.dispatchEvent(new PointerEvent("pointermove",{bubbles:true,clientX:r.left+65+('+fraction+')*(r.width-82),clientY:r.top+r.height/2}))})()');
 return (await evaluate('window.__candleText')).find(text=>text.startsWith('O '));
}
function caseDone(name,details){report.cases.push({name,...details});console.log('PASS '+name)}
try{
 for(const file of ['app.js','risk.js','index.html'])report.files[file]=createHash('sha256').update(await readFile(join(web,file))).digest('hex');
 await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));base='http://127.0.0.1:'+server.address().port;
 browser=spawn(chrome,['--headless=new','--disable-sync','--disable-extensions','--disable-background-networking','--no-first-run',
  '--remote-debugging-pipe','--window-size=1200,900','--user-data-dir='+profile],{stdio:['ignore','ignore','ignore','pipe','pipe']});
 browser.on('error',e=>{for(const [,reject] of calls.values())reject(e)});
 browser.stdio[4].setEncoding('utf8');
 browser.stdio[4].on('data',chunk=>{buffer+=chunk;
  while(buffer.includes('\0')){
   const cut=buffer.indexOf('\0'),r=JSON.parse(buffer.slice(0,cut));buffer=buffer.slice(cut+1);
   if(calls.has(r.id)){const [ok,fail]=calls.get(r.id);calls.delete(r.id);if(r.error)fail(Error(r.error.message));else ok(r.result)}
   if(r.method==='Runtime.exceptionThrown')browserErrors.push(r.params.exceptionDetails.exception?.description||r.params.exceptionDetails.text);
  }
 });
 const {targetId}=await rpc('Target.createTarget',{url:'about:blank'});
 session=(await rpc('Target.attachToTarget',{targetId,flatten:true})).sessionId;
 await rpc('Page.enable',{},session);await rpc('Runtime.enable',{},session);
 await rpc('Page.addScriptToEvaluateOnNewDocument',{source:'Date.now=()=>'+now+';window.__candleText=[];const native=CanvasRenderingContext2D.prototype.fillText;CanvasRenderingContext2D.prototype.fillText=function(text,...a){if(this.canvas.id==="histCanvas")window.__candleText.push(text);return native.call(this,text,...a)};'},session);
 await openStrategy('AAA',[traded('AAA',expiry)]);await calendarOn();
 await wait(d('eventCoverage')+'.textContent.includes("Fixture event calendar")','earnings and dividends');
 const short=await headers(),badges=short.filter(h=>h.badge);
 assert.match(short[0].title,/Oct 31/);
 assert.match(short[0].label,/2026-10-31 · Earnings opening boundary/);
 assert.match(short[0].label,/2026-10-31 · Ex-dividend UTC crossing/);
 assert.equal(short[0].badge,'E/D');
 assert.match(short.at(-1).label,/2026-12-18 · Ex-dividend expiry boundary/);
 assert.doesNotMatch(JSON.stringify(short),/before window|extended window|outside extended|impossible date|Dividend payable/);
 const weekdays=short.map(h=>Date.parse(h.title.split(' ').slice(0,2).join(' ')+' 2026 12:00 GMT')),sunday=Date.parse('2026-11-15T12:00:00Z');
 const nearest=weekdays.reduce((n,v,i)=>Math.abs(v-sunday)<Math.abs(weekdays[n]-sunday)?i:n,0);
 assert.match(short[nearest].label,/Earnings weekend/);
 caseDone('Calendar maps Eastern boundaries and nearest sampled date',{columns:short.length,badges,nearestWeekendHeader:short[nearest].title});
 await click('#showEvents');assert.equal((await headers()).filter(h=>h.badge).length,0);
 await click('#showEvents');await wait('document.querySelector(".heat-event")');
 await click('#expiries [data-exp="'+farExpiry+'"]');
 await wait(draft+'.expiry==="'+farExpiry+'"');
 const extended=await headers();
 assert.match(JSON.stringify(extended),/2026-12-19 · Earnings extended window/);
 assert.match(JSON.stringify(extended),/2027-01-09 · Earnings January/);
 assert.match(extended.at(-1).label,/2027-03-19 · Earnings March boundary/);
 assert.doesNotMatch(JSON.stringify(extended),/outside extended|impossible date/);
 caseDone('Widening the expiration includes later reported dates',{lastHeader:extended.at(-1),calendarRequests:requests.filter(k=>k==='/api/events?id=1000').length});
 await openStrategy('CCC',[traded('CCC',expiry)]);
 const staleCalendar='/api/events?id='+underlying('CCC');hold.add(staleCalendar);await calendarOn();
 await until(()=>pending.has(staleCalendar),'delayed other ticker calendar');
 await selectSymbol('BBB');
 await wait(d('eventCoverage')+'.textContent.includes('+JSON.stringify(denied)+')','entitlement reason');
 release(staleCalendar);await delay(80);
 assert.ok((await evaluate(d('eventCoverage')+'.textContent')).includes(denied));assert.equal((await headers()).filter(h=>h.badge).length,0);
 await selectSymbol('IDX');
 assert.equal(await evaluate(d('calendarOptions')+'.hidden'),true);assert.ok(!requests.includes('/api/events?id='+underlying('IDX')));
 caseDone('Missing entitlement, late other-ticker calendar and index handling',{reason:denied,indexCalendarRequests:0});
 await openStrategy('AAA',[traded('AAA',expiry),traded('AAA',expiry)]);
 await candles();await wait(d('histCanvas')+'.getAttribute("aria-label")?.includes("2 observations")','broker OHLC');
 const candleLabel=await hourLabel(),firstText=await inspectCandle(0),lastText=await inspectCandle(1);
 assert.match(candleLabel,/latest \$8.5/);
 assert.equal(firstText,'O $10  H $19.25  L $7.75  C $12.5');
 assert.equal(lastText,'O $13  H $21  L $3  C $8.5');
 caseDone('Duplicate-option strategy displays broker premium OHLC and drops the incomplete bar',{candleLabel,firstText,lastText,input:bars});
 const contract=traded('AAA',expiry).conId,slow='/api/bars?id='+contract+'&window=3M';
 hold.add(slow);await selectValue('historyWindow','3M');await until(()=>pending.has(slow),'delayed broker candles');
 await selectValue('historyWindow','1D');await wait(d('histCanvas')+'.getAttribute("aria-label")?.includes("latest $17")');
 release(slow);await delay(80);assert.match(await hourLabel(),/1 observation, latest \$17/);
 caseDone('Late bars cannot overwrite newer window',{retained:await hourLabel()});
 await openStrategy('AAA',[traded('AAA',expiry),traded('AAA',expiry,105)]);
 const before=requests.filter(k=>k.startsWith('/api/bars?')).length;
 await candles();await wait(d('historyNote')+'.textContent.includes("single included option")');
 assert.equal(requests.filter(k=>k.startsWith('/api/bars?')).length,before);
 caseDone('Distinct open contracts are rejected before requesting premium history',{note:await barNote()});
 await openStrategy('AAA',[traded('AAA',expiry)]);await candles();await wait(d('histCanvas')+'.getAttribute("aria-label")?.includes("latest $8.5")');
 hold.add(slow);await selectValue('historyWindow','3M');await until(()=>pending.has(slow),'second delayed request');
 await selectValue('historyType','liveCandles');release(slow);
 await delay(80);assert.match(await barNote(),/Observed live bid\/ask midpoints/);
 midpoint={at:now-4200,mid:16,feed:'Live'};await wait(d('histCanvas')+'.getAttribute("aria-label")?.includes("latest $16")');
 midpoint={at:now-3500,mid:2,feed:'Delayed'};await delay(1000);
 midpoint={at:now-5200,mid:1,feed:'Live'};await delay(1000);
 midpoint={at:now-2500,mid:9,feed:'Live'};await wait(d('histCanvas')+'.getAttribute("aria-label")?.includes("latest $9")');
 const liveText=await inspectCandle(.5);assert.equal(liveText,'O $10  H $16  L $9  C $9');
 caseDone('Type changes discard stale history and live candles accept ordered live midpoints',{liveText});
 const deniedWindow='/api/bars?id='+contract+'&window=1M';denials.add(deniedWindow);denials.add('/api/history');
 await selectValue('historyWindow','1M');await selectValue('historyType','bars');
 await wait(d('historyNote')+'.textContent.includes("Showing this tab")','local candle fallback');
 const candleFallback=await barNote();assert.match(candleFallback,/Historical data subscription unavailable/);
 assert.match(candleFallback,/Observed live bid\/ask midpoints/);assert.equal(await inspectCandle(.5),liveText);
 await selectValue('historyType','market');await wait(d('historyNote')+'.textContent.includes("Showing this tab")','local P&L fallback');
 const pnlFallback=await barNote();assert.match(pnlFallback,/live midpoint marks observed/);
 assert.match(await hourLabel(),/Historical P&L/);
 caseDone('Historical entitlement failure identifies local candle and strategy P&L observations',{candleFallback,pnlFallback});
 hold.add(slow);await selectValue('historyWindow','3M');await selectValue('historyType','bars');
 await until(()=>pending.has(slow),'old ticker history request');
 await selectSymbol('BBB');
 const replacement='/api/bars?id='+traded('BBB',expiry).conId+'&window=3M';
 await until(()=>requests.includes(replacement),'selected ticker history request');
 await wait(d('histCanvas')+'.getAttribute("aria-label")?.includes("latest $61.25")','new ticker OHLC');
 release(slow);await delay(100);
 assert.match(await hourLabel(),/latest \$61.25/);assert.match(await barNote(),/BBB/);
 caseDone('Changing ticker refreshes the contract and rejects its predecessor’s late history',{retained:await hourLabel(),currentContract:await barNote()});
 assert.deepEqual(browserErrors,[]);report.passed=true;
}catch(error){
 report.passed=false;report.failure=error.stack;report.browserErrors=browserErrors;
 report.requests=[...new Set(requests)];
 if(session)report.visibleStatus=await evaluate('[...document.querySelectorAll("#eventCoverage,#historyNote,#message,#chartTitle,#connection")].map(e=>[e.id,e.textContent])').catch(()=>null);
 console.error(error.stack);process.exitCode=1;
}
finally{
 for(const key of pending.keys())release(key);
 if(browser&&browser.exitCode===null&&browser.signalCode===null){const exited=new Promise(resolve=>browser.once('exit',resolve));browser.kill();await exited}
 server.closeAllConnections();await new Promise(resolve=>server.close(resolve));
 await rm(profile,{recursive:true,force:true,maxRetries:8,retryDelay:100});
 if(output)await writeFile(output,JSON.stringify(report,null,2)+'\n');else console.log(JSON.stringify(report,null,2));
}

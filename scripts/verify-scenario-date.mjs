// Real browser regression for source-priced option IV and the date slider.
// Usage: node scripts/verify-scenario-date.mjs evidence.json [--baseline old-web-directory]
// The old-assets mode verifies the originally reported symptom on an isolated profile.
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {mkdtemp,readFile,rm,writeFile,mkdir} from 'node:fs/promises';
import {createServer} from 'node:http';
import {tmpdir} from 'node:os';
import {dirname,extname,join,resolve,sep} from 'node:path';
import {fileURLToPath} from 'node:url';
import {testBrowser} from './browser-fixture.mjs';

const [destination,flag,oldDir]=process.argv.slice(2);
assert(destination,'Supply an evidence JSON path.');const baseline=flag==='--baseline';
const repo=resolve(dirname(fileURLToPath(import.meta.url)),'..'),web=baseline?resolve(oldDir):join(repo,'web');
const now=Date.parse('2028-03-13T01:00:00Z'),end=Date.parse('2030-04-19T20:00:00Z'),year=365*86400000;
const expiry='20300419',root='QAX',spot=88.5,prior=84.25;
const legs=[{strike:75,qty:2,entry:13.20,close:19.45,conId:7101},{strike:92,qty:4,entry:7.25,close:10.30,conId:7102},{strike:110,qty:-3,entry:3.55,close:6.15,conId:7103}];
const spotId=7100;
const report={source:'Production browser assets, isolated Chrome and loopback-only IBKR-shaped HTTP responses',baseline,fixture:{symbol:root,expiry,spot,priorClose:prior,optionCloses:legs.map(l=>l.close),entries:legs.map(l=>l.entry),qty:legs.map(l=>l.qty),clock:new Date(now).toISOString()},checks:[],files:{}};
const delay=n=>new Promise(resolve=>setTimeout(resolve,n));
async function until(check,label,ms=10000){
 const limit=Date.now()+ms;let value,err;
 do{try{value=await check();if(value)return value}catch(e){err=e.message}await delay(45)}while(Date.now()<limit);
 throw Error('Timed out on '+label+': '+(err??JSON.stringify(value)));
}
// Independent numerical oracle: integrate the Gaussian density using Simpson's
// rule, then invert the European call formula. With no dividends or interest,
// an American call has the same value, including on this dated equity fixture.
function cdf(z){
 const a=Math.min(Math.abs(z),10),n=384,step=a/n,pdf=x=>Math.exp(-0.5*x*x)/Math.sqrt(2*Math.PI);
 let sum=pdf(0)+pdf(a);
 for(let i=1;i<n;i++)sum+=(i%2?4:2)*pdf(step*i);
 return .5+Math.sign(z)*sum*step/3;
}
function call(s,k,sigma,t){
 if(t<=0||sigma===0)return Math.max(0,s-k);
 const dev=sigma*Math.sqrt(t),d1=Math.log(s/k)/dev+dev/2;
 return s*cdf(d1)-k*cdf(d1-dev);
}
function implied(s,k,premium,at){
 let low=0,high=8;const t=(end-at)/year;assert(call(s,k,0,t)<=premium&&premium<call(s,k,high,t));
 for(let i=0;i<67;i++){const mid=(high+low)/2;if(call(s,k,mid,t)<premium)low=mid;else high=mid}
 return (low+high)/2;
}
const referenceAsOf=Date.parse('2028-03-10T21:00:00Z');
const derived=legs.map(l=>implied(prior,l.strike,l.close,referenceAsOf));
function expected(vols,selections,ivFactor=1,s=spot){
 const t=(end-(now+(end-now)*selections/100))/year;
 return legs.reduce((sum,l,i)=>sum+l.qty*100*(call(s,l.strike,vols[i]*ivFactor,t)-l.entry),0);
}
const explicit=[.32,.44,.51],mixed=[.32,.44,derived[2]],tradeSpot=86.75,tradeAt=now-86000;
let mode='closes',activeLines=20,saved=null;
function quote(id){
 const lastMode=['trades','mismatchedLast','staleLast'].includes(mode);
 const midpointMode=['staleMid','frozenMid','impossiblePremium'].includes(mode);
 const underlyingTradeAt=mode==='staleLast'?tradeAt-8*86400000:tradeAt;
 const live={at:now,conId:id,feed:'Live',lastTradeTime:null,closeSessionDate:'2028-03-10',closeSessionEnd:referenceAsOf,delta:null,gamma:null,theta:null,vega:null,iv:null,modelUnderlying:null};
 if(id===spotId)return {...live,bid:spot-.01,ask:spot+.01,mid:spot,last:lastMode?tradeSpot:null,lastTradeTime:lastMode?underlyingTradeAt:null,close:mode==='missingPair'?null:prior};
 const i=legs.findIndex(l=>l.conId===id),l=legs[i];
 if(!l)return {...live,mid:null,bid:null,ask:null,last:null,close:null};
 const hasMid=midpointMode||mode==='mixed'&&i===1;
 const mid=hasMid?(mode==='impossiblePremium'&&i===2?spot+4:call(spot,l.strike,explicit[i],(end-now)/year)):null;
 const lastTradeTime=lastMode?underlyingTradeAt-(mode==='mismatchedLast'?66000:3000):null;
 const last=lastMode?call(tradeSpot,l.strike,explicit[i],(end-lastTradeTime)/year):null;
 return {...live,at:mode==='staleMid'?now-20*60000:now,feed:mode==='frozenMid'?'Frozen':'Live',
  mid,bid:mid!=null?mid-.01:null,ask:mid!=null?mid+.01:null,last,lastTradeTime,
  closeSessionDate:mode==='mismatchedClose'&&i===2?'2028-03-09':live.closeSessionDate,
  closeSessionEnd:mode==='mismatchedClose'&&i===2?referenceAsOf-86400000:referenceAsOf,
  close:lastMode||midpointMode||mode==='blank'||mode==='mixedMissing'&&i===2?null:l.close,
  iv:mode==='reported'||mode==='mixed'&&i===0||mode==='mixedMissing'&&i!==2?explicit[i]:null};
}
const instrument={symbol:root,ticker:root,secType:'STK',conId:spotId,currency:'USD',exchange:'SMART',primaryExchange:'ARCA',style:'US',defaultRoot:root,roots:{[root]:{multiplier:100,expiries:[expiry]}}};
const book={symbol:root,root,expiry,settlement:'PM',expiresAt:end,currency:'USD',strikes:legs.map((l,i)=>({strike:l.strike,C:l.conId,P:7201+i}))};
const doc={schema:1,name:'Synthetic multi-leg date regression',symbol:root,root,expiry,legs:legs.map(({strike,qty,entry,conId})=>({kind:'option',symbol:root,root,right:'C',strike,expiry,qty,entry,entryFeed:'Manual',multiplier:100,conId}))};
const types={'.js':'text/javascript','.html':'text/html','.css':'text/css','.woff2':'font/woff2'};
const server=createServer(async(req,res)=>{
 try{
  const url=new URL(req.url,'http://127.0.0.1'),api=url.pathname.startsWith('/api/');
  if(!api){const path=resolve(web,'.'+(url.pathname==='/'?'/index.html':url.pathname));assert(path.startsWith(web+sep));const asset=await readFile(path);res.writeHead(200,{'Content-Type':types[extname(path)]??'application/octet-stream','Cache-Control':'no-store'}).end(asset);return}
  let body='';for await(const part of req)body+=part;
  const data=body?JSON.parse(body):null;let out;
  switch(url.pathname){
   case '/api/instrument':out=instrument;break;
   case '/api/book':out=book;break;
   case '/api/quotes':{out={quotes:Object.fromEntries(data.ids.map(i=>[i,quote(i)])),time:now,lines:activeLines};break}
   case '/api/save':saved=data.document;out={id:'date-fixture',version:1,document:saved};break;
   case '/api/library':out=[];break;
   case '/api/events':out={status:'ok',rows:[]};break;
   case '/api/status':out={connected:true};break;
   case '/api/saved-snapshots':out={rows:{}};break;
   default:throw Error('Unexpected fixture request: '+url.pathname);
  }
  res.writeHead(200,{'Content-Type':'application/json','Cache-Control':'no-store'}).end(JSON.stringify(out));
 }catch(e){res.writeHead(400).end(JSON.stringify({error:e.message}))}
});
await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
const profile=await mkdtemp(join(tmpdir(),'scenario-date-e2e-'));let browser;
const output=resolve(destination);
try{
 browser=await testBrowser(profile,until);const ev=expression=>browser.evalPage(expression);
 await browser.call('Page.enable');await browser.call('Runtime.enable');
 await browser.call('Page.addScriptToEvaluateOnNewDocument',{source:'Date.now=()=>'+now+';'});
 const url='http://127.0.0.1:'+server.address().port+'/#strategy='+Buffer.from(JSON.stringify(doc)).toString('base64url');
 await browser.call('Page.navigate',{url});
 const snap=()=>ev('(()=>({label:document.getElementById("riskCanvas").getAttribute("aria-label"),note:document.getElementById("scenarioNote").innerText,date:document.getElementById("dateLabel").innerText,value:+document.getElementById("horizon").value,ivValue:+document.getElementById("iv").value,ivLabel:document.getElementById("ivLabel").innerText,legend:document.getElementById("plotLegend").innerText,spot:document.getElementById("spot").innerText}))()');
 await until(async()=>{const s=await snap();return Number(s.spot.replace(/[^\d.-]/g,''))===spot&&s.label.includes('at reference')},'qualified synthetic expiration graph');
 assert.equal(await ev('Date.now()'),now,'The scenario clock must be fixed in the navigated builder tab.');
 const money=s=>{const m=s.label.match(/at reference\s+([^;]+)/i);return m?Number(m[1].replace(/[^0-9.-]/g,'')):null;};
 async function verifyPnl(vols,factor,label){
  return until(async()=>{const s=await snap(),value=money(s),wanted=expected(vols,s.value,factor);
   if(value===null||!Number.isFinite(value)||Math.abs(value-wanted)>.3||/Expiration only/i.test(s.label))return false;
   return {...s,atReference:value,independentReference:Math.round(wanted*100)/100};},label);
 }
 async function key(key,code=key){
  await browser.call('Input.dispatchKeyEvent',{type:'keyDown',key,code,windowsVirtualKeyCode:key==='Home'?36:key==='End'?35:39});
  await browser.call('Input.dispatchKeyEvent',{type:'keyUp',key,code,windowsVirtualKeyCode:key==='Home'?36:key==='End'?35:39});
 }
 async function move(slider,pct){
  const pos=await ev('(()=>{const e=document.getElementById('+JSON.stringify(slider)+');e.scrollIntoView({block:"center",behavior:"instant"});e.focus();const r=e.getBoundingClientRect();return{x:r.x+5.5+(r.width-11)*'+pct+'/100,y:r.y+r.height/2}})()');
  await browser.call('Input.dispatchMouseEvent',{type:'mouseMoved',...pos});
  await browser.call('Input.dispatchMouseEvent',{type:'mousePressed',...pos,button:'left',clickCount:1});
  await browser.call('Input.dispatchMouseEvent',{type:'mouseReleased',...pos,button:'left',clickCount:1});
 }
 async function date(pct){
  await ev('document.getElementById("horizon").focus()');
  if(pct===0||pct===100)await key(pct===0?'Home':'End');else await move('horizon',pct);
  return until(async()=>{const s=await snap();return Math.abs(s.value-pct)<1.3&&s;},'slider '+pct);
 }
 async function stream(next){
  mode=next;const stamp=++activeLines+' quote lines';
  await until(()=>ev('document.getElementById("footStatus").textContent.includes('+JSON.stringify(stamp)+')'),'rendered broker quote refresh '+next);
 }
 await date(100);const terminal=await verifyPnl(derived,1,'expiration intrinsic P&L');
 await date(50);
 if(baseline){
  const failed=await until(async()=>{const s=await snap();return /Scenario unavailable for these inputs/.test(s.label)&&s;},'original unavailable graph');
  report.checks.push({case:'Original missing-IV failure reproduced at intermediate date',terminal,failed});
 }else{
  const intermediate=await verifyPnl(derived,1,'paired prior-close values at intermediate date');
  await date(0);const current=await verifyPnl(derived,1,'paired prior-close values at Now');
  assert.match(current.note+' '+current.ivLabel,/prior close/i);
  await date(75);const later=await verifyPnl(derived,1,'prior-close estimates at later date');
  await date(100);const unchangedExpiry=await verifyPnl(derived,1,'expiration after changing date');
  assert.equal(money(unchangedExpiry),money(terminal));
  report.checks.push({case:'Three synthetic prior closes calibrated independently to the underlying prior close',estimatedVols:derived,now:current,intermediate,later,expiration:terminal});
  await date(50);
  await ev('(()=>{const e=document.getElementById("iv");e.value=1.25;e.dispatchEvent(new Event("input",{bubbles:true}));})()');
  const scaled=await verifyPnl(derived,1.25,'IV x 1.25 applied once');
  await stream('closes');const again=await verifyPnl(derived,1.25,'unchanged factor after refreshing quotes');
  assert.equal(money(scaled),money(again));
  const pinned=scaled.date;
  await ev('document.getElementById("save").click()');await until(()=>ev('document.getElementById("dialog").open'),'save dialog');
  await ev('document.getElementById("dialogOk").click()');await until(()=>saved,'captured isolated save');
  const draft=await ev('JSON.parse(localStorage.getItem("optionslab.draft.v1"))');
  for(const stored of [saved,draft]){
   assert.deepEqual(stored.legs.map(l=>l.entry),legs.map(l=>l.entry));
   for(const leg of stored.legs)assert.equal(Object.keys(leg).some(k=>/^(iv|ivEstimate|quotedIv|impliedVolatility|estimatedIv|scenarioBaseIv|scenarioIv|ivSource)$/i.test(k)),false);
  }
  report.checks.push({case:'IV stress multiplier applied once across broker refresh, estimated IV and arbitrary premiums kept out of saved inputs',scaled,pinned,storedEntries:saved.legs.map(l=>l.entry)});
  await ev('(()=>{const e=document.getElementById("iv");e.value=1;e.dispatchEvent(new Event("input",{bubbles:true}));})()');
  await stream('mixed');const blended=await verifyPnl(mixed,1,'direct broker IV wins over divergent prior marks; midpoint pairs calibrate at the current spot');
  assert.equal(blended.date,pinned);
  report.checks.push({case:'Per-leg reported IV, matched live midpoint and prior-close calibration coexist',blended,vols:mixed});
  await stream('trades');const lastTrades=await verifyPnl(explicit,1,'time-aligned option and underlying last trades');
  assert.match(lastTrades.note,/last trades/i);
  report.checks.push({case:'Matched last trade prices use their own underlying price and observation time',lastTrades});
  for(const unresolved of ['mixedMissing','missingPair','mismatchedClose','mismatchedLast','staleLast','staleMid','frozenMid','impossiblePremium','blank']){
   await stream(unresolved);
   const fallback=await until(async()=>{const s=await snap();return /Expiration only/i.test(s.label)&&s;},'labelled expiry fallback '+unresolved);
   assert.equal(fallback.date,pinned);
   assert.ok(Math.abs(money(fallback)-expected(derived,100,1))<.02,'fallback graph must price intrinsic at expiration');
   assert.match(fallback.note,/missing IV|implied volatil|option IV|volatility|premium/i);
   if(['mixedMissing','mismatchedClose','impossiblePremium'].includes(unresolved))assert.match(fallback.note,new RegExp(legs[2].strike+'C'));
   assert(!/Scenario unavailable for these inputs/.test(fallback.label));
   const hoverPoint=await ev('(()=>{const e=document.getElementById("riskCanvas");e.scrollIntoView({block:"center",behavior:"instant"});const r=e.getBoundingClientRect();return {x:r.left+r.width*.55,y:r.top+r.height*.55}})()');
   await browser.call('Input.dispatchMouseEvent',{type:'mouseMoved',...hoverPoint});
   await until(()=>ev('/expiration/i.test(document.getElementById("hover").innerText)'),'expiry-only hover');
   report.checks.push({case:'Unpriceable inputs show only expiration intrinsic P&L with an explicit source diagnosis: '+unresolved,fallback});
  }
  await stream('reported');const restored=await verifyPnl(explicit,1,'automatic date scenario recovery from reported broker IV');
  assert.equal(restored.date,pinned);
  report.checks.push({case:'Streaming broker IV restores the pinned selected date without pressing Return',restored});
  await stream('closes');await verifyPnl(derived,1,'final graph redraw');
  const clip=await ev('(()=>{const e=document.querySelector(".chart-card");e.scrollIntoView({block:"center",behavior:"instant"});const r=e.getBoundingClientRect();return {x:scrollX+r.x,y:scrollY+r.y,width:r.width,height:Math.min(r.height,950),scale:1}})()');
  const screen=await browser.call('Page.captureScreenshot',{format:'png',clip}),shot=output.replace(/\.json$/,'')+'-graph.png';
  await mkdir(dirname(output),{recursive:true});await writeFile(shot,Buffer.from(screen.data,'base64'));report.screenshot={name:shot.split('/').at(-1),sha256:createHash('sha256').update(Buffer.from(screen.data,'base64')).digest('hex')};
 }
 report.fixture.priorCloseSessionEnd=new Date(referenceAsOf).toISOString();
 report.reproduce='node scripts/verify-scenario-date.mjs <absolute-report-path>.json'+(baseline?' --baseline <original-web-asset-directory>':'');
 for(const path of ['app.js','risk.js','index.html'])report.files[path]=createHash('sha256').update(await readFile(join(web,path))).digest('hex');
 report.files['runner']=createHash('sha256').update(await readFile(fileURLToPath(import.meta.url))).digest('hex');
 await mkdir(dirname(output),{recursive:true});await writeFile(output,JSON.stringify(report,null,2)+'\n');
 console.log(report.checks.length+' scenario-date browser checks passed. '+output);
}catch(e){
 if(browser)console.error('Last visible graph:',await browser.evalPage('({canvas:document.getElementById("riskCanvas")?.getAttribute("aria-label"),date:document.getElementById("dateLabel")?.innerText,note:document.getElementById("scenarioNote")?.innerText,iv:document.getElementById("ivLabel")?.innerText,msg:document.getElementById("message")?.innerText})').catch(()=>null));
 throw e;
}finally{
 if(browser)await browser.close();
 await new Promise(resolve=>server.close(resolve));
 // Chrome helper processes can finish writing the temporary profile after the browser exits.
 await rm(profile,{recursive:true,force:true,maxRetries:5,retryDelay:150});
}

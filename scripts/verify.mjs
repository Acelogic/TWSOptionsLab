// Run against real TWS with an isolated local library. Usage: node scripts/verify.mjs [evidence.json]
// Set TWS_PORT to select a nonstandard workstation or a local protocol replay.
import {spawn,execFileSync} from 'node:child_process';
import {mkdtemp,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,dirname,resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import net from 'node:net';
import assert from 'node:assert/strict';
const root=resolve(dirname(fileURLToPath(import.meta.url)),'..');
const selectedCase=process.argv[3]==='--case'?process.argv[4]:null;
const target=process.argv[2],out={time:new Date().toISOString(),cases:[]},tmp=await mkdtemp(join(tmpdir(),'tws-options-e2e-'));
const reserve=net.createServer();await new Promise(r=>reserve.listen(0,'127.0.0.1',r));const port=reserve.address().port;await new Promise(r=>reserve.close(r));
const base='http://127.0.0.1:'+port;
const delay=n=>new Promise(r=>setTimeout(r,n));
execFileSync('cargo',['build','--locked','--quiet'],{cwd:root,stdio:'inherit'});
const brokerPort=process.env.TWS_PORT?['--tws-port',process.env.TWS_PORT]:[];
const server=spawn(join(root,'target/debug/tws-options-lab'),['--no-open','--port',String(port),'--data-dir',tmp,...brokerPort],{cwd:root,stdio:'ignore'});
const get=async(path,data)=>{
 const res=await fetch(base+'/api/'+path,data?{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(data),signal:AbortSignal.timeout(55000)}:{signal:AbortSignal.timeout(55000)});
 const v=await res.json();if(!res.ok)throw Error(v.error||res.status);return v;
};
const query=(key,params)=>key+'?'+new URLSearchParams(params);
async function equity(symbol){
 const hits=await get(query('search',{q:symbol}));
 const us=hits.filter(row=>row.symbol===symbol&&row.currency==='USD'&&row.secType==='STK');
 assert.ok(us.length,'US equity listing unavailable for '+symbol);
 return get(query('instrument',{symbol:us[0].key}));
}
const caseRun=async(name,fn)=>{if(selectedCase&&name!==selectedCase)return;try{const details=await fn();out.cases.push({name,passed:true,details});console.log('PASS '+name)}catch(e){out.cases.push({name,passed:false,error:e.message});console.error('FAIL '+name+' · '+e.message)}};
try{
 for(let i=0;i<50;i++){try{await get('status');break}catch{await delay(150)}}
 await caseRun('Native server',async()=>{const s=await get('status');assert.equal(s.backend,'Rust');return {backend:s.backend}});
 const info=await get('instrument?symbol=SPX'),rootId=info.defaultRoot,expiry=info.roots[rootId].expiries[0];
 const book=await get(query('book',{symbol:'SPX',root:rootId,expiry}));
 await caseRun('Qualified SPX series',async()=>{assert.ok(book.strikes.length>25);return {root:rootId,expiry,strikes:book.strikes.length,currency:info.currency}});
 const underlying=(await get('quotes',{mode:1,ids:[info.conId]})).quotes[info.conId];
 await delay(1200);
 const ref=(await get('quotes',{mode:1,ids:[info.conId]})).quotes[info.conId];
 const spot=ref.mid??ref.last??ref.close??underlying.mid??underlying.last??underlying.close;
 assert.ok(spot>0,'TWS needs an underlying reference to select the test contract');
 const byStrike=book.strikes.filter(r=>r.C&&r.P).sort((a,b)=>Math.abs(a.strike-spot)-Math.abs(b.strike-spot));
 const sample=byStrike[0],ids=[sample.C,sample.P,byStrike[1].C,byStrike[1].P];let live;
 await caseRun('Broker-confirmed live option quote and Greeks',async()=>{
  for(let i=0;i<18;i++){live=(await get('quotes',{mode:1,ids})).quotes[sample.C];if(live.feed==='Live'&&live.mid>0&&live.delta!=null)break;await delay(800)}
  assert.equal(live.feed,'Live');assert.ok(live.bid>0&&live.ask>=live.bid&&live.delta>0);
  return {conId:sample.C,strike:sample.strike,received:live.at,bid:live.bid,ask:live.ask,delta:live.delta,iv:live.iv};
 });
 const legs=[{kind:'option',symbol:'SPX',root:rootId,right:'C',strike:sample.strike,expiry,qty:1,entry:live?.mid??1,multiplier:100,conId:sample.C,style:'EU'}];
 await caseRun('Intraday optimizer through the SPX UI',async()=>{
  const {verifyOptimizer}=await import('./optimizer-ui.mjs');
  return verifyOptimizer({base,tmp,book,info,sample});
 });
 await caseRun('SPX scenario Greeks from TWS implied volatility',async()=>{
  let quote=live;
  for(let i=0;i<18&&!(quote?.iv>0);i++){
   quote=(await get('quotes',{mode:1,ids:[sample.C]})).quotes[sample.C];
   if(!(quote.iv>0))await delay(800);
  }
  assert.ok(quote?.iv>0,'TWS did not supply an option implied volatility.');
  const source=await (await fetch(base+'/risk.js')).text();
  const {scenarioGreekEvaluator,payoff}=await import('data:text/javascript;base64,'+Buffer.from(source).toString('base64'));
  const option={...legs[0],expiresAt:book.expiresAt,iv:quote.iv,secType:'OPT',settlement:book.settlement,qty:-2};
  const position=[option,{kind:'stock',qty:25,entry:sample.strike},{kind:'realized',qty:-1,multiplier:1,entry:200}];
  const now=Date.now(),at=sample.strike,annualRate=0.0325,ds=at*.0001,dv=.0001,dr=.0001;
  const dt=Math.min(60000,(option.expiresAt-now)/100);
  assert.ok(dt>0,'Selected listed contract has already expired.');
  const pnl=(s=at,t=now,vol=0,r=annualRate)=>payoff(position,s,t,vol,r);
  const moves={
   delta:(pnl(at+ds)-pnl(at-ds))/(2*ds),
   gamma:(pnl(at+ds)-2*pnl()+pnl(at-ds))/(ds*ds),
   theta:(pnl(at,now+dt)-pnl(at,now-dt))*86400000/(2*dt),
   vega:(pnl(at,now,dv)-pnl(at,now,-dv))*.01/(2*dv),
   rho:(pnl(at,now,0,annualRate+dr)-pnl(at,now,0,annualRate-dr))*.01/(2*dr)
  };
  const metrics={};
  for(const [metric,repriced] of Object.entries(moves)){
   const model=scenarioGreekEvaluator(position,now,0,annualRate,metric);
   const value=model(at);
   assert.ok(Math.abs(value-repriced)<0.02+Math.abs(repriced)*.015,metric+' disagrees with independently repriced scenario P&L');
   assert.equal(scenarioGreekEvaluator(position,option.expiresAt,0,annualRate,metric),null);
   assert.equal(scenarioGreekEvaluator([{...option,iv:null}],now,0,annualRate,metric),null);
   const withoutEntries=position.map(l=>({...l,entry:null}));
   assert.equal(scenarioGreekEvaluator(withoutEntries,now,0,annualRate,metric)(at),value);
   metrics[metric]={modeled:value,fromRepricing:repriced};
  }
  return {contract:sample.C,feed:quote.feed,iv:quote.iv,scenarioPrice:at,expiryMs:option.expiresAt,scenarioMs:now,optionQuantity:-2,shares:25,annualRate,metrics};
 });
 await caseRun('Local library round trip and transactional import',async()=>{
  const item={name:'E2E isolated strategy',document:{schema:1,symbol:'SPX',root:rootId,expiry,legs}};
  const saved=await get('save',item);assert.ok(saved.id);assert.equal((await get('library')).length,1);
  await assert.rejects(get('import',{strategies:[{...item,name:'Would roll back'},{...item,document:{...item.document,legs:[]}}]}));assert.equal((await get('library')).length,1);
  assert.equal((await get('import',{strategies:[item]})).count,1);assert.equal((await get('import',{strategies:[item]})).count,0);
  await get('delete',{id:saved.id,version:saved.version});assert.equal((await get('library')).length,1);
  return {saved:true,invalidBatchRolledBack:true,idempotentImport:true};
 });
 await caseRun('Option commissions across partial closes and saved marks',async()=>{
  const fee=1.25,entry=100,at=Date.now();
  const open={...legs[0],qty:3,entry,iv:.3,expiresAt:book.expiresAt};
  const ignored={...open,qty:-4,excluded:true};
  const plain={name:'Commission workflow',document:{symbol:'SPX',root:rootId,expiry,legs:[open,ignored]}};
  const legacy=await get('save',plain);
  const withFee=structuredClone(plain);withFee.document.commissionPerContract=fee;
  const charged=await get('save',{...withFee,...legacy});
  assert.notEqual(charged.id,legacy.id,'Changing a commission must preserve the earlier mark history');
  const invalid=structuredClone(withFee);invalid.document.commissionPerContract=-1;
  await assert.rejects(get('save',invalid));
  const data=await get('library');
  assert.equal(data.find(s=>s.id===charged.id).document.commissionPerContract,fee);
  const imported={name:'Commission import',document:{...withFee.document,commissionPerContract:.75}};
  assert.equal((await get('import',{strategies:[imported]})).count,1);
  assert.ok((await get('library')).some(s=>s.name===imported.name&&s.document.commissionPerContract===.75));
  const partial=structuredClone(withFee);partial.document.legs[0].closes=[{qty:1,price:115,at}];
  const partialSaved=await get('save',{...partial,...charged});assert.equal(partialSaved.id,charged.id);
  const code=await (await fetch(base+'/risk.js')).text();
  const {projectPositions,analyze,payoff,realizedPnl,scenarioGreekEvaluator}=await import('data:text/javascript;base64,'+Buffer.from(code).toString('base64'));
  const s=sample.strike+105,q={[sample.C]:{mid:105}};
  const priced=rate=>projectPositions(partial.document.legs,q,rate);
  const a=analyze(priced(fee),s,book.expiresAt,0,.03),gross=analyze(priced(0),s,book.expiresAt,0,.03);
  assert.equal(a.markPnl,gross.markPnl-5);assert.equal(a.marketValue,gross.marketValue);
  assert.equal(a.percentBasis,30003.75);assert.equal(a.maxLoss,gross.maxLoss+5);
  assert.ok(Math.abs(a.breakEvens[0]-gross.breakEvens[0]-.025)<1e-8);
  assert.equal(realizedPnl(partial.document.legs[0],fee),1497.5);
  assert.equal(payoff(priced(fee),s,book.expiresAt)+a.entryDebit,payoff(priced(0),s,book.expiresAt)+gross.entryDebit);
  for(const metric of ['delta','gamma','theta','vega','rho'])
   assert.equal(scenarioGreekEvaluator(priced(fee),at,0,.03,metric)(s),scenarioGreekEvaluator(priced(0),at,0,.03,metric)(s));
  const shares={kind:'stock',qty:20,entry:95,multiplier:1,conId:9,closes:[{qty:2,price:110,at}]};
  assert.deepEqual(projectPositions([shares],{},fee),projectPositions([shares],{},0));
  async function waitMark(id,check){
   for(let i=0;i<55;i++){const m=(await get('marks?id='+id)).at(-1);if(m&&check(m))return m;await delay(1000)}
   throw Error('Timed out waiting for commission-adjusted saved marks');
  }
  const partialMark=await waitMark(charged.id,m=>m[2]>0&&Math.abs(m[1]-(m[2]-20000+1495))<1e-7);
  const closed=structuredClone(partial);closed.document.legs[0].closes.push({qty:2,price:95,at:Date.now()});
  const done=await get('save',{...closed,...partialSaved});assert.equal(done.id,charged.id);
  const short=structuredClone(withFee);short.document.legs=[{...open,qty:-2,closes:[{qty:2,price:95,at}]}];
  const shortSaved=await get('save',short);
  const [longMark,shortMark]=await Promise.all([waitMark(charged.id,m=>m[1]===492.5&&m[2]===0),waitMark(shortSaved.id,m=>m[1]===995&&m[2]===0)]);
  return {sourceContract:sample.C,currency:info.currency,commissionPerSide:fee,partialRealized:1497.5,partialMark,longMark,shortMark,originalBasis:a.percentBasis,maxLoss:a.maxLoss,breakeven:a.breakEvens[0],feeOnlyEditPreservesPrevious:true};
 });
 await caseRun('Saved long and short closes, exclusion, and realized marks',async()=>{
  const makeItem=(qty)=>({name:'Local close verification '+qty,document:{schema:1,symbol:'SPX',root:rootId,expiry,
   legs:[{...legs[0],qty,entry:100}]}});
  const long=makeItem(3),saved=await get('save',long),at=Date.now();
  long.document.legs[0].closes=[{qty:1,price:115,at}];
  const part=await get('save',{...long,...saved});
  assert.equal(part.id,saved.id);
  long.document.legs[0].closes.push({qty:2,price:95,at});
  const closed=await get('save',{...long,...part});assert.equal(closed.id,saved.id);
  const invalid=structuredClone(long);invalid.document.legs[0].closes.push({qty:1,price:100,at});
  await assert.rejects(get('save',{...invalid,...closed}));
  const short=makeItem(-2);short.document.legs[0].closes=[{qty:2,price:95,at}];
  const shortSaved=await get('save',short);
  const excluded=structuredClone(long);excluded.document.legs[0].excluded=true;
  const whatIf=await get('save',{...excluded,...closed});assert.notEqual(whatIf.id,closed.id);
  for(let i=0;i<45;i++){
   const lm=await get('marks?id='+closed.id),sm=await get('marks?id='+shortSaved.id);
   if(lm.at(-1)?.[1]===500&&sm.at(-1)?.[1]===1000){
    assert.equal(lm.at(-1)[2],0);assert.equal(sm.at(-1)[2],0);
    assert.deepEqual(await get('marks?id='+whatIf.id),[]);
    return {longRealized:500,shortRealized:1000,openMarketValue:0,overCloseRejected:true,keptSavedTradeId:true,excludedScenarioSeparate:true};
   }
   await delay(1000);
  }
  throw Error('Timed out waiting for saved realized marks.');
 });
 await caseRun('Aligned bars from TWS history',async()=>{
  const bars=await get('history',{window:'1D',legs});
  assert.ok(bars.points.length,'TWS returned no aligned bars.');
  const at=bars.points[Math.floor(bars.points.length/2)][0],fee=1.25;
  const position=[{...legs[0],qty:3,closes:[{qty:1,price:105,at}]}];
  const original=await get('history',{window:'1D',legs:position});
  const adjusted=await get('history',{window:'1D',legs:position,commissionPerContract:fee});
  assert.equal(adjusted.points.length,original.points.length);
  for(const [i,[timestamp,pnl]] of adjusted.points.entries()){
   assert.equal(timestamp,original.points[i][0]);
   assert.ok(Math.abs(original.points[i][1]-pnl-fee*(3+(timestamp>=at?1:0)))<.002);
  }
  return {alignedBars:bars.points.length,coverage:bars.coverage,commissionPerSide:fee,closedOneAt:at,commissionAdjustedBars:adjusted.points.length};
 });
 await caseRun('Historical time and sales',async()=>{
  const tape=await get('tape?id='+sample.C);
  assert.ok(tape.rows.length,tape.message||'TWS returned no trade prints.');
  return {prints:tape.rows.length};
 });
 for(const symbol of ['SPY','AAPL','ES@CME']){
  await caseRun('Discover '+symbol,async()=>{
   const i=symbol.includes('@')?await get(query('instrument',{symbol})):await equity(symbol);assert.ok(i.conId>0&&i.defaultRoot);
   const r=i.defaultRoot,e=i.roots[r].expiries[0],b=await get(query('book',{symbol:i.symbol,root:r,expiry:e}));
   assert.ok(b.strikes.length);return {currency:i.currency,venue:i.exchange,secType:i.secType,expiry:e,strikes:b.strikes.length,multiplier:i.roots[r].multiplier};
  });
 }
 await caseRun('International listing by contract ID',async()=>{
  const hits=await get(query('search',{q:'7203'}));
  const hit=hits.find(h=>h.currency==='JPY'&&h.secType==='STK');assert.ok(hit,'No JPY listing returned by TWS.');
  const i=await get(query('instrument',{symbol:hit.key}));assert.equal(i.conId,hit.conId);assert.equal(i.currency,'JPY');
  return {key:hit.key,currency:i.currency,exchange:i.primaryExchange||i.exchange,classes:Object.keys(i.roots)};
 });
 await caseRun('TWS scanner and news',async()=>{
  const i=await equity('SPY');
  const [ranked,news,events]=await Promise.all([get('scanner?code=HOT_BY_OPT_VOLUME'),get('news?id='+i.conId),get('events?id='+i.conId)]);
  assert.ok(ranked.length);assert.ok(Array.isArray(news.providers));return {scannerRows:ranked.length,providers:news.providers.length,headlines:news.items.length,corporateEventsStatus:events.status,corporateEventsMessage:events.message};
 });
} catch(e){out.cases.push({name:'Test prerequisites',passed:false,error:e.message});console.error(e.message)}
finally{
 server.kill('SIGTERM');await new Promise(r=>server.exitCode!=null||server.signalCode?r():server.once('exit',r));await rm(tmp,{recursive:true,force:true});
 if(!out.cases.length)out.cases.push({name:selectedCase,passed:false,error:'Unknown verification case.'});
 out.passed=out.cases.every(x=>x.passed);
 if(target)await writeFile(target,JSON.stringify(out,null,2)+'\n');else console.log(JSON.stringify(out,null,2));
 if(!out.passed)process.exitCode=1;
}

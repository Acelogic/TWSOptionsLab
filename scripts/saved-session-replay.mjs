// Deterministic market observations for the Saved Trades end-to-end replay.
// The adapter is compiled into a temporary copy of the Rust application.
import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {cp,mkdir,readFile,writeFile} from 'node:fs/promises';
import {join} from 'node:path';

const epoch=(date,hour)=>Date.parse(date+'T'+hour+':00Z');
const tradingDates=['2026-11-17','2026-11-18','2026-11-19','2026-11-20','2026-11-23','2026-11-24','2026-11-25','2026-11-27','2026-11-30'];
const close=date=>epoch(date,date==='2026-11-27'?'18:00':'21:00');
const historySide={midpoint:[4,6],bid:[3.75,5.5],ask:[4.5,6.75]};

function cases(option,item){
 const before=epoch('2026-11-17','16:00'),during=epoch('2026-11-20','16:00'),after=epoch('2026-11-21','15:00');
 const fixtures=[];
 function trade(name,qty,changes={}){
  const leg={...option('QA',7000+fixtures.length,'20261218',qty,5),...changes.leg};
  const row=item(name,'QA',name,[leg],changes.opened??before);
  if(changes.pricing)row.document.pricing=changes.pricing;
  if(changes.unknown){
   delete row.document.openedAt;row.created=changes.persistedBefore?before:after;row.createdAt=row.created;
   row.document.source={provider:'OptionStrat',createdAtText:'Nov 2, 2026, 10:00 AM'};
  }
  fixtures.push(row);
 }
 trade('long',2);
 trade('short-natural',-1,{pricing:'natural'});
 trade('long-natural',1,{pricing:'natural'});
 trade('partial',2,{leg:{closes:[{qty:1,price:7,at:during}]}});
 trade('opened-during',1,{opened:during});
 trade('opened-later',1,{opened:after});
 trade('unknown-opening',1,{unknown:true});
 trade('established-by-local-save',1,{unknown:true,persistedBefore:true});
 trade('unknown-close',2,{leg:{closes:[{qty:1,price:7,confirmedClosedBy:after}]}});
 trade('missing-prior',1);trade('missing-latest',1);trade('wrong-date-observation',1);trade('unchanged-price',1);
 const plans=[
  ['weekend','2026-11-22','17:00','2026-11-19','2026-11-20','closed'],
  ['limitedOptionsHours','2026-11-22','17:00','2026-11-19','2026-11-20','closed'],
  ['reopen','2026-11-23','15:30','2026-11-20','2026-11-23','live'],
  ['reopenedExtended','2026-11-23','14:00','2026-11-20','2026-11-23','live'],
  ['holiday','2026-11-26','17:00','2026-11-24','2026-11-25','closed'],
  ['mixedMarkets','2026-11-26','15:30','2026-11-24','2026-11-25','mixed'],
  ['beforeEarlyClose','2026-11-27','17:59','2026-11-25','2026-11-27','live'],
  ['afterEarlyClose','2026-11-27','18:01','2026-11-25','2026-11-27','closed']
 ];
 const scenarios={};
 for(const [name,date,time,priorDate,lastDate,mode] of plans){
  const now=epoch(date,time),items=[],history=[];
  const limited=name==='limitedOptionsHours';
  const endOfSession=date=>close(date)+(limited?15*60000:0);
  const datedSessions=tradingDates.filter(d=>!limited||d>='2026-11-23')
   .map(d=>[epoch(d,'14:30'),endOfSession(d)]);
  for(const position of fixtures){
   const conId=position.document.legs[0].conId;
   // An explicit exchange calendar keeps Thanksgiving closed and ends the
   // Black Friday session at 13:00 ET. A normal 16:00 assumption would fail.
   const trading=name==='reopenedExtended'?[[epoch('2026-11-23','13:30'),epoch('2026-11-23','14:25')],...datedSessions]:datedSessions;
   const listing={ticker:'QA',secType:'OPT',zone:'America/New_York',currency:'USD',exchange:'SMART',primary:'CBOE',usEquitySession:true,
    sessions:datedSessions,tradingSessions:trading,closedSessionDates:['2026-11-26']};
   let live=mode==='live',ends=endOfSession,dates=[priorDate,lastDate];
   if(mode==='mixed'&&['short-natural','long-natural'].includes(position.id)){
    const london=position.id==='long-natural';
    const listedDays=[...tradingDates,'2026-11-26'].sort();
    ends=date=>epoch(date,london?'16:30':'06:30');
    const windows=listedDays.map(date=>[epoch(date,london?'08:00':'00:00'),ends(date)]);
    Object.assign(listing,{zone:london?'Europe/London':'Asia/Tokyo',primary:london?'LSE':'TSE',usEquitySession:false,
     sessions:windows,tradingSessions:windows,closedSessionDates:[]});
    dates=['2026-11-25','2026-11-26'];live=london;
   }
   const quote={bid:8.75,ask:9.25,mid:9,last:9,close:6,at:now-1000,
    closeAt:now-1000,lastAt:now-1000,lastTradeTime:now-1000,feed:live?'Live':'Frozen'};
   items.push({conId,listing,quote});
   for(const [side,values] of Object.entries(historySide))for(const [i,sessionDate] of dates.entries()){
    const missing=(position.id==='missing-prior'&&i===0)||(position.id==='missing-latest'&&i===1);
    if(missing || (!i&&position.id==='opened-during'&&name==='weekend'))continue;
    const end=ends(sessionDate),at=position.id==='wrong-date-observation'&&i===1?ends(dates[0]):end;
    history.push({conId,side:side.toUpperCase(),date:sessionDate,end,at,price:position.id==='unchanged-price'?5:values[i]});
   }
  }
  scenarios[name]={now,priorDate,lastDate,mode,items,history,trades:fixtures};
 }
 return {fixtures,scenarios};
}

function assertions(input,envelopes){
 const byCase={};
 for(const [name,scenario] of Object.entries(input.scenarios)){
  const rows=envelopes[name].rows,row=rows.long;
  if(scenario.mode==='closed'){
   assert.equal(row.dayPeriod?.mode,'closed',name+' day mode');
   assert.equal(row.dayPeriod?.date,scenario.lastDate,name+' reported session');
   assert.equal(row.dayPeriod?.priorDate,scenario.priorDate,name+' prior session');
   assert.equal(row.dayPnl,400,name+' long 2 × 100 × (6 − 4)');
   assert.equal(row.dayPct,40);
   assert.equal(rows['short-natural'].dayPnl,-225,name+' natural uses ASK on the short');
   assert.equal(rows['long-natural'].dayPnl,175,name+' natural uses BID on the long');
   if(name==='limitedOptionsHours'){
    assert.ok(envelopes[name].requested.length);
    assert.ok(envelopes[name].requested.every(req=>req.end===epoch(scenario.lastDate,'21:15')&&req.priorEnd===epoch(scenario.priorDate,'21:15')),
     'Limited TWS option calendar must retain the observed 16:15 ET regular close on both dates');
   }
   for(const id of ['missing-prior','missing-latest','wrong-date-observation']){
    assert.equal(rows[id].dayPnl,null,name+' no substitute for missing '+id);
    assert.equal(rows[id].dayPct,null);
   }
   assert.equal(rows['unchanged-price'].dayPnl,0,name+' two confirmed equal prices really yield zero');
  }else if(scenario.mode==='live'){
   assert.notEqual(row.dayPeriod?.mode,'closed',name+' must be live');
   assert.equal(row.dayPnl,600,name+' live 2 × 100 × (9 − 6)');
   assert.equal(row.dayPct,60);
  }else{
   assert.equal(row.dayPeriod.date,'2026-11-25');
   assert.equal(rows['short-natural'].dayPeriod.date,'2026-11-26');
   assert.equal(rows['short-natural'].dayPeriod.priorDate,'2026-11-25');
   assert.equal(rows['long-natural'].dayPeriod.mode,'live');
  }
  byCase[name]={at:new Date(scenario.now).toISOString(),phase:scenario.mode,dayReturn:row.dayPnl,period:row.dayPeriod??null,
   source:row.daySource,missing:rows['missing-prior'].dayPnl,requested:envelopes[name].requested};
 }
 const weekend=envelopes.weekend.rows;
 const calculations={
  partial:[498.75,false],             // (7−4)×100 + (6−4)×100 − closing fee
  'opened-during':[98.75,false],       // (6−5)×100 − opening fee
  'opened-later':[0,false],            // No exposure at either close
  'unknown-opening':[200,true],        // Current 1-contract exposure × (6−4)×100
  'established-by-local-save':[200,false], // Held in local SQLite before the prior cutoff
  'unknown-close':[200,true]           // Currently open 1 of 2; timing is unconfirmed
 };
 const chronology={};
 for(const [id,[pnl,estimated]] of Object.entries(calculations)){
  const row=weekend[id];assert.equal(row.dayPnl,pnl,id+' daily return');
  assert.equal(row.dayPeriod?.estimated,estimated,id+' chronology marker');
  chronology[id]={dayPnl:row.dayPnl,dayPct:row.dayPct,estimated:row.dayPeriod.estimated,source:row.daySource};
 }
 assert.equal(weekend.long.totalPnl,797.5,'Separate frozen 9 mark still drives total P&L');
 return {byCase,chronology};
}

export async function replaySavedSessions({project,scratch,option,item}){
 const input=cases(option,item),dir=join(scratch,'session-replay'),name='saved-session-replay';
 await mkdir(dir,{recursive:true});await cp(join(project,'src'),join(dir,'src'),{recursive:true});
 const manifest=await readFile(join(project,'Cargo.toml'),'utf8');
 await writeFile(join(dir,'Cargo.toml'),manifest+'\n[[bin]]\nname = "'+name+'"\npath = "src/main.rs"\n');
 await cp(join(project,'Cargo.lock'),join(dir,'Cargo.lock'));
 const entryPath=join(dir,'src/main.rs'),entry=await readFile(entryPath,'utf8');
 const start='async fn main() -> Result<()> {';
 assert.ok(entry.includes(start),'Locate Rust application entry point');
 await writeFile(entryPath,entry.replace(start,start+'\n    if std::env::args().any(|a| a=="--replay") { return snapshots::session_report(std::io::stdin().lock()); }'));
 const adapter=await readFile(join(project,'scripts/saved-session-adapter.rs'),'utf8');
 const snapshotPath=join(dir,'src/snapshots.rs');
 await writeFile(snapshotPath,(await readFile(snapshotPath,'utf8'))+'\n'+adapter);
 // Keep the named replay binary apart from the installed application. Reuse
 // compiled dependencies so reruns need only compile the application sources.
 const target=join(project,'target');
 execFileSync('cargo',['build','--quiet','--locked','--manifest-path',join(dir,'Cargo.toml'),'--target-dir',target,'--bin',name],{cwd:dir,stdio:'inherit'});
 const raw=execFileSync(join(target,'debug',name),['--replay'],{input:JSON.stringify(input.scenarios),encoding:'utf8',maxBuffer:8*1024*1024});
 const envelopes=JSON.parse(raw),details=assertions(input,envelopes);
 return {library:input.fixtures,envelopes,details};
}

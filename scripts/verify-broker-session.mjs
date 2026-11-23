// Friday broker-return replay through the HTTP importer, private SQLite and native valuation.
// Failure cases: model vs actual size, variable fills/fees, reversals, absent or
// incomplete inventory, missing prices, duplicate fills, stale versions and stored-model mutation.
import assert from 'node:assert/strict';
import {execFileSync, spawn} from 'node:child_process';
import {cp, mkdir, mkdtemp, readFile, rm, writeFile} from 'node:fs/promises';
import net from 'node:net';
import {tmpdir} from 'node:os';
import {dirname, join, resolve} from 'node:path';
import {fileURLToPath} from 'node:url';

const project=dirname(dirname(fileURLToPath(import.meta.url)));
const destination=process.argv[2];
if(!destination)throw Error('Supply an output JSON path for the verified replay.');
const scratch=await mkdtemp(join(tmpdir(),'tws-broker-return-')), db=join(scratch,'db');
const manifest=join(scratch,'Cargo.toml'), name='broker-session-verification', target=join(project,'target');
const date='2026-11-20', priorDate='2026-11-19';
const close=d=>Date.parse(d+'T21:00:00Z'), open=d=>Date.parse(d+'T14:30:00Z');
const end=close(date), priorEnd=close(priorDate), now=Date.parse('2026-11-22T17:00:00Z');
let server, broker;
const delay=ms=>new Promise(resolve=>setTimeout(resolve,ms));
try {
 await mkdir(db);await cp(join(project,'src'),join(scratch,'src'),{recursive:true});
 await cp(join(project,'Cargo.lock'),join(scratch,'Cargo.lock'));
 await writeFile(manifest,(await readFile(join(project,'Cargo.toml'),'utf8'))+
  '\n[[bin]]\nname = "'+name+'"\npath = "src/main.rs"\n');
 const main=join(scratch,'src/main.rs'), snapshot=join(scratch,'src/snapshots.rs');
 const head='async fn main() -> Result<()> {';
 const mainSource=await readFile(main,'utf8');assert.ok(mainSource.includes(head));
 await writeFile(main,mainSource.replace(head,head+`
    if let Some(path) = std::env::var_os("BROKER_REPLAY_DB") {
        let history=options_history::OptionsHistory::new(Path::new(&path))?;
        let market=Market::new(Some(std::env::var("BROKER_WIRE_PORT")?.parse()?));
        let (scope,_,_)=history.saved_scope(&market,1).await?;
        let mut saved = Library::new(Path::new(&path))?.list_for_valuation(scope.as_deref())?;
        history.review_session_evidence(&mut saved,scope.as_deref());
        let mut cases: Value = serde_json::from_reader(std::io::stdin().lock())?;
        cases["friday"]["trades"] = json!(saved);
        return snapshots::session_report(serde_json::to_vec(&cases)?.as_slice());
    }`));
 await writeFile(snapshot,(await readFile(snapshot,'utf8'))+'\n'+(await readFile(join(project,'scripts/saved-session-adapter.rs'),'utf8')));
 execFileSync('cargo',['build','--locked','--quiet','--manifest-path',manifest,'--target-dir',target,'--bin',name],{stdio:'inherit'});
 const binary=join(target,'debug',name), listener=net.createServer();
 await new Promise(r=>listener.listen(0,'127.0.0.1',r));const port=listener.address().port;await new Promise(r=>listener.close(r));
 // Supply native TWS handshake and managed-account replies. OHLC bars still
 // enter only through the private valuation fixture.
 const scopeFile=join(scratch,'active-accounts'),portFile=join(scratch,'wire-port');
 await writeFile(scopeFile,'FIXTURE-BROKER-A');
 const wire=String.raw`
import socketserver,struct,sys,pathlib
current=pathlib.Path(sys.argv[1]);target=pathlib.Path(sys.argv[2])
class Handler(socketserver.StreamRequestHandler):
 def exact(self,n):
  body=self.rfile.read(n)
  if len(body)!=n: raise EOFError()
  return body
 def read_frame(self):
  return self.exact(struct.unpack('!I',self.exact(4))[0])
 def send(self,b):
  self.wfile.write(struct.pack('!I',len(b))+b);self.wfile.flush()
 def accounts(self,a):
  b=a.encode();self.send(struct.pack('!I',215)+bytes((10,len(b)))+b)
 def handle(self):
  try:
   if self.exact(4)!=b'API\x00':return
   ver=self.read_frame().decode().split('..')[-1].strip('\x00')
   self.send(ver.encode()+b'\x0020261122 12:00:00 US/Eastern\x00')
   self.read_frame()
   self.send(struct.pack('!I',209)+bytes((8,50)))
   self.accounts('FIXTURE-BROKER-A')
   while True:
    msg=self.read_frame()
    if len(msg)>=4 and int.from_bytes(msg[:4],'big')==217:
     self.accounts(current.read_text().strip())
  except (EOFError,OSError): pass
class Server(socketserver.ThreadingTCPServer):
 daemon_threads=True
with Server(('127.0.0.1',0),Handler) as app:
 target.write_text(str(app.server_address[1]));app.serve_forever()
`;
 broker=spawn('python3',['-c',wire,scopeFile,portFile],{stdio:'ignore'});
 let wirePort;
 for(let i=0;;i++){try{wirePort=(await readFile(portFile,'utf8')).trim();if(wirePort)break;}catch{}if(i>40)throw Error('Private TWS replay did not start');await delay(80);}
 server=spawn(binary,['--port',String(port),'--no-open','--data-dir',db,'--tws-port',wirePort],{stdio:'ignore'});
 const api=async (route,body)=>{const r=await fetch('http://127.0.0.1:'+port+'/api/'+route,body===undefined?{}:{method:'POST',
  headers:{'content-type':'application/json'},body:JSON.stringify(body)});return {status:r.status,value:await r.json()};};
 for(let i=0;;i++){try{await api('library');break;}catch(e){if(i>=50)throw e;await delay(100);}}
 const scopeA=(await api('account-scope',{accountId:'FIXTURE-BROKER-A'})).value.accountScope;
 const scopeB=(await api('account-scope',{accountId:'FIXTURE-BROKER-B'})).value.accountScope;
 const models={}, items=[], observations=[], records=[];
 const names=['partial','reversed','flat','roundtrip','opened','no-prices','no-account','incomplete-spread','model-closed'];
 const mkleg=id=>({kind:'option',symbol:'QA',secType:'OPT',right:'C',root:'QA',strike:100,expiry:'20261218',
    conId:id,currency:'USD',multiplier:100,qty:100,entry:5});
 const doc=legs=>({schema:1,symbol:'QA',currency:'USD',root:'QA',expiry:'20261218',legs,pricing:'natural',commissionPerContract:0});
 for(const [i,n] of names.entries()){
  const id=590100+i,leg=mkleg(id), document=doc(n==='incomplete-spread'?[leg,mkleg(590200)]:[leg]);
  if(n==='model-closed')leg.closes=[{qty:100,price:5,at:Date.parse('2026-10-01T19:00:00Z')}];
  const saved=await api('save',{name:n,document});assert.equal(saved.status,200);models[n]={...saved.value,document};
  for(const l of document.legs) {
   items.push({conId:l.conId,listing:{secType:'OPT',zone:'America/New_York',currency:'USD',usEquitySession:true,
    sessions:[priorDate,date].map(d=>[open(d),close(d)]),closedSessionDates:['2026-11-21','2026-11-22']},
    quote:{feed:'Frozen',bid:9,ask:10,mid:9.5,at:now}});
   for(const [side,prices] of [['BID',[4,6]],['ASK',[5,8]],['MIDPOINT',[4.5,7]]]){
    for(const [i,barEnd] of [priorEnd,end].entries()){
     if(n==='no-prices'||n==='flat'||n==='roundtrip'||(n==='opened'&&!i))continue;
     observations.push({conId:l.conId,side,end:barEnd,at:barEnd,price:prices[i]});
    }
   }
  }
 }
 const fill=(tag,qty,price,commission)=>({id:tag,at:open(date)+60000,qty,price,commission,currency:'USD'});
 const evidence=(n,start,finish,fills=[])=>({strategyId:models[n].id,version:models[n].version,date,priorDate,source:'IBKR Activity Statement',
   accountScope:scopeA,inventoryMethod:'datedStatement',complete:true,legs:[{conId:models[n].document.legs[0].conId,
   currency:'USD',multiplier:100,priorEnd,end,priorQty:start,endQty:finish,fills}]});
 records.push(evidence('partial',2,3,[fill('EX-P.01.01',2,5,.7),fill('EX-P.02.01',-1,6.5,.55)]),
    evidence('reversed',2,-1,[fill('EX-R',-3,7,1)]),evidence('flat',0,0),
    evidence('roundtrip',0,0,[fill('EX-T-1',1,5,1),fill('EX-T-2',-1,7,-.5)]),
    evidence('opened',0,1,[fill('EX-O',1,5.2,.7)]),evidence('no-prices',2,2),evidence('model-closed',1,1));
 const invalid=evidence('incomplete-spread',2,2);
 const before=(await api('library')).value;
 assert.equal((await api('account-session-evidence',{records:[invalid]})).status,400,'Incomplete spread cannot become actual.');
 const broken=structuredClone(records[0]);broken.legs[0].fills[1].id=broken.legs[0].fills[0].id;
 assert.equal((await api('account-session-evidence',{records:[broken]})).status,400,'Duplicate executions cannot be booked twice.');
 const wrong=structuredClone(records[0]);wrong.version+=1;
 assert.equal((await api('account-session-evidence',{records:[wrong]})).status,400,'Version must still be current.');
 const saved=await api('account-session-evidence',{records});assert.equal(saved.status,200,JSON.stringify(saved));
 assert.deepEqual((await api('library')).value,before,'Account import must preserve model documents and versions.');
 const replay=(folder=db)=>JSON.parse(execFileSync(binary,[],{input:JSON.stringify({friday:{now,items,history:observations}}),
  encoding:'utf8',env:{...process.env,BROKER_REPLAY_DB:folder,BROKER_WIRE_PORT:wirePort},maxBuffer:8*1024*1024})).friday;
 const output=replay(), rows=Object.fromEntries(names.map(n=>[n,output.rows[models[n].id]]));
 const expected={partial:648.75,reversed:499,flat:0,roundtrip:199.5,opened:79.3,'model-closed':200};
 for(const [n,pnl] of Object.entries(expected)){
  const r=rows[n];assert.equal(r.brokerStatus,'verified',JSON.stringify(r));
  assert.equal(r.dayPeriod.verified,true);assert.equal(r.dayPeriod.attribution,'broker');assert.equal(r.dayPeriod.estimated,false);
  assert.ok(Math.abs(r.dayPnl-pnl)<1e-7);assert.equal(r.brokerDayPnl,r.dayPnl);assert.equal(r.dayPct,null);
  assert.equal(r.totalPnl,n==='model-closed'?0:40000);assert.equal(r.legs[0].dayPnl,r.dayPnl);assert.equal(r.brokerAbsent,n==='flat');
 }
 assert.equal(rows['model-closed'].modeledDayPnl,0);assert.equal(rows['model-closed'].modeledDayPeriod.mode,'settled');
 assert.equal(rows.partial.modeledDayPnl,20000);assert.equal(rows.partial.brokerCommissions,1.25);
 assert.equal(rows.reversed.brokerLegs[0].dayPrior.method,'Bid');assert.equal(rows.reversed.brokerLegs[0].dayCurrent.method,'Ask');
 assert.equal(rows['no-prices'].dayPnl,null);assert.equal(rows['no-prices'].brokerStatus,'pricesUnavailable');
 assert.equal(rows['no-account'].dayPnl,20000);assert.equal(rows['no-account'].brokerDayPnl,null);assert.equal(rows['no-account'].dayPeriod.verified,false);
 assert.equal(rows['incomplete-spread'].dayPeriod.verified,false);
 // Reopen an actual pre-scope-key library schema. The migration must preserve
 // the original account-bound record and all model data, before B is imported.
 const legacy=join(scratch,'legacy');await mkdir(legacy);
 for(const file of ['library.sqlite','options-history.sqlite'])
  execFileSync('sqlite3',['-readonly',join(db,file),'.backup '+join(legacy,file)]);
 execFileSync('sqlite3',[join(legacy,'library.sqlite'),`
    DROP INDEX account_sessions_scope_date;
    ALTER TABLE account_sessions RENAME TO current_sessions;
    CREATE TABLE account_sessions(strategy_id TEXT NOT NULL REFERENCES strategies(id) ON DELETE CASCADE,
     version INTEGER NOT NULL,session_date TEXT NOT NULL,payload TEXT NOT NULL,PRIMARY KEY(strategy_id,version,session_date));
    INSERT INTO account_sessions SELECT strategy_id,version,session_date,payload FROM current_sessions;
    DROP TABLE current_sessions;
    CREATE INDEX account_sessions_scope_date ON account_sessions(json_extract(payload,'$.accountScope'),session_date);`]);
 const fromLegacy=replay(legacy).rows[models.partial.id];assert.equal(fromLegacy.brokerDayPnl,648.75);
 assert.equal(execFileSync('sqlite3',[join(legacy,'library.sqlite'),"SELECT count(*) FROM pragma_table_info('account_sessions') WHERE name='account_scope' AND pk>0"],{encoding:'utf8'}).trim(),'1');
 const alternate={...evidence('partial',1,1),accountScope:scopeB};
 assert.equal((await api('account-session-evidence',{records:[alternate]})).status,200,'Same model and dates can retain a second independent account observation.');
 assert.equal((await api('saved-snapshots?mode=1')).value.brokerAccount.status,'current');
 assert.equal(replay().rows[models.partial.id].brokerDayPnl,648.75);
 await writeFile(scopeFile,'FIXTURE-BROKER-B');
 assert.equal((await api('saved-snapshots?mode=1')).value.brokerAccount.status,'current');
 const switched=replay().rows;assert.equal(switched[models.partial.id].brokerDayPnl,200);
 assert.equal(switched[models.flat.id].brokerDayPnl,null,'A verified flat result from the previous account cannot carry across.');
 await writeFile(scopeFile,'FIXTURE-BROKER-A,FIXTURE-BROKER-B');
 assert.equal((await api('saved-snapshots?mode=1')).value.brokerAccount.status,'multipleAccounts');
 assert.equal(replay().rows[models.partial.id].brokerDayPnl,null);
 await writeFile(scopeFile,'');
 assert.equal((await api('saved-snapshots?mode=1')).value.brokerAccount.status,'unconfirmed');
 assert.equal(replay().rows[models.partial.id].brokerDayPnl,null);
 await writeFile(scopeFile,'FIXTURE-BROKER-A');
 const submitTrade=async(accountId,event)=>{
  const result=await api('options-history/import',{source:'IBKR Flex',accounts:[{accountId,from:Math.min(priorEnd,event.at),to:Math.max(end,event.at),executions:[event]}]});
  assert.equal(result.status,200,JSON.stringify(result.value));
 };
 const recorded=(model,id,qty,price,commission)=>({id,at:open(date)+60000,conId:models[model].document.legs[0].conId,
  secType:'OPT',symbol:'QA',localSymbol:'QA fixture',expiry:'20261218',strike:100,right:'C',side:qty>0?'BUY':'SELL',qty:Math.abs(qty),
  currency:'USD',commissionCurrency:'USD',multiplier:100,price,commission});
 await submitTrade('FIXTURE-BROKER-A',recorded('partial','EX-P.01.01',2,5,.7));
 assert.equal(replay().rows[models.partial.id].brokerStatus,'verified','Partial archive agreement should keep statement valid.');
 await submitTrade('FIXTURE-BROKER-A',recorded('partial','EX-P.01.02',2,5,.9));
 let withheld=replay().rows[models.partial.id];
 assert.equal(withheld.brokerStatus,'disputed');assert.equal(withheld.brokerDayPnl,null);assert.equal(withheld.dayPnl,20000);
 const correctedStatement=structuredClone(records[0]);
 correctedStatement.legs[0].fills[0].id='EX-P.01.02';correctedStatement.legs[0].fills[0].commission=.9;
 assert.equal((await api('account-session-evidence',{records:[correctedStatement]})).status,400,'Immutable alternate recorded for independent reconciliation');
 const corrected=replay().rows[models.partial.id];assert.equal(corrected.brokerStatus,'verified');
 assert.ok(Math.abs(corrected.brokerDayPnl-648.55)<1e-7,JSON.stringify(corrected));assert.match(corrected.brokerDaySource,/Reconciled/);
 await submitTrade('FIXTURE-BROKER-A',recorded('flat','NEW-EXECUTION.15.01',1,3,1));
 assert.equal(replay().rows[models.flat.id].brokerStatus,'disputed','An independently observed fill contradicts verified absence.');
 await submitTrade('FIXTURE-BROKER-A',recorded('opened','CSV-ALTERNATE.11.01',1,5.2,.7));
 assert.equal(replay().rows[models.opened.id].brokerStatus,'verified','Statement may have a different official transaction identifier.');
 const moved={...recorded('flat','CSV-ALTERNATE.11.02',1,5.2,.7)};
 await submitTrade('FIXTURE-BROKER-A',moved);
 assert.equal(replay().rows[models.opened.id].brokerStatus,'disputed','Prior location of a corrected execution must challenge its earlier statement.');
 const conflicting=structuredClone(records[1]);conflicting.legs[0].fills[0].price=7.25;
 const conflict=await api('account-session-evidence',{records:[conflicting]});assert.equal(conflict.status,400);
 assert.equal(replay().rows[models.reversed.id].brokerStatus,'disputed');
 assert.equal((await api('account-session-evidence',{records:[records[1]]})).status,400,'Retrying an earlier statement cannot clear unresolved conflicting evidence.');
 assert.equal(JSON.parse(execFileSync('sqlite3',[join(db,'library.sqlite'),"SELECT payload FROM account_sessions WHERE strategy_id='"+models.reversed.id+"'"],{encoding:'utf8'})).legs[0].fills[0].price,7);
 const lifecycle=(n,id,at,eventType)=>({...recorded(n,'IBKR-FLEX-LIFECYCLE/'+id,-1,0,0),at,eventType,price:null});
 await submitTrade('FIXTURE-BROKER-A',lifecycle('partial','AFTER-RTH',end+20*60000,'expiration'));
 assert.ok(Math.abs(replay().rows[models.partial.id].brokerDayPnl-648.55)<1e-7,'16:20 expiration is outside the 16:00 return endpoint.');
 await submitTrade('FIXTURE-BROKER-A',lifecycle('roundtrip','IN-PERIOD',end-60000,'assignment'));
 assert.equal(replay().rows[models.roundtrip.id].brokerStatus,'disputed','Ordinary trade cashflows do not capture assignment delivery.');
 await submitTrade('FIXTURE-BROKER-A',lifecycle('model-closed','BEFORE-PRIOR',priorEnd-60000,'expiration'));
 assert.equal(replay().rows[models['model-closed'].id].brokerStatus,'disputed','An expired option cannot have nonzero later holdings.');
 await writeFile(scopeFile,'FIXTURE-BROKER-B');
 assert.equal(replay().rows[models.partial.id].brokerDayPnl,200,'Account A disputes cannot invalidate B.');
 const gone=new Promise(r=>broker.once('exit',r));broker.kill();await gone;broker=null;
 const offline=(await api('saved-snapshots?mode=1')).value;
 assert.equal(offline.brokerAccount.status,'lastVerifiedOffline',JSON.stringify(offline.brokerAccount));
 assert.equal(replay().rows[models.partial.id].brokerDayPnl,200,'Offline scope is the last broker-confirmed B, not A.');
 assert.ok(Object.values(offline.rows).every(r=>r.brokerScopeStatus==='lastVerifiedOffline'&&/offline/i.test(r.brokerDaySource)));
 const update=await api('save',{id:models.partial.id,version:models.partial.version,name:'renamed',document:models.partial.document});
 assert.equal(update.status,200);assert.equal(update.value.version,models.partial.version+1);
 const superseded=replay().rows[models.partial.id];assert.equal(superseded.brokerDayPnl,null);assert.equal(superseded.dayPnl,20000);
 const result={passed:true,asOf:new Date(now).toISOString(),source:'Deterministic broker statement, venue schedule and historical quotes',
   storedRows:before.length,accountSwitch:{first:648.75,second:200,ambiguous:null,unconfirmed:null,offlineSecond:200},oldScopeSchemaMigrated:true,corrections:{changedFeeWithheld:true,independentlyReconciledAlternate:648.55,unexpectedFillWithheld:true,changedContractWithheld:true,alternateStatementIdMatched:true,contradictoryStatementWithheld:true,rawEvidencePreserved:true,afterCloseExpiryOutsidePeriod:true,assignmentInPeriodWithheld:true,postExpiryHoldingWithheld:true,otherAccountUnaffected:true},staleVersionRejected:true,savedModelsUnchanged:true,rows:Object.fromEntries(Object.entries(rows).map(([n,r])=>
    [n,{modelDay:r.modeledDayPnl,brokerDay:r.brokerDayPnl,displayed:r.dayPnl,status:r.brokerStatus,brokerAbsent:r.brokerAbsent,
        charges:r.brokerCommissions,brokerLegs:r.brokerLegs}]))};
 await mkdir(dirname(resolve(destination)),{recursive:true});
 await writeFile(destination,JSON.stringify(result,null,2)+'\n');console.log('Verified and wrote '+destination);
} finally {if(broker)broker.kill();if(server){const stopped=new Promise(r=>server.once('exit',r));if(server.exitCode===null&&server.signalCode===null){server.kill();await stopped;}}await rm(scratch,{recursive:true,force:true});}

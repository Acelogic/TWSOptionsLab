// Native end-to-end tests with disposable SQLite and a private, disconnected test port.
// node scripts/verify-account-evidence.mjs [evidence.json]
import assert from 'node:assert/strict';
import {execFileSync,spawn} from 'node:child_process';
import {createHash,createHmac} from 'node:crypto';
import {mkdtemp,readFile,rm,writeFile} from 'node:fs/promises';
import net from 'node:net';
import {tmpdir} from 'node:os';
import {dirname,join,resolve} from 'node:path';
import {fileURLToPath} from 'node:url';

const root=resolve(dirname(fileURLToPath(import.meta.url)),'..'),tmp=await mkdtemp(join(tmpdir(),'tws-account-evidence-'));
const db=join(tmp,'db'),file=join(db,'library.sqlite'),out=process.argv[2];
const report={when:new Date().toISOString(),provenance:'Verified against fabricated fixtures on a disposable local TWS Options Lab and isolated SQLite file.',cases:[],sha256:{}};
const now=Date.now,delay=ms=>new Promise(r=>setTimeout(r,ms));
const listen=s=>new Promise(r=>s.listen(0,'127.0.0.1',()=>r(s.address().port)));
const close=s=>new Promise(r=>s.close(r));
let backend,base,twsPort,httpPort,offline;
const api=async(name,body)=>{
 const res=await fetch(base+'/api/'+name,body===undefined?{}:{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(body)});
 const data=await res.json();if(!res.ok)throw Error(data.error||res.status);return data;
};
const submit=records=>api('account-session-evidence',{records});
const sql=s=>execFileSync('sqlite3',['-readonly',file,s],{encoding:'utf8'}).trim();
const counts=()=>[Number(sql('SELECT count(*) FROM account_sessions')),Number(sql('SELECT count(*) FROM account_session_executions'))];
const check=(name,details)=>{report.cases.push({name,...details});console.log('PASS '+name)};
async function start(){
 backend=spawn(join(root,'target/debug/tws-options-lab'),['--no-open','--port',String(httpPort),'--tws-port',String(twsPort),'--data-dir',db],{stdio:'ignore'});
 const end=now()+10000;while(now()<end){try{await api('library');return}catch{}await delay(60)}
 throw Error('Temporary Rust backend did not become ready.');
}
async function stop(){
 if(!backend||backend.exitCode!==null||backend.signalCode)return;
 const exited=new Promise(r=>backend.once('exit',r));backend.kill('SIGTERM');await exited;
}
const priorEnd=Date.parse('2024-10-16T20:00:00Z'),end=Date.parse('2024-10-17T20:00:00Z');
const accountScope=createHmac('sha256','local fixture only').update('synthetic QA scope').digest('hex');
const opt=(id,extra={})=>({kind:'option',symbol:'QA',currency:'USD',root:'QA',right:'C',expiry:'20990116',strike:100,conId:id,qty:1,entry:5,multiplier:100,...extra});
const doc=legs=>({schema:1,name:'Fixture',symbol:'QA',currency:'USD',root:'QA',expiry:'20990116',legs});
const save=(name,document,prior={})=>api('save',{...prior,name,document});
const leg=(conId,priorQty=0,endQty=0,fills=[])=>({conId,priorEnd,end,priorQty,endQty,fills,multiplier:100,currency:'USD'});
const fill=(id,qty,clock=end-3600000,price=7,commission=.65)=>({id,qty,at:clock,price,commission,currency:'USD'});
const record=(item,legs)=>({strategyId:item.id,version:item.version,priorDate:'2024-10-16',date:'2024-10-17',source:'IBKR Activity Statement (QA fixture)',
 inventoryMethod:'datedStatement',accountScope,complete:true,legs});
const alter=(original,fn)=>{const copy=structuredClone(original);fn(copy);return copy};
try{
 for(const f of ['src/library/account_sessions.rs','src/library.rs','src/main.rs'])report.sha256[f]=createHash('sha256').update(await readFile(join(root,f))).digest('hex');
 execFileSync('cargo',['build','--locked','--quiet'],{cwd:root,stdio:'inherit'});
 offline=net.createServer(s=>s.destroy());twsPort=await listen(offline);
 const socket=net.createServer();httpPort=await listen(socket);await close(socket);base='http://127.0.0.1:'+httpPort;await start();
 const previouslyClosed={closes:[{qty:1,at:priorEnd-86400000,price:6}]};
 const adoc=doc([opt(101),opt(102),opt(103,previouslyClosed),opt(null,{...previouslyClosed,expiry:'20200117'})]);
 const bdoc=doc([opt(201)]),cdoc=doc([opt(301)]);
 const a=await save('Model A',adoc),b=await save('Model B',bdoc),c=await save('Model C',cdoc);
 const initial=await api('library');
 const aa=record(a,[leg(103),leg(102,0,-1,[fill('fixture-A3',-1,end)]),
   leg(101,2,3,[fill('fixture-A2',2,end-3600000,6,-.05),fill('fixture-A1',-1,end-7200000,5.5,.7)])]);
 const bb=record(b,[leg(201,0,1,[fill('fixture-B',1)])]),cc=record(c,[leg(301)]);
 const reversed=alter(aa,r=>{r.legs.reverse();for(const l of r.legs)l.fills.reverse()});
 const concurrent=await Promise.all([submit([aa]),submit([reversed])]);
 assert.deepEqual(concurrent.map(x=>x.inserted).sort(),[0,1]);assert.deepEqual(concurrent.map(x=>x.unchanged).sort(),[0,1]);
 assert.deepEqual(counts(),[1,3]);assert.deepEqual(await api('library'),initial);
 const persisted=JSON.parse(sql('SELECT payload FROM account_sessions LIMIT 1'));
 assert.deepEqual(persisted.legs.map(l=>l.conId),[101,102,103]);assert.equal(persisted.legs[0].fills[1].commission,-.05);
 check('Atomic concurrent import, canonical retry and private storage',{concurrent,legs:3,fills:3,negativeRebate:-.05});
 const errors=[];
 const bads=[
  ['stale version',r=>r.version++,/version has changed/],['unknown ID',r=>r.strategyId='missing',/no longer exists/],
  ['unverified inventory',r=>r.inventoryMethod='guess',/verified/],['partial coverage',r=>r.complete=false,/complete/],
  ['unattributed source',r=>r.source='Manual guess',/broker evidence source/],['raw account',r=>r.accountScope='FIXTURE-UNHASHED-ACCOUNT',/salted account/],
  ['wrong date',r=>r.priorDate='2024-10-15',/cutoffs/],['empty legs',r=>r.legs=[],/sixteen/],
  ['wrong instrument',r=>r.legs[0].conId=311,/exact coverage/],['wrong multiplier',r=>r.legs[0].multiplier=1,/multiplier/],
  ['wrong currency',r=>r.legs[0].currency='EUR',/Currency/],['wrong cutoff',r=>r.legs[0].end=priorEnd,/cutoffs/],
  ['quantity imbalance',r=>r.legs[0].endQty=2,/does not match/],
  ['fractional contracts',r=>{r.legs[0].endQty=.5;r.legs[0].fills=[fill('half',.5)]},/Invalid cutoff quantity/],
  ['duplicate executions',r=>{r.legs[0].endQty=2;r.legs[0].fills=[fill('twice',1),fill('twice',1)]},/unique/],
  ['out-of-period execution',r=>{r.legs[0].endQty=1;r.legs[0].fills=[fill('old',1,priorEnd)]},/outside/],
  ['wrong fill currency',r=>{r.legs[0].endQty=1;r.legs[0].fills=[{...fill('badccy',1),currency:'CAD'}]},/Invalid execution/]];
 for(const [name,mutate,pattern] of bads){
  await assert.rejects(submit([alter(cc,mutate)]),pattern);errors.push(name);
 }
 await assert.rejects(submit([alter(aa,r=>r.source='IBKR revised description')]),/Conflicting evidence/);
 await assert.rejects(submit([bb,alter(cc,r=>r.legs[0].endQty=2)]),/does not match/);
 await assert.rejects(submit([alter(bb,r=>r.legs[0].fills[0].id='fixture-A1')]),/already attributed/);
 assert.deepEqual(counts(),[1,3]);
 check('Validated units, chronology, source, fees, optimistic version, and transactional rollback',{rejections:errors,rowsAfterRollback:counts()});
 const fork=await save('Another model of contract 101',doc([opt(101)]));
 await assert.rejects(submit([record(fork,[leg(101,3,3)])]),/ambiguous/);
 await assert.rejects(submit([record(fork,[leg(101)])]),/contradict existing/);
 assert.deepEqual(await submit([aa]),{inserted:0,unchanged:1});
 const x=await save('Flat X',doc([opt(501)])),y=await save('Flat Y',doc([opt(501)]));
 assert.deepEqual(await submit([record(x,[leg(501)]),record(y,[leg(501)])]),{inserted:2,unchanged:0});
 check('Ambiguous inventory cannot be attributed twice; independently verified absence stays flat',{rejectedSharedExposure:true,acceptedConsistentZeroes:2});
 await api('delete',fork);
 const updated=await save('Renamed model A',adoc,a);assert.equal(updated.id,a.id);
 await assert.rejects(submit([aa]),/version has changed/);
 assert.equal(Number(sql("SELECT COUNT(*) FROM account_sessions a JOIN strategies s ON a.strategy_id=s.id AND a.version=s.version WHERE json_extract(a.payload,'$.legs[0].conId')=101")),0);
 await assert.rejects(submit([record(updated,[leg(101),leg(102)])]),/exact coverage/);
 assert.deepEqual(await submit([alter(aa,r=>r.version=updated.version)]),{inserted:1,unchanged:0});
 // History versions reference the same executions without double attribution or duplicate execution rows.
 assert.deepEqual(counts(),[4,3]);
 check('Model revisions retain original evidence history and require explicit revalidation',{versions:[a.version,updated.version],records:4,uniqueExecutions:3});
 const before=await api('library');await stop();await start();
 assert.deepEqual(await api('library'),before);assert.ok(!(JSON.stringify(before)).includes(accountScope));assert.deepEqual(counts(),[4,3]);
 assert.deepEqual(await submit([alter(aa,r=>r.version=updated.version)]),{inserted:0,unchanged:1});
 await api('delete',updated);assert.deepEqual(counts(),[2,0]);
 check('Restart persistence, export privacy and deletion of associated evidence',{restart:true,remainingIndependentRows:2});
 report.passed=true;
}catch(e){report.passed=false;report.error=e.stack;console.error(e.stack);process.exitCode=1}
finally{
 await stop();if(offline?.listening)await close(offline);await rm(tmp,{recursive:true,force:true,maxRetries:4,retryDelay:100});
 if(out)await writeFile(out,JSON.stringify(report,null,2)+'\n');else console.log(JSON.stringify(report,null,2));
}

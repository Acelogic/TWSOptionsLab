// node scripts/verify-options-history.mjs /path/to/evidence.json
// Isolated whole-app browser fixture. It never connects to TWS or the user's ledger.
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {mkdtemp,readFile,rm,writeFile} from 'node:fs/promises';
import {createServer} from 'node:http';
import {tmpdir} from 'node:os';
import {dirname,extname,join,resolve,sep} from 'node:path';
import {fileURLToPath} from 'node:url';
import {testBrowser} from './browser-fixture.mjs';

const project=resolve(dirname(fileURLToPath(import.meta.url)),'..'),web=join(project,'web');
const tmp=await mkdtemp(join(tmpdir(),'tws-execution-history-')),out=process.argv[2];
const report={time:new Date().toISOString(),tests:[],files:{},failureModes:[
 'Opening Saved loads broker execution history even though the closed/expired filter is inactive.',
 'A completed spread is hidden because one leg’s current broker contract is open, or the trade table invents a net result without fee or inventory coverage.',
 'Trade date filters use the opening time or UTC date instead of the actual Eastern close, or expanded legs misstate broker fees or execution allocations.',
 'Paging or refreshing loses the expanded trades or discloses groups after account identity becomes unverified.',
 'The execution table drops unmatched/ambiguous or partial fills, assigns another currency, or invents a fee.',
 'A UTC midnight date filters out a fill from the previous Eastern trading date, or equity/cash rows enter the option ledger.',
 'The table presents same-contract candidates as confirmed owners, or interprets saved names as HTML.',
 'Unavailable or partial history is described as complete, filtered-empty looks like broker-empty, or rollover to another section shows a stale response.',
 'Records after the first page cannot be reached or browsing history writes to the broker or library.',
 'A Flex file is sent on cancel, redirected, or used as complete ownership evidence without the user confirming the scope.',
 'Unverified account scope leaks cached rows, or incomplete account pricing is labeled broker-verified.'
]};
const passed=(name,details)=>{report.tests.push({name,details});console.log('PASS '+name)};
const delay=ms=>new Promise(resolve=>setTimeout(resolve,ms));
async function waitFor(probe,why,timeout=10000){
 const end=Date.now()+timeout;
 while(Date.now()<end){try{const ok=await probe();if(ok)return ok}catch{}await delay(60)}
 throw Error('Timed out waiting for '+why);
}
const clock=Date.parse('2026-11-22T14:30:00Z');
const coverage={source:'IBKR / TWS executions',from:'2026-11-16',to:'2026-11-22',asOf:clock,complete:false,message:'Earlier broker executions were not supplied.'};
const savedName='SPX <img src="test">';
const saved=[{id:'candidate-a',version:1,name:savedName,created:clock-10e8,updated:clock-5e8,
 document:{name:savedName,symbol:'SPX',root:'SPXW',expiry:'20251121',source:{provider:'OptionStrat',status:'closed'},
 legs:[{kind:'option',conId:null,symbol:'SPX',root:'SPXW',expiry:'20251121',strike:6980,right:'C',qty:1,entry:2.25,multiplier:100,currency:'USD',closes:[{qty:1,price:3,at:clock-365*86400000}]}]}}];
const snapshotRows={'candidate-a':{id:'candidate-a',version:1,status:'closed',totalPnl:75,dayPnl:0,currency:'USD'}};
for(const [id,attribution,verified,estimated,pnl] of [
 ['broker-row','broker',true,false,0],['estimate-row','model',false,true,10],['model-row','model',false,false,11],['pending-broker','broker',false,false,null]]){
 const row=structuredClone(saved[0]);row.id=id;row.name=id;Object.assign(row.document.legs[0],{conId:2222,expiry:'20991218',closes:[]});saved.push(row);
 snapshotRows[id]={id,version:1,status:'open',totalPnl:200,dayPnl:pnl,currency:'USD',daySource:'Fixture source',
  dayPeriod:{mode:'closed',date:'2026-11-20',priorDate:'2026-11-19',attribution,verified,estimated,loading:id==='pending-broker'}};
}
const core={symbol:'SPX',localSymbol:'SPXW 261120C06980000',secType:'OPT',conId:1001,currency:'USD',expiry:'20261120',
 strike:6980,right:'C',multiplier:100,at:Date.parse('2026-11-21T01:30:00Z'),side:'BUY',qty:2,price:10.125,
 commission:.4135,commissionCurrency:'EUR',positionStatus:'expired',matchStatus:'matched',matches:[{id:'candidate-a',name:savedName}]};
const rows=[
 {...core,id:'partial-1'},
 {...core,id:'partial-2',side:'SELL',qty:1,price:10.23,commission:null,commissionCurrency:null,positionStatus:'closed',matchStatus:'unmatched',matches:[]},
 {...core,id:'ambiguous',symbol:'SPY',localSymbol:'SPY 261120P00600000',conId:1002,strike:600,right:'P',commission:0,commissionCurrency:'USD',
  at:Date.parse('2026-11-19T18:40:00Z'),matchStatus:'ambiguous',matches:[{id:'candidate-a',name:savedName},{id:'candidate-b',name:'Second same-contract trade'}]},
 {...core,id:'future-option',symbol:'ES',localSymbol:'EW4X6 C7000',secType:'FOP',conId:1003,strike:7000,multiplier:50,side:'SELL',qty:3,matchStatus:'unmatched',matches:[]},
 {...core,id:'open-contract',expiry:'20261218',positionStatus:'open'},
 {...core,id:'unknown-contract',symbol:'QQQ',at:null,positionStatus:'unknown',commission:null,matchStatus:'unmatched',matches:[]},
 {...core,id:'excluded-stock',secType:'STK'},
 {...core,id:'excluded-cash',secType:'CASH'}
];
const closedAt=Date.parse('2026-11-21T02:15:00Z'),openedAt=Date.parse('2026-10-04T15:42:00Z');
const legs=[{conId:1001,localSymbol:'SPX call 6,000',right:'C',strike:6000,expiry:'20261218',multiplier:100,direction:'long',
 openedQty:2,closedQty:2,remainingQty:0,netRealizedPnl:88.301722,brokerRealizedPnl:85.052571},{conId:1004,localSymbol:'SPX call 6,010',right:'C',strike:6010,expiry:'20261218',
 multiplier:100,direction:'short',openedQty:2,closedQty:2,remainingQty:0,netRealizedPnl:-12.65}];
const spread={id:'closed-spread',label:'Bull call spread',symbol:'SPX',currency:'USD',status:'closed',openedAt,closedAt,lastAt:closedAt,
 netRealizedPnl:75.65,brokerRealizedPnl:72.4,pnlSource:'Option premium cash flows after allocated opening and closing commissions',pnlReason:'',groupSource:'IBKR combo order',legs,
 fills:[{id:'broker-partial-open',conId:1001,at:openedAt,role:'open',side:'BUY',qty:1,price:4.35,currency:'USD',commission:.65,commissionCurrency:'EUR',netRealizedPnl:0},
 {id:'broker-partial-close',conId:1001,at:closedAt,role:'close',side:'SELL',qty:2,price:4.8,currency:'USD',commission:1.2,commissionCurrency:'USD',netRealizedPnl:88.3,brokerRealizedPnl:85.05}],
 matches:[{id:'candidate-a',name:savedName}],matchStatus:'matched'};
const unpriced={...spread,id:'short-unpriced',label:'Short put',symbol:'QQQ',openedAt:null,closedAt:Date.parse('2026-11-19T16:20:00Z'),
 netRealizedPnl:null,pnlSource:'',pnlReason:'Opening cost and commissions are unavailable for this period.'};
const open={...spread,id:'open-spy',symbol:'SPY',status:'open',closedAt:null,netRealizedPnl:0};
const incomplete={...spread,id:'incomplete-qqq',symbol:'QQQ',status:'incomplete',closedAt:null,openedAt:null,netRealizedPnl:null,
 pnlReason:'Trade direction or initial inventory is unavailable.'};
const groups=[open,unpriced,spread,incomplete];
let ledger={rows,trades:groups,coverage,status:'ok'},error=false,hold=false,release=null,readCount=0,redirectImport=false;
const submitted=[];
const requests=[];
const server=createServer(async(req,res)=>{
 try{
  const path=new URL(req.url,'http://127.0.0.1').pathname;
  if(path.startsWith('/api/')){
   requests.push([req.method,path]);
   const reply=(code,value)=>res.writeHead(code,{'Content-Type':'application/json','Cache-Control':'no-store'}).end(JSON.stringify(value));
   if(req.method==='POST'&&path==='/api/ibkr-flex'){
    let bytes='';for await(const chunk of req)bytes+=chunk;
    const data=JSON.parse(bytes);submitted.push(data);
    if(redirectImport){res.writeHead(307,{Location:'/api/not-the-importer'}).end();return}
    if(data.xml.some(value=>!value.includes('<FlexQueryResponse'))){reply(400,{error:'Choose an IBKR Activity Flex XML report.'});return}
    ledger={rows:[{...core,id:'flex-fill'}],coverage:{...coverage,source:'Activity Flex'},status:'ok',accountVerified:true};
    reply(200,{ok:true,statements:data.xml.length,accounts:1,executions:1,verifiedStrategies:data.verifySaved?1:0,
     skippedStrategies:[{name:'QA map <img>',reason:'Ambiguous mapping'}],warnings:['One report did not contain commissions.']});return;
   }
   if(req.method!=='GET'){reply(405,{error:'Fixture refuses other writes'});return}
   if(path==='/api/library'){reply(200,saved);return}
   if(path==='/api/saved-snapshots'){reply(200,{connected:false,rows:snapshotRows});return}
   if(path==='/api/options-history'){
    readCount++;const data=structuredClone(ledger),code=error?503:200;
    const send=()=>reply(code,error?{error:'Offline fixture'}:data);
    if(hold){hold=false;release=()=>{if(!res.destroyed)send();release=null};return}
    send();return;
   }
   reply(404,{error:'Unexpected fixture route '+path});return;
  }
  const file=resolve(web,'.'+(path==='/'?'/index.html':path));
  if(!file.startsWith(web+sep)){res.writeHead(404).end();return}
  const mime={'.html':'text/html','.js':'text/javascript','.css':'text/css','.woff2':'font/woff2'}[extname(file)];
  res.writeHead(200,{'Content-Type':mime??'application/octet-stream','Cache-Control':'no-store'}).end(await readFile(file));
 }catch(e){if(!res.headersSent)res.writeHead(404);res.end()}
});
let browser;
try{
 for(const path of ['web/options-history.js','web/options-history.css','web/saved.js','web/app.js','web/index.html','scripts/verify-options-history.mjs'])
  report.files[path]=createHash('sha256').update(await readFile(join(project,path))).digest('hex');
 await new Promise(ok=>server.listen(0,'127.0.0.1',ok));
 browser=await testBrowser(tmp,waitFor);
 await browser.call('Page.navigate',{url:'http://127.0.0.1:'+server.address().port+'/#saved'});
 const ev=s=>browser.evalPage(s),str=JSON.stringify;
 const click=s=>ev('document.querySelector('+str(s)+').click()');
 const change=(id,value,type='change')=>ev('(()=>{const e=document.getElementById('+str(id)+');e.value='+str(value)+';e.dispatchEvent(new Event('+str(type)+',{bubbles:true}))})()');
 const visible=()=>ev('!document.getElementById("optionsHistoryPanel").hidden');
 const ids=()=>ev('[...document.querySelectorAll("#optionsHistoryTable tr[data-execution]")].map(r=>r.dataset.execution)');
 const text=id=>ev('document.getElementById('+str(id)+').textContent');
 const cells=id=>ev('[...document.querySelector('+str('[data-execution="'+id+'"]')+').cells].map(c=>c.innerText)');
 await waitFor(()=>ev('!document.getElementById("saved").hidden&&!!document.getElementById("library").textContent'),'Saved workspace');
 const dayCell=id=>ev('document.querySelector('+str('[data-trade-id="'+id+'"] [data-field="day"]')+').innerText');
 await waitFor(async()=>/Broker-verified/.test(await dayCell('broker-row')),'verified zero');
 assert.match(await dayCell('estimate-row'),/Current-position estimate/);assert.match(await dayCell('model-row'),/Saved-position model/);
 assert.doesNotMatch(await dayCell('pending-broker'),/Broker-verified/);assert.match(await dayCell('pending-broker'),/Loading/);
 await click('#library [data-manage="broker-row"]');await waitFor(()=>ev('document.getElementById("savedTradeDetails").open'),'verified trade overview');
 assert.match(await text('savedTradeDetails'),/Broker-verified session return/);await click('#savedTradeDetails [data-saved-action="close"]');
 passed('Verified zero, current-position estimate, saved-position model and unpriced broker results have distinct labels',{verified:await dayCell('broker-row'),estimate:await dayCell('estimate-row'),pending:await dayCell('pending-broker')});
 assert.equal(await visible(),false);assert.equal(readCount,0);
 await change('savedShow','all');assert.equal(await visible(),false);assert.equal(readCount,0);
 await change('savedShow','archived');
 const groupIds=()=>ev('[...document.querySelectorAll("#optionsHistoryTable tr[data-trade]")].map(r=>r.dataset.trade)');
 const tradeCells=id=>ev('[...document.querySelector('+str('tr[data-trade="'+id+'"]')+').cells].map(c=>c.innerText)');
 await waitFor(async()=>(await groupIds()).length===2,'closed trades grouped by broker activity');
 assert.deepEqual(await groupIds(),['closed-spread','short-unpriced']);assert.equal(await ev('document.getElementById("optionsHistoryTrades").getAttribute("aria-pressed")'),'true');
 const closed=await tradeCells('closed-spread');
 assert.match(closed[0],/SPX.*Bull call spread/s);assert.match(closed[1],/Oct 4, 2026/);assert.match(closed[2],/Nov 20, 2026/);
 assert.match(closed[0],/Dec 18, 2026/);assert.match(closed[0],/6,000\/6,010/);assert.equal(closed[4],'+$75.65');const missing=await tradeCells('short-unpriced');
 assert.equal(missing[1],'—');assert.match(missing[4],/Opening cost and commissions/);
 await click('[data-trade-toggle="closed-spread"]');
 assert.equal(await ev('(() => { const holder=document.getElementById("optionsHistoryTable"); return holder.clientWidth < 660 || holder.scrollWidth <= holder.clientWidth + 1 })()'),true,'An expanded spread keeps its net P&L visible beside the strategy');
 let details=await ev('document.querySelector(".history-group-detail").innerText');
 assert.match(details,/Option premium cash flows after allocated opening and closing commissions/);assert.match(details,/IBKR reported FIFO return · 72.40 USD/);assert.match(details,/Commissions on listed activity · 0.65 EUR · 1.20 USD/);assert.match(details,/IBKR combo order/);
 assert.match(details,/IBKR FIFO return/);assert.match(details,/85.05 USD/);assert.match(details,/broker-partial-open/);assert.match(details,/0.65 EUR/);assert.match(details,/broker-partial-close/);assert.match(details,/Opening/);
 assert.match(details,/SPX call 6,010/);assert.match(details,/Short/);assert.match(details,/-12.65 USD/);
 assert.doesNotMatch(details,/88\.301722|85\.052571/);
 assert.equal(await ev('document.querySelector(\'.history-group-detail td[title="88.301722 USD"]\').textContent'),'+88.30 USD');
 assert.equal(await ev('document.querySelector(\'.history-group-detail td[title="85.052571 USD"]\').textContent'),'+85.05 USD');
 ledger={...ledger,rows:[...rows,{...core,id:'transient-unused'}]};await click('#optionsHistoryRefresh');
 await waitFor(async()=>!await ev('document.getElementById("optionsHistoryRefresh").disabled'),'group refresh');
 assert.equal(await ev('document.querySelector('+str('[data-trade-toggle="closed-spread"]')+').getAttribute("aria-expanded")'),'true');
 await click('[data-trade-toggle="closed-spread"]');assert.equal(await ev('document.querySelectorAll(".history-group-detail").length'),0);
 await change('optionsHistoryTicker','spx','input');await change('optionsHistoryFrom','2026-11-20');await change('optionsHistoryTo','2026-11-20');
 assert.deepEqual(await groupIds(),['closed-spread']);
 await change('optionsHistoryFrom','2026-11-21');await change('optionsHistoryTo','2026-11-21');assert.deepEqual(await groupIds(),[]);
 assert.match(await text('optionsHistoryTable'),/No broker trades match/);
 await click('#optionsHistoryClear');await change('optionsHistoryTradeStatus','open');assert.deepEqual(await groupIds(),['open-spy']);
 await change('optionsHistoryTradeStatus','incomplete');assert.deepEqual(await groupIds(),['incomplete-qqq']);
 await change('optionsHistoryTradeStatus','closed');
 ledger={rows,trades:[open,incomplete],coverage,status:'ok'};await click('#optionsHistoryRefresh');
 await waitFor(async()=>/No trades have a confirmed close/.test(await text('optionsHistoryTable')),'incomplete history empty-state');
 ledger={rows,trades:Array.from({length:53},(_,i)=>({...spread,id:'group-page-'+i,closedAt:closedAt-i*1000})),coverage,status:'ok'};
 await click('#optionsHistoryRefresh');await waitFor(async()=>(await groupIds()).length===50,'grouped first page');await click('#optionsHistoryPages button:last-child');
 assert.deepEqual(await groupIds(),['group-page-50','group-page-51','group-page-52']);
 ledger={rows,trades:groups,coverage,status:'ok'};await click('#optionsHistoryRefresh');await waitFor(async()=>(await groupIds()).includes('closed-spread'),'restored group page');
 passed('Closed broker trades use actual close dates and realized P&L, including unavailable results, typed legs and allocated executions',
  {closed,unpriced:missing,brokerFifoSeparate:72.4,netEconomicReturn:75.65,feeCurrencyPreserved:'EUR',openingRolePreserved:true,confirmedClosedCount:2,groupedPages:2});
 await click('#optionsHistoryActivity');
 await waitFor(async()=>(await ids()).length===4,'expired and closed executions');
 assert.equal(await visible(),true);const archived=await ids();assert.deepEqual(new Set(archived),new Set(['partial-1','partial-2','ambiguous','future-option']));
 const first=await cells('partial-1'),second=await cells('partial-2'),ambiguous=await cells('ambiguous'),futures=await cells('future-option');
 assert.equal(first[2],'Buy');assert.equal(first[3],'+2');assert.equal(first[4],'10.125 USD');assert.equal(first[5],'0.41 EUR');
 assert.equal(await ev('document.querySelector(\'[data-execution="partial-1"] td[title="0.4135 EUR"]\').textContent'),'0.41 EUR');
 assert.equal(second[2],'Sell');assert.equal(second[3],'−1');assert.equal(second[5],'—');assert.equal(second[7],'Unmatched');
 assert.equal(ambiguous[5],'0.00 USD');assert.match(ambiguous[7],/Ambiguous \(2\)/);assert.match(futures[1],/Futures option/);assert.equal(futures[3],'−3');
 assert.match(await text('optionsHistoryCoverage'),/Partial or unconfirmed coverage/);assert.match(await text('optionsHistoryCoverage'),/Nov 16, 2026.*Nov 22, 2026/);
 assert.match(await text('optionsHistoryMatchNote'),/same option contract/);
 assert.equal(await ev('document.querySelectorAll("#optionsHistoryTable img").length'),0);
 await click('[data-execution="ambiguous"] summary');assert.match((await cells('ambiguous'))[7],/Second same-contract trade/);
 await click('[data-execution="partial-1"] [data-history-open]');
 await waitFor(()=>ev('document.getElementById("archiveTrade").open'),'actual local archived trade');
 await ev('document.getElementById("archiveTrade").close()');
 passed('Expired or Closed contains actual option fills, signed size, original currencies, separate partial executions and same-contract match links',{archived,first,second,ambiguous,futures,coverage:await text('optionsHistoryCoverage')});
 await change('optionsHistoryContract','all');assert.equal((await ids()).length,6);
 assert.ok((await ids()).includes('open-contract'));assert.ok((await ids()).includes('unknown-contract'));
 await change('optionsHistoryTicker','spx','input');await change('optionsHistoryFrom','2026-11-20');await change('optionsHistoryTo','2026-11-20');
 assert.deepEqual(new Set(await ids()),new Set(['partial-1','partial-2','open-contract']));
 assert.match((await cells('partial-1'))[0],/Nov 20, 2026/);
 await change('optionsHistoryFrom','2026-11-22');assert.deepEqual(await ids(),[]);assert.match(await text('optionsHistoryTable'),/end date/);
 await click('#optionsHistoryClear');assert.equal((await ids()).length,6);
 await change('optionsHistoryTicker','doesnotexist','input');assert.deepEqual(await ids(),[]);assert.match(await text('optionsHistoryTable'),/match these filters/);
 await click('#optionsHistoryClear');
 passed('All option statuses, case-insensitive tickers, Eastern midnight boundaries, empty searches and invalid date ranges are explicit',{allCount:6,easternDate:first[0]});
 error=true;await click('#optionsHistoryRefresh');await waitFor(async()=>/Refresh failed/.test(await text('optionsHistoryStatus')),'visible read failure');
 assert.equal((await ids()).length,6);error=false;
 ledger={rows:[{...core,id:'booked-expiry',eventType:'expiration',side:'BUY',qty:1,price:0,commission:0,commissionCurrency:'USD',positionStatus:'unknown'},
  {...core,id:'booked-assignment',eventType:'assignment',price:null,commission:null},{...core,id:'booked-exercise',eventType:'exercise',price:0.75},
  {...core,id:'normal-execution'}],coverage,status:'ok'};
 await change('optionsHistoryContract','archived');await click('#optionsHistoryRefresh');
 await waitFor(async()=>(await ids()).includes('booked-expiry'),'booked lifecycle under Expired or Closed');
 const expiry=await cells('booked-expiry'),assignment=await cells('booked-assignment'),exercise=await cells('booked-exercise');
 assert.equal(expiry[2],'Expired');assert.equal(expiry[3],'+1');assert.equal(expiry[4],'0.00 USD');assert.equal(expiry[5],'0.00 USD');
 assert.equal(assignment[2],'Assigned');assert.equal(assignment[4],'—');assert.equal(assignment[5],'—');assert.equal(exercise[2],'Exercised');
 assert.match(await text('optionsHistoryStatus'),/1 execution · 3 lifecycle events/);
 passed('Lifecycle bookings have separate actions, actual signed units and reported prices',{expiry,assignment,exercise});
 await change('optionsHistoryContract','all');
 ledger={rows:[],refreshing:true,coverage,status:'ok'};
 await click('#optionsHistoryRefresh');await waitFor(async()=>/retrieving recent option executions/.test(await text('optionsHistoryTable')),'background broker refresh');
 assert.doesNotMatch(await text('optionsHistoryTable'),/No option executions were reported/);
 ledger={rows:[{...core,id:'arrived-during-refresh'}],refreshing:false,coverage,status:'ok'};
 await waitFor(async()=>(await ids())[0]==='arrived-during-refresh','automatic refresh completion',7500);
 passed('An unfinished broker response resolves automatically to the first execution',{finishedWithoutUserInput:true});
 ledger={rows:[],coverage:{...coverage,complete:true,message:'Fixture complete only for the dates shown.'},status:'ok'};
 await click('#optionsHistoryRefresh');await waitFor(async()=>/No option executions were reported/.test(await text('optionsHistoryTable')),'confirmed empty response');
 assert.match(await text('optionsHistoryCoverage'),/Complete for reported range/);
 ledger={rows:[],coverage:{...coverage,from:null,to:null,complete:false,message:'Ledger source unavailable.'},status:'unavailable'};
 await click('#optionsHistoryRefresh');await waitFor(async()=>/Broker execution history is unavailable/.test(await text('optionsHistoryStatus')),'unavailable history');
 assert.match(await text('optionsHistoryCoverage'),/Date range unconfirmed/);
 passed('Refresh failures retain last data, while broker-empty and unavailable coverage have distinct states',{retainedCount:6,unavailable:await text('optionsHistoryStatus')});
 ledger={rows:Array.from({length:53},(_,i)=>({...core,id:'page-'+i,at:clock-i*1000})),coverage,status:'ok'};
 await click('#optionsHistoryRefresh');await waitFor(async()=>(await ids()).length===50,'first execution page');
 await click('#optionsHistoryPages button:last-child');assert.deepEqual(await ids(),['page-50','page-51','page-52']);
 await click('#optionsHistoryPages button:first-child');assert.equal((await ids()).length,50);
 hold=true;await click('#optionsHistoryRefresh');await waitFor(()=>release,'outgoing in-flight response');
 await change('savedShow','active');assert.equal(await visible(),false);
 ledger={rows:[{...core,id:'new-visit'}],coverage,status:'ok'};
 await change('savedShow','archived');await waitFor(async()=>(await ids())[0]==='new-visit','fresh visit');
 release();await delay(100);assert.deepEqual(await ids(),['new-visit']);
 assert.ok(requests.every(([method])=>method==='GET'));
 passed('All pages remain reachable and an earlier response cannot overwrite a reopened section',{pages:2,lastPage:['page-50','page-51','page-52'],final:await ids(),reads:readCount,writes:0});
 ledger={rows:[{...core,id:'old-account'}],trades:groups,accountVerified:false,status:'unavailable',coverage:{...coverage,from:null,to:null}};
 await click('#optionsHistoryRefresh');await waitFor(async()=>/account scope is unverified/.test(await text('optionsHistoryStatus')),'account switch');
 assert.deepEqual(await ids(),[]);
 await click('#optionsHistoryTrades');assert.deepEqual(await groupIds(),[]);await click('#optionsHistoryActivity');
 passed('An explicitly unverified broker account scope clears prior rows',{remainingRows:0});
 const xmlA='<FlexQueryResponse><FlexStatements><FlexStatement fromDate="20261119"/></FlexStatements></FlexQueryResponse>';
 const xmlB='<FlexQueryResponse><FlexStatements><FlexStatement fromDate="20261120"/></FlexStatements></FlexQueryResponse>';
 const paths=[join(tmp,'prior.xml'),join(tmp,'current.xml'),join(tmp,'invalid.xml')];
 await Promise.all(paths.map((path,i)=>writeFile(path,[xmlA,xmlB,'<invalid/>'][i])));
 await browser.call('DOM.enable');
 async function choose(paths){
  const root=(await browser.call('DOM.getDocument')).root.nodeId;
  const input=(await browser.call('DOM.querySelector',{nodeId:root,selector:'#optionsFlexFiles'})).nodeId;
  await browser.call('DOM.setFileInputFiles',{nodeId:input,files:paths});
 }
 await click('#optionsFlexOpen');await choose(paths.slice(0,2));await click('#optionsFlexCancel');assert.equal(submitted.length,0);
 await click('#optionsFlexOpen');await choose(paths.slice(0,2));await change('optionsFlexZone','America/Chicago');
 await click('#optionsFlexVerify');await change('optionsFlexDate','2026-11-20');
 await click('#optionsFlexSubmit');await delay(100);assert.equal(submitted.length,0,'Incomplete coverage confirmation');
 await click('#optionsFlexUnfiltered');await click('#optionsFlexSubmit');
 await waitFor(async()=>(await ids())[0]==='flex-fill','import refresh');
 assert.deepEqual(submitted[0],{xml:[xmlA,xmlB],timezone:'America/Chicago',verifySaved:'2026-11-20',confirmUnfiltered:true});
 assert.match(await text('optionsFlexResult'),/2 statements.*1 execution.*1 account.*1 broker-verified saved strateg/);
 assert.match(await text('optionsFlexResult'),/Ambiguous mapping/);assert.equal(await ev('document.querySelectorAll("#optionsFlexResult img").length'),0);
 const imported=await text('optionsFlexResult');
 await click('#optionsFlexOpen');await choose([paths[2]]);await click('#optionsFlexSubmit');
 await waitFor(async()=>/Choose an IBKR Activity Flex/.test(await text('optionsFlexError')),'native parser error');
 assert.equal(await ev('document.getElementById("optionsFlexDialog").open'),true);
 assert.equal(submitted[1].verifySaved,null);assert.equal(submitted[1].confirmUnfiltered,false);
 redirectImport=true;await choose([paths[0]]);await click('#optionsFlexSubmit');
 await waitFor(async()=>submitted.length===3&&!await ev('document.getElementById("optionsFlexSubmit").disabled'),'redirect refusal');
 assert.equal(requests.some(([,path])=>path==='/api/not-the-importer'),false);
 await click('#optionsFlexCancel');
 assert.ok(requests.every(([method,path])=>method==='GET'||method==='POST'&&path==='/api/ibkr-flex'));
 passed('Native multi-file picker sends only confirmed inputs to the loopback parser, rejects redirects and displays import outcomes',{submittedReports:submitted[0].xml.length,
  timezone:submitted[0].timezone,verifiedDate:submitted[0].verifySaved,confirmation:submitted[0].confirmUnfiltered,result:imported,
  cancelWrites:0,redirectedWrites:0,refreshRows:await ids()});
 report.passed=true;
}catch(e){report.passed=false;report.error=e.stack;console.error(e.stack);process.exitCode=1}
finally{
 release?.();await browser?.close();server.closeAllConnections();
 if(server.listening)await new Promise(resolve=>server.close(resolve));
 await rm(tmp,{recursive:true,force:true,maxRetries:5,retryDelay:100});
 if(out)await writeFile(out,JSON.stringify(report,null,2)+'\n');else console.log(JSON.stringify(report,null,2));
}
